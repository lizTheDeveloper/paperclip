CREATE TABLE "board_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "issue_id" uuid REFERENCES "issues"("id"),
  "approval_id" uuid REFERENCES "approvals"("id"),
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "board_notifications_company_unread_idx"
  ON "board_notifications" ("company_id", "read_at");
