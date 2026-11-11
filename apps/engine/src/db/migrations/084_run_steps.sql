-- How each step of a run went, for a job that runs several in order: one row of JSON per run, as `held` is. And where
-- a run stands while one of its steps waits for a mission or a person, so a restart can go on from it. Both NULL on
-- every run of a job of one kind, and on every run from before the upgrade. Nothing is moved: two columns are added.
ALTER TABLE cron_runs ADD COLUMN steps TEXT;
ALTER TABLE cron_runs ADD COLUMN state TEXT;
