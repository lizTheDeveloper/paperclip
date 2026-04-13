import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),         // published: <pkg>/dist/server/ -> <pkg>/skills/
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server/ -> repo root/skills/
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

/**
 * Set of all legacy full-protocol paperclip skills that are replaced by the
 * minimal bootstrap skill. These are excluded from skill symlinking.
 */
const PAPERCLIP_PROTOCOL_SKILLS = new Set(["paperclip", "paperclip-ic", "paperclip-pm", "paperclip-ceo"]);

/**
 * Generate the minimal bootstrap skill content (~150 tokens) that teaches
 * agents how to discover the Paperclip API. Replaces the full protocol skills
 * (paperclip-ceo: ~200 lines, paperclip-ic: similar) that were 2-4K tokens.
 */
function buildBootstrapSkillContent(): string {
  return `---
name: paperclip
description: Paperclip agent bootstrap — use when starting any Paperclip heartbeat
---

# Paperclip Agent

You are a Paperclip agent. Your identity and assignments are available via the Paperclip API.

## Quick Start
- API base: $PAPERCLIP_API_URL (auth: Bearer $PAPERCLIP_API_KEY)
- Discovery: GET /api — lists all endpoints with descriptions
- Full docs: GET /api/docs — complete endpoint documentation
- Your identity: GET /api/agents/me
- Your tasks: check wake context env vars first, then call assignments endpoint

## Wake Context
Environment variables tell you why you woke up:
- PAPERCLIP_TASK_ID: prioritized task (if set)
- PAPERCLIP_WAKE_REASON: why you were woken
- PAPERCLIP_RUN_ID: include as X-Paperclip-Run-Id header on all write requests
- PAPERCLIP_ASSIGNMENTS_SUMMARY: one-line summary of your task queue
- PAPERCLIP_TASK_JSON: compact summary of your prioritized task

## Rules
- Always checkout before working on a task (POST /api/issues/{id}/checkout)
- Always comment on in_progress work before exiting
- Never retry a 409 (someone else has the task)
- Never look for unassigned work
- Always set parentId on subtasks

## Context
- Specs live in the repo (docs/specs/), not in tickets
- If you receive clarification in a comment, update the spec file and note it in the ticket
- Read spec files for requirements; read tickets for status and coordination only
`;
}

/**
 * Create a tmpdir with \`.claude/skills/\` containing:
 * 1. A generated minimal bootstrap skill (replaces full protocol skills)
 * 2. Symlinks to all other skills from the repo's \`skills/\` directory
 *
 * Claude Code discovers these via \`--add-dir\`.
 */
