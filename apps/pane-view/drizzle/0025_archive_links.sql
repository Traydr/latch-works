-- 0025_archive_links: To archive (plan 068), the links the owner means to archive and
-- the ones already archived. Additive: a new enum and a new table, nothing else changes.
CREATE TYPE "public"."archive_link_status" AS ENUM('to_archive', 'archived');--> statement-breakpoint
CREATE TABLE "archive_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"site" text NOT NULL,
	"status" "archive_link_status" DEFAULT 'to_archive' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"recheck_days" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_links_recheck_days_positive" CHECK ("archive_links"."recheck_days" is null or "archive_links"."recheck_days" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "archive_links_canonical_url_unique" ON "archive_links" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "archive_links_status_queued_at_idx" ON "archive_links" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "archive_links_status_archived_at_idx" ON "archive_links" USING btree ("status","archived_at" DESC NULLS LAST);