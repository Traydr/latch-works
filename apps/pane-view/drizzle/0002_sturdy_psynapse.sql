CREATE TYPE "public"."source_type" AS ENUM('cli', 'local', 'extension', 'tresorit', 'manual');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('library_entry', 'collection');--> statement-breakpoint
CREATE TYPE "public"."thumbnail_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "source_type" NOT NULL,
	"name" text NOT NULL,
	"base_path" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_objects" ALTER COLUMN "media_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."media_type";--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'gif', 'video', 'pdf', 'unknown');--> statement-breakpoint
ALTER TABLE "media_objects" ALTER COLUMN "media_type" SET DATA TYPE "public"."media_type" USING "media_type"::"public"."media_type";--> statement-breakpoint
DROP INDEX "media_objects_sha256_unique";--> statement-breakpoint
ALTER TABLE "favorites" ALTER COLUMN "subject_type" SET DATA TYPE "public"."subject_type" USING "subject_type"::"public"."subject_type";--> statement-breakpoint
ALTER TABLE "thumbnails" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."thumbnail_status";--> statement-breakpoint
ALTER TABLE "thumbnails" ALTER COLUMN "status" SET DATA TYPE "public"."thumbnail_status" USING "status"::"public"."thumbnail_status";--> statement-breakpoint
ALTER TABLE "viewer_state" ALTER COLUMN "subject_type" SET DATA TYPE "public"."subject_type" USING "subject_type"::"public"."subject_type";--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "external_source_id" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "folder_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "size" bigint;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "source_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "last_sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "content_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "library_entries" ADD COLUMN "path_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "storage_provider" text DEFAULT 's3' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "bucket" text;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "created_by_sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "previous_media_object_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "previous_logical_path" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "cli_version" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "created_by_token_id" uuid;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_name_unique" ON "sources" USING btree ("name");--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_source_ref_id_sources_id_fk" FOREIGN KEY ("source_ref_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_last_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("last_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_created_by_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("created_by_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_previous_media_object_id_media_objects_id_fk" FOREIGN KEY ("previous_media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_created_by_token_id_api_tokens_id_fk" FOREIGN KEY ("created_by_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_collection_position_unique" ON "collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_sha256_size_unique" ON "media_objects" USING btree ("sha256","size");