async function buildSkillsDir(_agentRole?: string | null): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });

  // Write the minimal bootstrap skill
  const bootstrapDir = path.join(target, "paperclip");
  await fs.mkdir(bootstrapDir, { recursive: true });
  await fs.writeFile(path.join(bootstrapDir, "SKILL.md"), buildBootstrapSkillContent(), "utf-8");

  // Symlink all non-protocol skills from the skills directory
  const skillsDir = await resolvePaperclipSkillsDir();
  if (skillsDir) {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink()) {
        const resolved = await fs.stat(path.join(skillsDir, entry.name)).catch(() => null);
        if (!resolved?.isDirectory()) continue;
      }
      // Skip all legacy protocol skills — replaced by bootstrap
      if (PAPERCLIP_PROTOCOL_SKILLS.has(entry.name)) continue;
      await fs.symlink(
        path.join(skillsDir, entry.name),
        path.join(target, entry.name),
      );
    }
  }
  return tmp;
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (typeof context.assignmentsJson === "string" && context.assignmentsJson.length > 0) {
    env.PAPERCLIP_ASSIGNMENTS_JSON = context.assignmentsJson;
  }
  if (typeof context.assignmentsSummary === "string" && context.assignmentsSummary.length > 0) {
    env.PAPERCLIP_ASSIGNMENTS_SUMMARY = context.assignmentsSummary;
  }
  if (typeof context.agentRole === "string" && context.agentRole.length > 0) {
    env.PAPERCLIP_AGENT_ROLE = context.agentRole;
  }
  if (typeof context.taskJson === "string" && context.taskJson.length > 0) {
    env.PAPERCLIP_TASK_JSON = context.taskJson;
  }
  if (typeof context.heartbeatRoleProfile === "string" && context.heartbeatRoleProfile.length > 0) {
    env.PAPERCLIP_ROLE_PROFILE = context.heartbeatRoleProfile;
  }
  if (typeof context.teamSummary === "string" && context.teamSummary.length > 0) {
    env.PAPERCLIP_TEAM_SUMMARY = context.teamSummary;
  }
  // Legacy env vars removed: PAPERCLIP_TEAM_STATUS_JSON, PAPERCLIP_DASHBOARD_JSON
  // Full team/dashboard data available via API endpoints
  if (typeof context.onIdleBehavior === "string" && context.onIdleBehavior.length > 0) {
    env.PAPERCLIP_ON_IDLE_BEHAVIOR = context.onIdleBehavior;
  }
  if (typeof context.idleCustomPrompt === "string" && context.idleCustomPrompt.length > 0) {
    env.PAPERCLIP_IDLE_CUSTOM_PROMPT = context.idleCustomPrompt;
  }
  if (typeof context.pmAgentId === "string" && context.pmAgentId.length > 0) {
    env.PAPERCLIP_PM_AGENT_ID = context.pmAgentId;
  }
  if (typeof context.pmAgentName === "string" && context.pmAgentName.length > 0) {
    env.PAPERCLIP_PM_AGENT_NAME = context.pmAgentName;
  }
  if (typeof context.inProgressDetails === "string" && context.inProgressDetails.length > 0) {
    env.PAPERCLIP_IN_PROGRESS_DETAILS = context.inProgressDetails;
  }
  if (typeof context.projectDashboard === "string" && context.projectDashboard.length > 0) {
    env.PAPERCLIP_PROJECT_DASHBOARD = context.projectDashboard;
  }
  if (typeof context.backlogSummary === "string" && context.backlogSummary.length > 0) {
    env.PAPERCLIP_BACKLOG_SUMMARY = context.backlogSummary;
  }
  if (typeof context.projectSpecsDir === "string" && context.projectSpecsDir.length > 0) {
    env.PAPERCLIP_PROJECT_SPECS_DIR = context.projectSpecsDir;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = instructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      ]
    : [];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const billingType = resolveClaudeBillingType(env);
  const skillsDir = await buildSkillsDir(agent.role);

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath = instructionsFilePath;
  if (instructionsFilePath) {
    const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    const combinedPath = path.join(skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
    effectiveInstructionsFilePath = combinedPath;
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  // Derive computed template variables from context snapshot
  const assignmentsData = (() => {
    try {
      const parsed =
        typeof context.assignmentsJson === "string" ? JSON.parse(context.assignmentsJson) : [];
      if (!Array.isArray(parsed)) return { count: 0, list: "" };
      const list = parsed
        .map(
          (a: { identifier?: string; title?: string; status?: string }) =>
            `- ${a.identifier ?? "?"}: ${a.title ?? "?"} [${a.status ?? "?"}]`,
        )
        .join("\n");
      return { count: parsed.length, list };
    } catch {
      return { count: 0, list: "" };
    }
  })();

  const taskData = (() => {
    try {
      const raw = context.taskJson;
      const parsed =
        typeof raw === "string"
          ? JSON.parse(raw)
          : typeof raw === "object" && raw !== null
            ? raw
            : null;
      if (!parsed || typeof parsed !== "object") return { title: "", description: "" };
      const title = typeof parsed.title === "string" ? parsed.title : "";
      // Compact task summary: description field no longer injected (Tier 3, API-only).
      // Build a brief description from available summary fields.
      const parts: string[] = [];
      if (parsed.identifier) parts.push(`[${parsed.identifier}]`);
      if (parsed.status) parts.push(`Status: ${parsed.status}`);
      if (parsed.priority) parts.push(`Priority: ${parsed.priority}`);
      if (parsed.parentChain) parts.push(`Parent: ${parsed.parentChain}`);
      if (parsed.commentCount > 0) parts.push(`${parsed.commentCount} comments`);
      if (parsed.lastCommentExcerpt) parts.push(`Last: ${parsed.lastCommentExcerpt}`);
      // Backwards compat: if old full format had description, use it
      const desc = typeof parsed.description === "string" ? parsed.description : parts.join(" | ");
      return {
        title,
        description: desc.length > 2000 ? desc.slice(0, 2000) + "…" : desc,
      };
    } catch {
      return { title: "", description: "" };
    }
  })();

  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context: {
      ...context,
      wakeReason: typeof context.wakeReason === "string" ? context.wakeReason : "",
      taskId:
        (typeof context.taskId === "string" && context.taskId.trim()) ||
        (typeof context.issueId === "string" && context.issueId.trim()) ||
        "",
      taskTitle: taskData.title,
      taskDescription: taskData.description,
      assignmentsCount: assignmentsData.count,
      assignments: assignmentsData.list,
      commentId:
        (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
        (typeof context.commentId === "string" && context.commentId.trim()) ||
        "",
    },
  });

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stderr",
        `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
