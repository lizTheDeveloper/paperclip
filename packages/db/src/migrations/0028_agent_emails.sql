CREATE TABLE "agent_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "from" text NOT NULL,
  "subject" text NOT NULL DEFAULT '',
  "body_text" text NOT NULL DEFAULT '',
  "received_at" timestamp with time zone NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "agent_emails_agent_unread_idx"
  ON "agent_emails" ("agent_id", "read_at");
