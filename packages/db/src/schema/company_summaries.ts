import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companySummaries = pgTable(
  "company_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(), // 'milestone', 'release', 'weekly_digest', 'budget_alert'
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    highlights: jsonb("highlights").$type<string[]>().default([]),
    contextRef: jsonb("context_ref").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("completed"), // 'completed', 'failed'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("company_summaries_company_type_idx").on(
      table.companyId,
      table.type,
    ),
  }),
);
