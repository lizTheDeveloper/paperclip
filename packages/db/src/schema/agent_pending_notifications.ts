import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const agentPendingNotifications = pgTable(
  "agent_pending_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(), // 'comment_mention', 'status_change', 'priority_change'
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    commentId: uuid("comment_id").references(() => issueComments.id),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => ({
    agentUnconsumedIdx: index("agent_pending_notifications_agent_unconsumed_idx").on(
      table.agentId,
      table.consumedAt,
    ),
  }),
);
