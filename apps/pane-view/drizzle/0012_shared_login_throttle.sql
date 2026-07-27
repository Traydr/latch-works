CREATE TABLE "login_throttle_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_throttle_attempts_expires_at_idx" ON "login_throttle_attempts" USING btree ("expires_at");
