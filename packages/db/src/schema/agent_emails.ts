import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentEmails = pgTable(
  "agent_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    from: text("from").notNull(),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUnreadIdx: index("agent_emails_agent_unread_idx").on(
      table.agentId,
      table.readAt,
    ),
  }),
);
