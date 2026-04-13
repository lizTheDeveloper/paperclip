CREATE TABLE "agent_pending_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "type" text NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id"),
  "comment_id" uuid REFERENCES "issue_comments"("id"),
  "payload" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "consumed_at" timestamp with time zone
);

CREATE INDEX "agent_pending_notifications_agent_unconsumed_idx"
  ON "agent_pending_notifications" ("agent_id", "consumed_at");
