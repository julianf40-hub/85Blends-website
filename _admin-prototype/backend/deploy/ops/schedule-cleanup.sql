-- OPTIONAL, reviewed and run separately from the migration (it enables an extension).
-- Schedules the hourly pending-operation cleanup (see README "Operations"). Idempotent: an existing job
-- with this name is replaced.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'gear-cleanup-operations';
select cron.schedule('gear-cleanup-operations', '17 * * * *', $$select public.gear_cleanup_operations()$$);
