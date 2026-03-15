/**
 * Transcript recovery for process-lost heartbeat runs.
 *
 * When the server restarts, orphaned runs are reaped as "process_lost".
 * Their ndjson log files are truncated at the point of server crash.
 * However, Claude Code stores full conversation JSONL files at
 * ~/.claude/projects/[project-dir]/[sessionId].jsonl which contain all messages.
 *
 * This service finds process-lost runs and reconstructs their transcripts
 * by appending missing messages from the Claude JSONL files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const RUN_LOG_BASE_PATH =
  process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");

const CLAUDE_PROJECTS_DIR = path.resolve(os.homedir(), ".claude", "projects");

interface ClaudeJsonlEntry {
  type: string;
  message?: {
    role: string;
    content: unknown[];
    model?: string;
    id?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
    usage?: unknown;
  };
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
}

interface NdjsonEntry {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

/**
 * Convert a Claude Code JSONL entry into the stream-json ndjson chunk format
 * that Paperclip's transcript viewer expects.
 */
function jsonlEntryToNdjsonChunk(entry: ClaudeJsonlEntry): string | null {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (!entry.message) return null;

  // Convert camelCase sessionId → snake_case session_id
  const streamEvent: Record<string, unknown> = {
    type: entry.type,
    message: entry.message,
    session_id: entry.sessionId ?? null,
    uuid: entry.uuid ?? null,
    parent_tool_use_id: null,
    // Mark as recovered so the UI can optionally surface this
    _recovered: true,
  };

  return JSON.stringify(streamEvent);
}

/**
 * Find the Claude JSONL file for a given session ID by scanning all project dirs.
 * Claude stores files at ~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl
 */
async function findClaudeJsonlFile(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dir of projectDirs) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not here, try next
    }
  }
  return null;
}

/**
 * Get the last timestamp from an existing ndjson run log file.
 */
async function getLastNdjsonTimestamp(ndjsonPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(ndjsonPath, "utf8");
  } catch {
    return null;
  }

  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  // Scan from the end for the last valid entry
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as NdjsonEntry;
      if (entry.ts) return entry.ts;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Get the set of UUIDs already present in an ndjson run log file.
 * Used to avoid appending duplicate entries.
 */
async function getExistingNdjsonUuids(ndjsonPath: string): Promise<Set<string>> {
  const uuids = new Set<string>();
  let content: string;
  try {
    content = await fs.readFile(ndjsonPath, "utf8");
  } catch {
    return uuids;
  }

  for (const line of content.trim().split("\n")) {
    try {
      const entry = JSON.parse(line) as NdjsonEntry;
      if (entry.stream === "stdout") {
        const event = JSON.parse(entry.chunk) as Record<string, unknown>;
        if (typeof event.uuid === "string") uuids.add(event.uuid);
      }
    } catch {
      continue;
    }
  }
  return uuids;
}

/**
 * Recover missing transcript entries for a single process-lost run.
 * Returns the number of entries appended.
 */
async function recoverRunTranscript(
  ndjsonPath: string,
  jsonlPath: string,
  runStartedAt: Date,
  runFinishedAt: Date,
): Promise<number> {
  const existingUuids = await getExistingNdjsonUuids(ndjsonPath);
  const lastTs = await getLastNdjsonTimestamp(ndjsonPath);
  const cutoffTs = lastTs ?? runStartedAt.toISOString();

  let jsonlContent: string;
  try {
    jsonlContent = await fs.readFile(jsonlPath, "utf8");
  } catch {
    return 0;
  }

  const lines = jsonlContent.trim().split("\n").filter(Boolean);
  const toAppend: string[] = [];

  for (const line of lines) {
    let entry: ClaudeJsonlEntry;
    try {
      entry = JSON.parse(line) as ClaudeJsonlEntry;
    } catch {
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.timestamp) continue;

    // Only recover messages within this run's time window
    if (entry.timestamp <= cutoffTs) continue;
    if (entry.timestamp > runFinishedAt.toISOString()) continue;

    // Skip if already present
    if (entry.uuid && existingUuids.has(entry.uuid)) continue;

    const chunk = jsonlEntryToNdjsonChunk(entry);
    if (!chunk) continue;

    const ndjsonLine = JSON.stringify({
      ts: entry.timestamp,
      stream: "stdout",
      chunk,
    } satisfies NdjsonEntry);

    toAppend.push(ndjsonLine);
  }

  if (toAppend.length === 0) return 0;

  await fs.appendFile(ndjsonPath, toAppend.map((l) => `${l}\n`).join(""), "utf8");
  return toAppend.length;
}

/**
 * Recover transcripts for all process-lost runs that have a known session ID
 * and an existing log file. Should be called after reapOrphanedRuns on startup.
 */
export async function recoverProcessLostTranscripts(db: Db): Promise<{ recovered: number; runs: number }> {
  // Find process-lost runs with a session ID and a log ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const reaped: Array<{
    id: string;
    agent_id: string;
    session_id_before: string | null;
    log_ref: string | null;
    started_at: Date | null;
    finished_at: Date | null;
  }> = await dbAny.execute(
    sql`SELECT id, agent_id, session_id_before, log_ref, started_at, finished_at
        FROM heartbeat_runs
        WHERE error_code = 'process_lost'
          AND session_id_before IS NOT NULL
          AND log_ref IS NOT NULL`,
  );

  let totalAppended = 0;
  let runsRecovered = 0;

  const rows = Array.isArray(reaped) ? reaped : ((reaped as unknown as { rows: typeof reaped }).rows ?? []);

  for (const run of rows) {
    if (!run.session_id_before || !run.log_ref || !run.started_at || !run.finished_at) continue;

    const ndjsonPath = path.resolve(RUN_LOG_BASE_PATH, run.log_ref);

    // Skip if the ndjson file doesn't exist
    try {
      await fs.access(ndjsonPath);
    } catch {
      continue;
    }

    const jsonlPath = await findClaudeJsonlFile(run.session_id_before);
    if (!jsonlPath) continue;

    try {
      const appended = await recoverRunTranscript(
        ndjsonPath,
        jsonlPath,
        new Date(run.started_at),
        new Date(run.finished_at),
      );

      if (appended > 0) {
        // Update logBytes in DB to reflect the new file size
        const stat = await fs.stat(ndjsonPath);
        await dbAny.execute(
          sql`UPDATE heartbeat_runs SET log_bytes = ${stat.size}, updated_at = NOW() WHERE id = ${run.id}`,
        );

        totalAppended += appended;
        runsRecovered++;
        logger.info(
          { runId: run.id, agentId: run.agent_id, appended },
          "recovered process-lost transcript entries from Claude JSONL",
        );
      }
    } catch (err) {
      logger.warn({ err, runId: run.id }, "transcript recovery failed for run");
    }
  }

  return { recovered: totalAppended, runs: runsRecovered };
}
