import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  agents,
  and,
  boardNotifications,
  companySummaries,
  costEvents,
  eq,
  gte,
  inArray,
  isNull,
  issues,
  sql,
} from "@paperclipai/db";
import { summarizerService, type SummaryType } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function reportRoutes(db: Db) {
  const router = Router();
  const summarizer = summarizerService(db);

  // ── Summaries ──────���──────────────────────────────────────────────

  // List summaries
  router.get("/companies/:companyId/summaries", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = req.query.type as SummaryType | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await summarizer.listSummaries(companyId, type, limit);
    res.json(rows);
  });

  // Get single summary
  router.get("/companies/:companyId/summaries/:summaryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await summarizer.getSummary(req.params.summaryId as string);
    if (!row || row.companyId !== companyId) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    res.json(row);
  });

  // Generate summary on demand (board only)
  router.post("/companies/:companyId/summaries/generate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    const { type, context } = req.body as { type?: SummaryType; context?: Record<string, unknown> };
    if (!type) { res.status(400).json({ error: "type is required" }); return; }
    const result = await summarizer.generateSummary({ type, companyId, context: context ?? {} });
    res.status(201).json(result);
  });

  // ── Reports ───────────────────────────────────��───────────────────

  // Velocity report
  router.get("/companies/:companyId/reports/velocity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const periodDays = parseInt(req.query.period as string) || 7;
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const prevSince = new Date(Date.now() - 2 * periodDays * 24 * 60 * 60 * 1000);

    const completed = await db
      .select({
        agentId: issues.assigneeAgentId,
        count: sql<number>`count(*)`,
        avgHours: sql<number>`avg(extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 3600)`,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since)))
      .groupBy(issues.assigneeAgentId);

    const prevCompleted = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, prevSince),
        sql`${issues.completedAt} < ${since}`,
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));

    // Resolve agent names
    const agentIds = completed.map((c) => c.agentId).filter(Boolean) as string[];
    const agentNames = agentIds.length > 0
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const nameMap = new Map(agentNames.map((a) => [a.id, a.name]));

    const totalCompleted = completed.reduce((sum, c) => sum + Number(c.count), 0);
    const totalAvgHours = completed.length > 0
      ? completed.reduce((sum, c) => sum + (Number(c.avgHours) || 0), 0) / completed.length
      : 0;

    const trend = totalCompleted > prevCompleted ? "up" : totalCompleted < prevCompleted ? "down" : "stable";

    res.json({
      tasksCompleted: totalCompleted,
      avgCompletionTimeHours: Math.round(totalAvgHours * 10) / 10,
      byAgent: completed.map((c) => ({
        agentName: nameMap.get(c.agentId ?? "") ?? "unassigned",
        completed: Number(c.count),
        avgHours: Math.round((Number(c.avgHours) || 0) * 10) / 10,
      })),
      trend,
      periodDays,
    });
  });

  // Blocker report
  router.get("/companies/:companyId/reports/blockers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const blockedRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")))
      .orderBy(sql`${issues.updatedAt} ASC`)
      .limit(50);

    const agentIds = blockedRows.map((r) => r.assigneeAgentId).filter(Boolean) as string[];
    const agentNames = agentIds.length > 0
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const nameMap = new Map(agentNames.map((a) => [a.id, a.name]));

    const now = Date.now();
    const blockedTasks = blockedRows.map((r) => ({
      identifier: r.identifier,
      title: r.title,
      assignee: nameMap.get(r.assigneeAgentId ?? "") ?? "unassigned",
      blockedSince: r.updatedAt,
      blockedDays: Math.round((now - new Date(r.updatedAt!).getTime()) / (24 * 60 * 60 * 1000) * 10) / 10,
    }));

    const avgBlockedDays = blockedTasks.length > 0
      ? Math.round(blockedTasks.reduce((sum, t) => sum + t.blockedDays, 0) / blockedTasks.length * 10) / 10
      : 0;

    const longest = blockedTasks.length > 0
      ? blockedTasks.reduce((a, b) => a.blockedDays > b.blockedDays ? a : b)
      : null;

    res.json({
      blockedTasks,
      avgBlockedDays,
      longestBlocked: longest ? `${longest.identifier} (${longest.blockedDays} days)` : null,
    });
  });

  // Cost efficiency report
  router.get("/companies/:companyId/reports/efficiency", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const periodDays = parseInt(req.query.period as string) || 30;
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const totalSpent = await db
      .select({ total: sql<number>`coalesce(sum(amount_cents), 0)` })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.createdAt, since)))
      .then((rows) => Number(rows[0]?.total ?? 0));

    const tasksCompleted = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since)))
      .then((rows) => Number(rows[0]?.count ?? 0));

    const costPerTask = tasksCompleted > 0 ? Math.round(totalSpent / tasksCompleted) : 0;

    res.json({
      totalSpentCents: totalSpent,
      tasksCompleted,
      costPerTask,
      periodDays,
    });
  });

  // ── Board Notifications ───────────────────────────────────────────

  // List notifications for board
  router.get("/companies/:companyId/notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    const unreadOnly = req.query.unread === "true";
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const conditions = [eq(boardNotifications.companyId, companyId)];
    if (unreadOnly) conditions.push(isNull(boardNotifications.readAt));

    const rows = await db
      .select()
      .from(boardNotifications)
      .where(and(...conditions))
      .orderBy(sql`${boardNotifications.createdAt} DESC`)
      .limit(limit);

    res.json(rows);
  });

  // Mark notification as read
  router.post("/companies/:companyId/notifications/:notificationId/read", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    const notificationId = req.params.notificationId as string;

    const updated = await db
      .update(boardNotifications)
      .set({ readAt: new Date() })
      .where(and(
        eq(boardNotifications.id, notificationId),
        eq(boardNotifications.companyId, companyId),
        isNull(boardNotifications.readAt),
      ))
      .returning();

    if (updated.length === 0) {
      res.status(404).json({ error: "Notification not found or already read" });
      return;
    }
    res.json(updated[0]);
  });

  // Mark all notifications as read
  router.post("/companies/:companyId/notifications/read-all", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);

    const result = await db
      .update(boardNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(boardNotifications.companyId, companyId), isNull(boardNotifications.readAt)))
      .returning();

    res.json({ marked: result.length });
  });

  return router;
}
