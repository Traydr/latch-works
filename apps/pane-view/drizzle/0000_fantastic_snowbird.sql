CREATE TYPE "public"."collection_type" AS ENUM('comic', 'story-series', 'folder', 'source-post');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video', 'story');--> statement-breakpoint
CREATE TYPE "public"."sync_action" AS ENUM('upload', 'update', 'keep', 'delete');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"library_entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "collection_items_collection_id_library_entry_id_pk" PRIMARY KEY("collection_id","library_entry_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "collection_type" NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"cover_entry_id" uuid
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_subject_id_subject_type_pk" PRIMARY KEY("user_id","subject_id","subject_type")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"parent_path" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_object_id" uuid NOT NULL,
	"logical_path" text NOT NULL,
	"parent_path" text DEFAULT '' NOT NULL,
	"filename" text NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"source" text,
	"source_id" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"extension" text NOT NULL,
	"media_type" "media_type" NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"page_count" integer,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_run_items" (
	"sync_run_id" uuid NOT NULL,
	"logical_path" text NOT NULL,
	"media_object_id" uuid,
	"action" "sync_action" NOT NULL,
	"error" text,
	CONSTRAINT "sync_run_items_sync_run_id_logical_path_pk" PRIMARY KEY("sync_run_id","logical_path")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"source_root" text NOT NULL,
	"status" "sync_run_status" NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest_key" text
);
--> statement-breakpoint
CREATE TABLE "thumbnails" (
	"media_object_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"object_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	CONSTRAINT "thumbnails_media_object_id_size_pk" PRIMARY KEY("media_object_id","size")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewer_state" (
	"user_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"position_ms" integer,
	"page" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viewer_state_user_id_subject_id_subject_type_pk" PRIMARY KEY("user_id","subject_id","subject_type")
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_library_entry_id_library_entries_id_fk" FOREIGN KEY ("library_entry_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_cover_entry_id_library_entries_id_fk" FOREIGN KEY ("cover_entry_id") REFERENCES "public"."library_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD CONSTRAINT "thumbnails_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer_state" ADD CONSTRAINT "viewer_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_unique" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "collection_items_collection_position_idx" ON "collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_path_type_unique" ON "collections" USING btree ("path","type");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_path_unique" ON "folders" USING btree ("path");--> statement-breakpoint
CREATE INDEX "folders_parent_path_idx" ON "folders" USING btree ("parent_path");--> statement-breakpoint
CREATE UNIQUE INDEX "library_entries_logical_path_unique" ON "library_entries" USING btree ("logical_path");--> statement-breakpoint
CREATE INDEX "library_entries_parent_path_idx" ON "library_entries" USING btree ("parent_path");--> statement-breakpoint
CREATE INDEX "library_entries_media_object_id_idx" ON "library_entries" USING btree ("media_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_sha256_unique" ON "media_objects" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");