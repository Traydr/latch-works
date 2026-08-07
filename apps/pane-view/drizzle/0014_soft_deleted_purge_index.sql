CREATE UNIQUE INDEX "maintenance_jobs_active_type_unique" ON "maintenance_jobs" USING btree ("type") WHERE "status" in ('pending', 'running');
