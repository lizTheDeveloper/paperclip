import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  agentEmails,
  agentMatrixMessages,
  agentPendingNotifications,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  and,
  companies,
  asc,
  costEvents,
  desc,
  eq,
  gt,
  heartbeatRunEvents,
  heartbeatRuns,
  inArray,
  isNull,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
  sql,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
// projectService import removed — compact context collapsing queries projects table directly
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return true;

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  return wakeSource === "on_demand" && wakeTriggerDetail === "manual";
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return "wake source is timer";

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  if (wakeSource === "on_demand" && wakeTriggerDetail === "manual") {
    return "this is a manual invoke";
  }
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const issueProjectId = issueId
      ? await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0]?.projectId ?? null)
      : null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const projectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      for (const workspace of projectWorkspaceRows) {
        const projectCwd = readNonEmptyString(workspace.cwd);
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          continue;
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [],
          };
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: event.message,
      payload: event.payload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: event.message ?? null,
        payload: event.payload ?? null,
      },
    });
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    const rawRoleProfile = typeof heartbeat.roleProfile === "string" ? heartbeat.roleProfile.trim().toLowerCase() : null;
    const roleProfile: "ic" | "pm" | "ceo" =
      rawRoleProfile === "pm" ? "pm" : rawRoleProfile === "ceo" ? "ceo" : "ic";

    const rawOnIdleBehavior = typeof heartbeat.onIdleBehavior === "string" ? heartbeat.onIdleBehavior.trim().toLowerCase() : null;
    const onIdleBehavior: "exit" | "ask_pm" | "continuous_improvement" | "custom_prompt" =
      rawOnIdleBehavior === "ask_pm" ? "ask_pm"
      : rawOnIdleBehavior === "continuous_improvement" ? "continuous_improvement"
      : rawOnIdleBehavior === "custom_prompt" ? "custom_prompt"
      : "exit";

    const idleCustomPrompt = typeof heartbeat.idleCustomPrompt === "string" && heartbeat.idleCustomPrompt.trim().length > 0
      ? heartbeat.idleCustomPrompt.trim()
      : null;

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      roleProfile,
      onIdleBehavior,
      idleCustomPrompt,
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function countRunningRunsForCompany(companyId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs in "queued" or "running" state
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));

    const reaped: string[] = [];

    for (const run of activeRuns) {
      if (runningProcesses.has(run.id)) continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      await setRunStatus(run.id, "failed", {
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: "Process lost -- server may have restarted",
      });
      const updatedRun = await getRun(run.id);
      if (updatedRun) {
        await appendRunEvent(updatedRun, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: "Process lost -- server may have restarted",
        });
        await releaseIssueExecutionAndPromote(updatedRun);
      }
      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);

      // Immediately re-enqueue so the agent retries without waiting for the next timer tick.
      // Use "timer" source so the retry works even when wakeOnDemand is disabled.
      const retryContext: Record<string, unknown> = {
        ...(run.contextSnapshot ?? {}),
        wakeReason: "process_lost_retry",
      };
      await enqueueWakeup(run.agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "process_lost_retry",
        contextSnapshot: retryContext,
        requestedByActorType: "system",
        requestedByActorId: "reaper",
      }).catch((err) => {
        logger.warn({ err, agentId: run.agentId }, "failed to enqueue immediate retry after process loss");
      });
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
  ) {
    await ensureRuntimeState(agent);
    const usage = result.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const additionalCostCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      await db.insert(costEvents).values({
        companyId: agent.companyId,
        agentId: agent.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        inputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }

    if (additionalCostCents > 0) {
      await db
        .update(agents)
        .set({
          spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${additionalCostCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];

      // Enforce company-level pause and concurrency limit
      const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
      if (company?.status === "paused") return [];
      if (company && company.maxConcurrentAgents > 0) {
        const companyRunning = await countRunningRunsForCompany(company.id);
        if (companyRunning >= company.maxConcurrentAgents) return [];
      }

      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const policy = parseHeartbeatPolicy(agent);

    // Inject compact assignment queue so agents skip the list-issues API call
    const agentAssignments = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        title: issues.title,
        projectId: issues.projectId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          inArray(issues.status, ["todo", "in_progress", "blocked"]),
        ),
      );
    // Tier 1: Compact assignment summary instead of full JSON blob
    const statusCounts: Record<string, number> = {};
    const inProgressItems: string[] = [];
    for (const a of agentAssignments) {
      statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
      if (a.status === "in_progress") {
        inProgressItems.push(`${a.identifier ?? "?"}: ${a.title}`);
      }
    }
    const statusParts = Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`);
    const summaryLine = agentAssignments.length === 0
      ? "No assignments"
      : `${agentAssignments.length} tasks: ${statusParts.join(", ")}`;
    const inProgressDetail = inProgressItems.length > 0
      ? `\nIn progress: ${inProgressItems.join("; ")}`
      : "";
    context.assignmentsSummary = summaryLine + inProgressDetail;
    // Keep assignmentsJson as compact list (identifier + status only) for template rendering
    context.assignmentsJson = JSON.stringify(
      agentAssignments.map((a) => ({ identifier: a.identifier, title: a.title, status: a.status })),
    );
    context.agentRole = agent.role ?? "general";
    context.heartbeatRoleProfile = policy.roleProfile;
    context.onIdleBehavior = policy.onIdleBehavior;

    // Structured wake context enrichment: detail, human-readable issue info, triggeredBy
    const wakeReason = readNonEmptyString(context.wakeReason as string | undefined);
    const wakeIssueId = readNonEmptyString(context.issueId as string | undefined);
    if (wakeIssueId) {
      const wakeIssueRow = agentAssignments.find((a) => a.id === wakeIssueId);
      if (wakeIssueRow) {
        context.wakeIssueIdentifier = wakeIssueRow.identifier ?? null;
        context.wakeIssueTitle = wakeIssueRow.title ?? null;
      }
    }
    // Derive detail sub-reason from wake reason
    if (wakeReason === "issue_assigned" || wakeReason === "assignment") {
      context.wakeDetail = "new_assignment";
    } else if (wakeReason === "issue_reassigned") {
      context.wakeDetail = "reassignment";
    } else if (wakeReason === "issue_priority_changed") {
      context.wakeDetail = "priority_change";
    } else if (wakeReason === "issue_status_changed" || wakeReason === "issue_reopened_via_comment") {
      context.wakeDetail = "status_change";
    } else if (wakeReason === "issue_unblocked") {
      context.wakeDetail = "unblocked";
    } else if (wakeReason === "issue_comment_mentioned" || wakeReason === "issue_commented") {
      context.wakeDetail = "comment";
    }
    // triggeredBy: who caused this wakeup
    const actorType = readNonEmptyString(context.requestedByActorType as string | undefined);
    const actorId = readNonEmptyString(context.requestedByActorId as string | undefined);
    if (actorType === "user") {
      context.wakeTriggeredBy = "board";
    } else if (actorType === "agent" && actorId) {
      context.wakeTriggeredBy = `agent:${actorId}`;
    } else {
      context.wakeTriggeredBy = "system";
    }
    if (policy.idleCustomPrompt) {
      context.idleCustomPrompt = policy.idleCustomPrompt;
    }
    // For ask_pm mode: resolve the reporting manager so the agent can delegate upward
    if (policy.onIdleBehavior === "ask_pm" && agent.reportsTo) {
      const manager = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, agent.reportsTo), eq(agents.companyId, agent.companyId)))
        .then((rows) => rows[0] ?? null);
      if (manager) {
        context.pmAgentId = manager.id;
        context.pmAgentName = manager.name ?? null;
      }
    }

    // Consume pending notifications (batched comment @-mentions, etc.)
    // and inject them into the context so the agent sees them at heartbeat start.
    try {
      const pendingRows = await db
        .select({
          id: agentPendingNotifications.id,
          type: agentPendingNotifications.type,
          issueId: agentPendingNotifications.issueId,
          commentId: agentPendingNotifications.commentId,
          payload: agentPendingNotifications.payload,
          createdAt: agentPendingNotifications.createdAt,
        })
        .from(agentPendingNotifications)
        .where(
          and(
            eq(agentPendingNotifications.agentId, agent.id),
            isNull(agentPendingNotifications.consumedAt),
          ),
        )
        .orderBy(asc(agentPendingNotifications.createdAt))
        .limit(50);

      if (pendingRows.length > 0) {
        context.pendingNotifications = JSON.stringify(
          pendingRows.map((n) => ({
            type: n.type,
            issueId: n.issueId,
            commentId: n.commentId ?? null,
            excerpt: (n.payload as Record<string, unknown>)?.excerpt ?? null,
            createdAt: n.createdAt,
          })),
        );
        // Mark as consumed
        const notifIds = pendingRows.map((n) => n.id);
        await db
          .update(agentPendingNotifications)
          .set({ consumedAt: new Date() })
          .where(inArray(agentPendingNotifications.id, notifIds));
      }
    } catch (err) {
      logger.warn({ err, agentId: agent.id }, "failed to consume pending notifications; continuing");
    }

    // Tier 1: Compact email summary — agents call GET /api/agents/{id}/emails for full details
    try {
      const EXCERPT_LEN = 200;
      const unreadEmails = await db
        .select({
          id: agentEmails.id,
          from: agentEmails.from,
          subject: agentEmails.subject,
          bodyText: agentEmails.bodyText,
          receivedAt: agentEmails.receivedAt,
        })
        .from(agentEmails)
        .where(
          and(
            eq(agentEmails.agentId, agent.id),
            isNull(agentEmails.readAt),
          ),
        )
        .orderBy(desc(agentEmails.receivedAt))
        .limit(5);

      if (unreadEmails.length > 0) {
        // Count total unread (may be more than 5)
        const totalUnread = await db
          .select({ count: sql<number>`count(*)` })
          .from(agentEmails)
          .where(and(eq(agentEmails.agentId, agent.id), isNull(agentEmails.readAt)))
          .then((rows) => Number(rows[0]?.count ?? 0));

        context.recentEmails = JSON.stringify(
          unreadEmails.map((e) => ({
            id: e.id,
            from: e.from,
            subject: e.subject,
            excerpt: e.bodyText.slice(0, EXCERPT_LEN) + (e.bodyText.length > EXCERPT_LEN ? "..." : ""),
            receivedAt: e.receivedAt,
          })),
        );
        context.emailCount = JSON.stringify({ unread: totalUnread });
      }
    } catch (err) {
      logger.warn({ err, agentId: agent.id }, "failed to inject email context; continuing");
    }

    // Tier 1: Compact Matrix message summary — agents call GET /api/agents/{id}/matrix-messages for full details
    try {
      const unreadMatrix = await db
        .select({
          id: agentMatrixMessages.id,
          roomName: agentMatrixMessages.roomName,
          roomType: agentMatrixMessages.roomType,
          senderDisplayName: agentMatrixMessages.senderDisplayName,
          body: agentMatrixMessages.body,
          receivedAt: agentMatrixMessages.receivedAt,
        })
        .from(agentMatrixMessages)
        .where(
          and(
            eq(agentMatrixMessages.agentId, agent.id),
            isNull(agentMatrixMessages.readAt),
          ),
        )
        .orderBy(desc(agentMatrixMessages.receivedAt))
        .limit(10);

      if (unreadMatrix.length > 0) {
        // Group by room for compact display
        const byRoom = new Map<string, { roomType: string; messages: { from: string; excerpt: string; receivedAt: Date }[] }>();
        for (const m of unreadMatrix) {
          if (!byRoom.has(m.roomName)) {
            byRoom.set(m.roomName, { roomType: m.roomType, messages: [] });
          }
          byRoom.get(m.roomName)!.messages.push({
            from: m.senderDisplayName,
            excerpt: m.body.slice(0, 150) + (m.body.length > 150 ? "..." : ""),
            receivedAt: m.receivedAt,
          });
        }

        const totalUnread = await db
          .select({ count: sql<number>`count(*)` })
          .from(agentMatrixMessages)
          .where(and(eq(agentMatrixMessages.agentId, agent.id), isNull(agentMatrixMessages.readAt)))
          .then((rows) => Number(rows[0]?.count ?? 0));

        context.recentMatrixMessages = JSON.stringify(
          Array.from(byRoom.entries()).map(([roomName, data]) => ({
            roomName,
            roomType: data.roomType,
            messages: data.messages,
          })),
        );
        context.matrixCount = JSON.stringify({ unread: totalUnread, rooms: byRoom.size });
      }
    } catch (err) {
      logger.warn({ err, agentId: agent.id }, "failed to inject matrix context; continuing");
    }

    // Tier 2: Compact task summary instead of full task JSON blob.
    // Full task details (description, comments, project) available via GET /api/issues/{id}.
    const wakeTaskIdForFetch =
      readNonEmptyString(context.taskId as string | undefined) ??
      readNonEmptyString(context.issueId as string | undefined);
    if (wakeTaskIdForFetch) {
      try {
        const taskRow = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            parentId: issues.parentId,
            projectId: issues.projectId,
          })
          .from(issues)
          .where(and(eq(issues.id, wakeTaskIdForFetch), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (taskRow) {
          // Count comments instead of fetching full bodies
          const commentCountResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(issueComments)
            .where(and(eq(issueComments.issueId, wakeTaskIdForFetch), eq(issueComments.companyId, agent.companyId)))
            .then((rows) => rows[0]?.count ?? 0);

          // Fetch only the most recent comment for excerpt
          const lastComment = await db
            .select({ body: issueComments.body, authorAgentId: issueComments.authorAgentId, authorUserId: issueComments.authorUserId })
            .from(issueComments)
            .where(and(eq(issueComments.issueId, wakeTaskIdForFetch), eq(issueComments.companyId, agent.companyId)))
            .orderBy(desc(issueComments.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          // Walk parent chain for compact ancestor breadcrumb (identifier + title only)
          const ancestorBreadcrumb: string[] = [];
          const visited = new Set<string>([taskRow.id]);
          let currentParentId = taskRow.parentId ?? null;
          while (currentParentId && !visited.has(currentParentId) && ancestorBreadcrumb.length < 3) {
            visited.add(currentParentId);
            const parent = await db
              .select({ id: issues.id, identifier: issues.identifier, title: issues.title, parentId: issues.parentId })
              .from(issues)
              .where(eq(issues.id, currentParentId))
              .then((rows) => rows[0] ?? null);
            if (!parent) break;
            ancestorBreadcrumb.push(`${parent.identifier ?? "?"}: ${parent.title}`);
            currentParentId = parent.parentId ?? null;
          }

          // Fetch project name (not full project with workspaces)
          let projectName: string | null = null;
          if (taskRow.projectId) {
            projectName = await db
              .select({ name: projects.name })
              .from(projects)
              .where(eq(projects.id, taskRow.projectId))
              .then((rows) => rows[0]?.name ?? null);
          }

          const EXCERPT_MAX = 150;
          const SECRET_PATTERN = /(?:api[_-]?key|password|secret|token|auth)[^\s]*\s*[:=]\s*\S+/gi;
          const sanitize = (s: string) => s.replace(SECRET_PATTERN, "[redacted]");

          const lastCommentExcerpt = lastComment
            ? sanitize(lastComment.body.slice(0, EXCERPT_MAX)) + (lastComment.body.length > EXCERPT_MAX ? "..." : "")
            : null;
          const lastCommentAuthor = lastComment
            ? (lastComment.authorUserId ? "board" : lastComment.authorAgentId ? `agent:${lastComment.authorAgentId}` : "unknown")
            : null;

          // Compact Tier 2 task summary — agents call GET /api/issues/{id} for full details
          const taskSummary = {
            identifier: taskRow.identifier ?? null,
            title: taskRow.title,
            status: taskRow.status,
            priority: taskRow.priority,
            project: projectName,
            parentChain: ancestorBreadcrumb.length > 0 ? ancestorBreadcrumb.join(" > ") : null,
            commentCount: Number(commentCountResult),
            lastCommentExcerpt,
            lastCommentAuthor,
          };
          context.taskJson = JSON.stringify(taskSummary);
        }
      } catch (err) {
        logger.warn({ err, taskId: wakeTaskIdForFetch }, "failed to pre-fetch task summary; continuing without it");
        context.taskJson = null;
      }
    }

    // Tier 2: Compact team summary for PM/CEO (one-line instead of full JSON array)
    if (policy.roleProfile === "pm" || policy.roleProfile === "ceo") {
      try {
        const teamMembers = await db
          .select({
            name: agents.name,
            status: agents.status,
          })
          .from(agents)
          .where(and(eq(agents.companyId, agent.companyId), eq(agents.reportsTo, agent.id)));
        if (teamMembers.length > 0) {
          const teamStatusCounts: Record<string, number> = {};
          const blockedNames: string[] = [];
          for (const m of teamMembers) {
            const s = m.status ?? "unknown";
            teamStatusCounts[s] = (teamStatusCounts[s] ?? 0) + 1;
            if (s === "blocked") blockedNames.push(m.name ?? "?");
          }
          const teamParts = Object.entries(teamStatusCounts).map(([s, c]) => `${c} ${s}`);
          const blockedDetail = blockedNames.length > 0 ? ` (blocked: ${blockedNames.join(", ")})` : "";
          context.teamSummary = `${teamMembers.length} reports: ${teamParts.join(", ")}${blockedDetail}`;
        }
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "failed to build team summary; continuing without it");
      }
    }

    // Tier 3: PM/CEO expanded context — in-progress details, project dashboard, backlog summary
    if (policy.roleProfile === "pm" || policy.roleProfile === "ceo") {
      try {
        const DETAIL_SECRET_PATTERN = /(?:api[_-]?key|password|secret|token|auth)[^\s]*\s*[:=]\s*\S+/gi;
        const sanitizeDetail = (s: string) => s.replace(DETAIL_SECRET_PATTERN, "[redacted]");

        // 1. In-progress issue details with descriptions and recent comments
        const inProgressIds = agentAssignments
          .filter((a) => a.status === "in_progress")
          .slice(0, 10)
          .map((a) => a.id);

        if (inProgressIds.length > 0) {
          const inProgressDescriptions = await db
            .select({ id: issues.id, description: issues.description })
            .from(issues)
            .where(inArray(issues.id, inProgressIds));

          const descriptionMap = new Map(inProgressDescriptions.map((r) => [r.id, r.description]));

          const inProgressDetails = await Promise.all(
            agentAssignments
              .filter((a) => a.status === "in_progress")
              .slice(0, 10)
              .map(async (a) => {
                const rawDesc = descriptionMap.get(a.id) ?? null;
                const description = rawDesc ? sanitizeDetail(rawDesc.slice(0, 500)) + (rawDesc.length > 500 ? "..." : "") : null;

                const comments = await db
                  .select({
                    body: issueComments.body,
                    authorUserId: issueComments.authorUserId,
                    authorAgentId: issueComments.authorAgentId,
                    createdAt: issueComments.createdAt,
                  })
                  .from(issueComments)
                  .where(eq(issueComments.issueId, a.id))
                  .orderBy(desc(issueComments.createdAt))
                  .limit(3);

                const recentComments = comments.map((c) => ({
                  author: c.authorUserId ? "board" : c.authorAgentId ? `agent:${c.authorAgentId}` : "unknown",
                  excerpt: sanitizeDetail(c.body.slice(0, 200)) + (c.body.length > 200 ? "..." : ""),
                  createdAt: c.createdAt,
                }));

                return { identifier: a.identifier, title: a.title, description, recentComments };
              })
          );

          context.inProgressDetails = JSON.stringify(inProgressDetails);
        }

        // 2. Project dashboard summary
        const uniqueProjectIds = [...new Set(agentAssignments.map((a) => a.projectId).filter(Boolean) as string[])].slice(0, 5);

        if (uniqueProjectIds.length > 0) {
          const projectRows = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, uniqueProjectIds));

          const projectNameMap = new Map(projectRows.map((p) => [p.id, p.name]));

          const dashboardProjects = await Promise.all(
            uniqueProjectIds.map(async (projectId) => {
              const statusRows = await db
                .select({ status: issues.status, count: sql<number>`count(*)` })
                .from(issues)
                .where(eq(issues.projectId, projectId))
                .groupBy(issues.status);

              const statusCounts: Record<string, number> = {};
              for (const row of statusRows) {
                statusCounts[row.status ?? "unknown"] = Number(row.count);
              }

              const staleRows = await db
                .select({ count: sql<number>`count(*)` })
                .from(issues)
                .where(
                  and(
                    eq(issues.projectId, projectId),
                    sql`${issues.status} IN ('todo', 'in_progress')`,
                    sql`${issues.updatedAt} < NOW() - INTERVAL '7 days'`
                  )
                );

              return {
                projectId,
                name: projectNameMap.get(projectId) ?? null,
                statusCounts,
                staleCount: Number(staleRows[0]?.count ?? 0),
              };
            })
          );

          context.projectDashboard = JSON.stringify({ projects: dashboardProjects });
        }

        // 3. Backlog summary
        const backlogProjectIds = [...new Set(agentAssignments.map((a) => a.projectId).filter(Boolean) as string[])].slice(0, 5);

        if (backlogProjectIds.length > 0) {
          const unassignedRows = await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                inArray(issues.projectId, backlogProjectIds),
                isNull(issues.assigneeAgentId),
                isNull(issues.assigneeUserId),
                sql`${issues.status} IN ('todo', 'backlog')`
              )
            );

          const blockedIssueRows = await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
            })
            .from(issues)
            .where(
              and(
                inArray(issues.projectId, backlogProjectIds),
                sql`${issues.status} = 'blocked'`
              )
            )
            .limit(10);

          const blockedIssues = await Promise.all(
            blockedIssueRows.map(async (issue) => {
              const lastComment = await db
                .select({ body: issueComments.body })
                .from(issueComments)
                .where(eq(issueComments.issueId, issue.id))
                .orderBy(desc(issueComments.createdAt))
                .limit(1)
                .then((rows) => rows[0] ?? null);

              const lastBlockerExcerpt = lastComment
                ? sanitizeDetail(lastComment.body.slice(0, 150)) + (lastComment.body.length > 150 ? "..." : "")
                : null;

              return { identifier: issue.identifier, title: issue.title, lastBlockerExcerpt };
            })
          );

          context.backlogSummary = JSON.stringify({
            unassignedCount: unassignedRows.length,
            blockedIssues,
          });
        }
      } catch (err) {
        logger.warn({ err, agentId: agent.id }, "failed to build PM expanded context; continuing without it");
      }

      // Inject specs directory path for PM agents
      context.projectSpecsDir = "docs/specs/";
    }

    // Tier 3: Dashboard data removed from context injection — available via API.
    // CEO/PM agents can call reporting endpoints for full dashboard data.

    // Lightweight pre-check: skip the heartbeat entirely if there is no work
    // and no event-based wake trigger. This avoids spinning up an expensive
    // LLM session just to discover there is nothing to do.
    // PM and CEO profiles are not skipped on empty inbox — they may have team
    // coordination or dashboard review work to do even without direct assignments.
    // IC agents with a non-exit onIdleBehavior are also allowed through so they
    // can act on their configured idle mode (ask_pm, continuous_improvement, custom_prompt).
    const hasAssignments = agentAssignments.length > 0;
    const hasWakeTrigger =
      !!readNonEmptyString(context.taskId as string | undefined) ||
      !!readNonEmptyString(context.issueId as string | undefined) ||
      !!readNonEmptyString(context.wakeCommentId as string | undefined) ||
      !!readNonEmptyString(context.commentId as string | undefined) ||
      !!readNonEmptyString(context.approvalId as string | undefined);
    const hasIdleAction = policy.roleProfile === "ic" && policy.onIdleBehavior !== "exit";
    const skipOnEmptyInbox = policy.roleProfile === "ic" && !hasIdleAction;
    if (skipOnEmptyInbox && !hasAssignments && !hasWakeTrigger) {
      logger.info(
        {
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
        },
        "pre-check: no assignments and no wake trigger — skipping heartbeat",
      );
      await appendRunEvent(run, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "skipped: no assignments and no wake trigger",
      });
      await setRunStatus(run.id, "skipped", {
        finishedAt: new Date(),
        error: null,
        errorCode: null,
      });
      await setWakeupStatus(run.wakeupRequestId, "completed", {
        finishedAt: new Date(),
      });
      const skippedRun = await getRun(run.id);
      if (skippedRun) await releaseIssueExecutionAndPromote(skippedRun);
      await finalizeAgentStatus(agent.id, "succeeded");
      await startNextQueuedRunForAgent(agent.id);
      return;
    }

    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueAssigneeConfig = issueId
      ? await db
          .select({
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueAssigneeConfig && issueAssigneeConfig.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueAssigneeConfig.assigneeAdapterOverrides,
          )
        : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null },
    );
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace,
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    if (resolvedWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = resolvedWorkspace.projectId;
    }
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    const previousSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    const runtimeForAdapter = {
      sessionId: readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback,
      sessionParams: runtimeSessionParams,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";

    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, chunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, chunk);

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk,
            ts: new Date().toISOString(),
          });
        }

        const payloadChunk =
          chunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? chunk.slice(chunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : chunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== chunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        await onLog("stderr", `[paperclip] ${warning}\n`);
      }

      const config = parseObject(agent.adapterConfig);
      const mergedConfig = issueAssigneeOverrides?.adapterConfig
        ? { ...config, ...issueAssigneeOverrides.adapterConfig }
        : config;
      const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        mergedConfig,
      );
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: resolvedConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        authToken: authToken ?? undefined,
      });
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        adapterResult.usage || adapterResult.costUsd != null
          ? ({
              ...(adapterResult.usage ?? {}),
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              ...(adapterResult.billingType ? { billingType: adapterResult.billingType } : {}),
            } as Record<string, unknown>)
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown adapter failure";
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
    } finally {
      await startNextQueuedRunForAgent(agent.id);
    }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    // Check if the company is paused
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
    if (company?.status === "paused") {
      throw conflict("Company is paused", { companyStatus: company.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    const writeSkippedRequest = async (reason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    // Enforce company-level max concurrent agents
    if (company && company.maxConcurrentAgents > 0) {
      const companyRunning = await countRunningRunsForCompany(company.id);
      if (companyRunning >= company.maxConcurrentAgents) {
        await writeSkippedRequest("company.maxConcurrentAgents.reached");
        return null;
      }
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  return {
    list: (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select()
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (limit) {
        return query.limit(limit);
      }
      return query;
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reapOrphanedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      const allCompanies = await db.select().from(companies);
      const companyMap = new Map(allCompanies.map((c) => [c.id, c]));
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const agentCompany = companyMap.get(agent.companyId);
        if (agentCompany?.status === "paused") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        // Empty-queue gating: skip timer wakeup if agent has no work and no
        // idle behavior that warrants running.  PM/CEO roles and agents with
        // non-exit idle behavior are exempt (they may have coordination work).
        const hasIdleBehavior = policy.onIdleBehavior !== "exit";
        const isLeadershipRole = policy.roleProfile === "pm" || policy.roleProfile === "ceo";
        if (!hasIdleBehavior && !isLeadershipRole) {
          const [assignmentCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(issues)
            .where(
              and(
                eq(issues.assigneeAgentId, agent.id),
                inArray(issues.status, ["todo", "in_progress", "blocked"]),
              ),
            );
          const [pendingWakeCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.agentId, agent.id),
                eq(agentWakeupRequests.status, "queued"),
              ),
            );
          if ((assignmentCount?.count ?? 0) === 0 && (pendingWakeCount?.count ?? 0) === 0) {
            logger.info(
              { agentId: agent.id, companyId: agent.companyId },
              "timer_skipped_empty_queue: no assignments or pending wakeups",
            );
            skipped += 1;
            continue;
          }
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: async (runId: string) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (run.status !== "running" && run.status !== "queued") return run;

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        const graceMs = Math.max(1, running.graceSec) * 1000;
        setTimeout(() => {
          if (!running.child.killed) {
            running.child.kill("SIGKILL");
          }
        }, graceMs);
      }

      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
      });

      if (cancelled) {
        await appendRunEvent(cancelled, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: "run cancelled",
        });
        await releaseIssueExecutionAndPromote(cancelled);
      }

      runningProcesses.delete(run.id);
      await finalizeAgentStatus(run.agentId, "cancelled");
      await startNextQueuedRunForAgent(run.agentId);
      return cancelled;
    },

    cancelActiveForAgent: async (agentId: string) => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

      for (const run of runs) {
        await setRunStatus(run.id, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
          errorCode: "cancelled",
        });

        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
        });

        const running = runningProcesses.get(run.id);
        if (running) {
          running.child.kill("SIGTERM");
          runningProcesses.delete(run.id);
        }
        await releaseIssueExecutionAndPromote(run);
      }

      return runs.length;
    },

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
