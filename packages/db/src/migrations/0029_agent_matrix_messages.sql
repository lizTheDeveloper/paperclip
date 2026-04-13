CREATE TABLE "agent_matrix_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "room_name" text NOT NULL,
  "room_type" text NOT NULL DEFAULT 'channel',
  "sender_display_name" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "matrix_event_id" text,
  "received_at" timestamp with time zone NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "agent_matrix_messages_agent_unread_idx"
  ON "agent_matrix_messages" ("agent_id", "read_at");

CREATE UNIQUE INDEX "agent_matrix_messages_event_id_idx"
  ON "agent_matrix_messages" ("matrix_event_id");
