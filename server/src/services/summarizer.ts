import type { Db } from "@paperclipai/db";
import {
  agents,
  and,
  companySummaries,
  costEvents,
  eq,
  gte,
  issues,
  sql,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type SummaryType = "milestone" | "release" | "weekly_digest" | "budget_alert";

interface SummaryRequest {
  type: SummaryType;
  companyId: string;
  context: Record<string, unknown>;
}

interface SummaryResult {
  title: string;
  body: string;
  highlights: string[];
}

const GROQ_MODEL = "llama-3.3-70b-versatile";

async function callGroq(prompt: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0]?.message?.content ?? "";
}

function parseGroqResponse(raw: string): SummaryResult {
  // Try to extract structured sections, fallback to raw text
  const titleMatch = raw.match(/^#\s+(.+)/m);
  const title = titleMatch?.[1] ?? raw.split("\n")[0]?.slice(0, 100) ?? "Summary";

  const bulletMatches = [...raw.matchAll(/^[-*]\s+(.+)/gm)];
  const highlights = bulletMatches.map((m) => m[1]).slice(0, 5);

  return { title, body: raw, highlights };
}

export function summarizerService(db: Db) {
  async function gatherWeeklyContext(companyId: string) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const completedTasks = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, weekAgo)))
      .then((rows) => Number(rows[0]?.count ?? 0));

    const blockedTasks = await db
      .select({
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")))
      .limit(10);

    const newTasks = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), gte(issues.createdAt, weekAgo)))
      .then((rows) => Number(rows[0]?.count ?? 0));

    const totalCost = await db
      .select({ total: sql<number>`coalesce(sum(amount_cents), 0)` })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.createdAt, weekAgo)))
      .then((rows) => Number(rows[0]?.total ?? 0));

    const agentActivity = await db
      .select({
        name: agents.name,
        status: agents.status,
        spent: agents.spentMonthlyCents,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    return {
      completedTasks,
      blockedTasks: blockedTasks.map((t) => `${t.identifier}: ${t.title}`),
      newTasks,
      totalCostCents: totalCost,
      agents: agentActivity.map((a) => ({ name: a.name, status: a.status, spentCents: a.spent })),
    };
  }

  function buildPrompt(req: SummaryRequest): string {
    switch (req.type) {
      case "weekly_digest":
        return `You are a concise project status reporter. Given the following data about a company's agent workforce for the past week, write a 3-5 paragraph markdown summary.

Data:
${JSON.stringify(req.context, null, 2)}

Write in plain business English. Lead with the most important news. Flag anything that needs board attention. Use bullet points for key items. Start with a short title line prefixed with #.`;

      case "milestone":
        return `You are a project milestone announcer. Summarize what was accomplished in this milestone.

Milestone data:
${JSON.stringify(req.context, null, 2)}

Write a concise markdown summary (2-3 paragraphs). Start with a # title. List key accomplishments as bullets. Note any remaining work.`;

      case "release":
        return `You are a release notes writer. Summarize what shipped in this release.

Release data:
${JSON.stringify(req.context, null, 2)}

Write concise markdown release notes. Start with a # title. List what shipped as bullets. Note any breaking changes.`;

      case "budget_alert":
        return `You are a budget analyst. An agent has exceeded 80% of their monthly budget. Assess the situation.

Budget data:
${JSON.stringify(req.context, null, 2)}

Write a concise assessment (1-2 paragraphs). Start with a # title. Recommend whether to increase budget or prioritize remaining work.`;
    }
  }

  return {
    generateSummary: async (req: SummaryRequest): Promise<SummaryResult & { id: string }> => {
      // Gather context if not provided
      if (req.type === "weekly_digest" && Object.keys(req.context).length === 0) {
        req.context = await gatherWeeklyContext(req.companyId);
      }

      try {
        const prompt = buildPrompt(req);
        const raw = await callGroq(prompt);
        const result = parseGroqResponse(raw);

        const [row] = await db
          .insert(companySummaries)
          .values({
            companyId: req.companyId,
            type: req.type,
            title: result.title,
            body: result.body,
            highlights: result.highlights,
            contextRef: req.context,
            status: "completed",
          })
          .returning();

        return { ...result, id: row.id };
      } catch (err) {
        logger.error({ err, type: req.type, companyId: req.companyId }, "summarization failed");

        // Store failed record for retry
        const [row] = await db
          .insert(companySummaries)
          .values({
            companyId: req.companyId,
            type: req.type,
            title: `Failed: ${req.type} summary`,
            body: err instanceof Error ? err.message : "Unknown error",
            highlights: [],
            contextRef: req.context,
            status: "failed",
          })
          .returning();

        throw err;
      }
    },

    listSummaries: async (companyId: string, type?: SummaryType, limit = 20) => {
      const conditions = [eq(companySummaries.companyId, companyId)];
      if (type) conditions.push(eq(companySummaries.type, type));

      return db
        .select()
        .from(companySummaries)
        .where(and(...conditions))
        .orderBy(sql`${companySummaries.createdAt} DESC`)
        .limit(limit);
    },

    getSummary: async (id: string) => {
      return db
        .select()
        .from(companySummaries)
        .where(eq(companySummaries.id, id))
        .then((rows) => rows[0] ?? null);
    },
  };
}
