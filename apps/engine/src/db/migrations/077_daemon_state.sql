-- 0.8.18: the daemon's own small state, one row each: which agents are paused, when each alert was last sent, what the
-- external agents' CLIs keep across a restart, what the last boot advised. Each was a JSON file at the root of data/,
-- outside every snapshot and `nouride db restore`. The first start that has this table reads each file into its row and
-- leaves the file where it was, for the way back.
CREATE TABLE daemon_state (
  name TEXT PRIMARY KEY,          -- what it holds, by the name its file had without `.json`: `paused-agents`
  value TEXT NOT NULL,            -- the JSON it holds
  updated_at INTEGER NOT NULL     -- when it was last written, epoch ms
) WITHOUT ROWID;
