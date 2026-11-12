-- Whose an automation is, and whose a mission is: a person, as `[[people]]` writes an id (`web:<account id>`,
-- `telegram:814…`), the form a conversation's opener is kept in (`sessions.opened_by`). Every account read and changed
-- every one of them. NULL is nobody's: made from the command line or by the daemon, still a proposal, or from before
-- with nothing a person can be read from. An admin's to see.
ALTER TABLE cron_jobs ADD COLUMN owner TEXT;
ALTER TABLE missions ADD COLUMN owner TEXT;

-- Filled once from what was recorded. A job: whoever turned its proposal on (an account's id from the dashboard, a
-- sender's id from the chat it was proposed in), else the account whose username made it. Nothing is read from a name
-- that only looks like a person's.
UPDATE cron_jobs SET owner = CASE
  WHEN turned_on_by IS NOT NULL AND turned_on_by IN (SELECT id FROM users) THEN 'web:' || turned_on_by
  WHEN turned_on_by IS NOT NULL AND turned_on_by <> '' AND turned_on_by <> 'cli' AND instr(target_gateway_id, ':') > 1
    THEN substr(target_gateway_id, 1, instr(target_gateway_id, ':') - 1) || ':' || turned_on_by
  WHEN turned_on_by IS NULL AND proposal IS NULL AND created_by NOT IN ('cli', 'restart', 'update')
    THEN (SELECT 'web:' || u.id FROM users u WHERE u.username = lower(cron_jobs.created_by))
  ELSE NULL
END;

-- A mission: its job's owner where a job started it; else whoever started it, an account's id on the dashboard and a
-- sender's id in a chat, qualified by the platform of the chat it reports to.
UPDATE missions SET owner = CASE
  WHEN job_id IS NOT NULL THEN (SELECT j.owner FROM cron_jobs j WHERE j.id = missions.job_id)
  WHEN started_by IS NULL OR started_by = '' OR started_by = 'cli' OR started_by LIKE 'agent:%' OR started_by LIKE 'nouride:%' THEN NULL
  WHEN instr(gateway_id, ':') > 1 THEN substr(gateway_id, 1, instr(gateway_id, ':') - 1) || ':' || started_by
  ELSE NULL
END;

-- A mission another mission started is its parent's.
UPDATE missions SET owner = (SELECT p.owner FROM missions p WHERE p.id = missions.parent_id)
WHERE parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM missions p WHERE p.id = missions.parent_id);
