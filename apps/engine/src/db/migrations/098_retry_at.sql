-- When a turn refused for a plan's limit that said when it ends is taken up again: that end, in ms. A restart in between
-- finds it here and sets it again (`pipeline/provider-resume.ts`). NULL on every other turn.
ALTER TABLE turn_records ADD COLUMN retry_at INTEGER;
