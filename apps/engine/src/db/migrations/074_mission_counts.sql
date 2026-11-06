-- 0.8.13: what a mission counts beside its turns, kept across a restart — a coding CLI's turns and how many of them
-- reported no tokens, which say whether its tokens are known, and until when its helpers' tokens are in its count.
-- A mission open across the upgrade starts from none, as a restart left it before.
ALTER TABLE missions ADD COLUMN cli_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE missions ADD COLUMN cli_unreported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE missions ADD COLUMN helpers_since INTEGER;
