import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentMatrixMessages = pgTable(
  "agent_matrix_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roomName: text("room_name").notNull(),
    roomType: text("room_type").notNull().default("channel"),
    senderDisplayName: text("sender_display_name").notNull(),
    body: text("body").notNull().default(""),
    matrixEventId: text("matrix_event_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUnreadIdx: index("agent_matrix_messages_agent_unread_idx").on(
      table.agentId,
      table.readAt,
    ),
    matrixEventIdIdx: uniqueIndex("agent_matrix_messages_event_id_idx")
      .on(table.matrixEventId),
  }),
);
