-- A device token: what a Home app on the same machine as the daemon holds so it never lands on the sign-in page. Made
-- by `nouride auth device`, which only the control token may ask for (the CLI, reading it from the data folder), and
-- bound to the first admin when it is made. It never expires; it is traded for an ordinary session, and revoked from
-- the dashboard. Only its SHA-256 is kept, as an MCP token's and a session's are. It goes with its account: "Reset
-- accounts" and a deleted user take theirs, never handed to whoever is made next.
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- What a deleted account takes with it is found by this.
CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);

-- The device a session was traded for, so revoking the device ends the session it is using too: a lost phone is
-- signed out at once, not when its week runs out. Null for a session a password or a provider made.
ALTER TABLE user_sessions ADD COLUMN device_id TEXT;
CREATE INDEX idx_user_sessions_device ON user_sessions(device_id) WHERE device_id IS NOT NULL;
