-- 0.8.17: a dashboard session is kept as the SHA-256 of its token, as an MCP token is. The token is the cookie's value,
-- and this file goes into every snapshot, a USB drive's included. The sessions kept before held the token itself: they
-- are cleared, and everyone signs in once. The column is named for what it holds; its second index goes with the old
-- name, the UNIQUE constraint's own being the one a lookup uses.
DELETE FROM user_sessions;
DROP INDEX idx_user_sessions_token;
ALTER TABLE user_sessions RENAME COLUMN token TO token_hash;
