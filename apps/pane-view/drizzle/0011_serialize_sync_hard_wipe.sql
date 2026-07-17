CREATE UNIQUE INDEX "maintenance_jobs_active_hard_wipe_unique" ON "maintenance_jobs" USING btree ("type") WHERE "type" = 'library_hard_wipe' and "status" in ('pending', 'running');
