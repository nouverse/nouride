-- Automations that watch. Two small tables, both tied to their job and gone with it.
--
-- What each step marked to go on only when changed said the last time a run of its job ended well: a hash, never the
-- text, which may hold what should not be kept twice. One row a step, replaced as the job runs.
CREATE TABLE cron_step_said (
  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (job_id, step_id)
) WITHOUT ROWID;

-- What automations would have said inside the install's quiet hours (`[cron] quiet_hours`), kept until they end and
-- then sent as one message a chat. `kind`: `said`, a run's words; `failed`, why a run failed; `ask`, a question a step
-- waits on, whose card is sent then. Where each goes is read from its job when it is sent, so nothing here names a chat.
CREATE TABLE cron_held (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  run_id TEXT,
  step_id TEXT,
  kind TEXT NOT NULL,                             -- said | failed | ask
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_cron_held_at ON cron_held(at);
-- A job deleted takes its lines with it: found by the job, not by reading them all.
CREATE INDEX idx_cron_held_job ON cron_held(job_id);
