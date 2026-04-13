CREATE TABLE "company_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "highlights" jsonb DEFAULT '[]',
  "context_ref" jsonb,
  "status" text NOT NULL DEFAULT 'completed',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "company_summaries_company_type_idx"
  ON "company_summaries" ("company_id", "type");
