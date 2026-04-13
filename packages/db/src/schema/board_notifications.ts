import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { approvals } from "./approvals.js";

export const boardNotifications = pgTable(
  "board_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id"), // board user ID, null for company-wide
    type: text("type").notNull(), // 'blocked_task', 'pending_approval', 'unstarted_assignment', 'budget_alert', 'digest'
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    issueId: uuid("issue_id").references(() => issues.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUnreadIdx: index("board_notifications_company_unread_idx").on(
      table.companyId,
      table.readAt,
    ),
  }),
);
