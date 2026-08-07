CREATE UNIQUE INDEX "maintenance_jobs_active_soft_deleted_purge_unique" ON "maintenance_jobs" USING btree ("type") WHERE "type" = 'soft_deleted_purge' and "status" in ('pending', 'running');
