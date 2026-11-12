-- Which of our agents answers a message that tags nobody in a group, where the group named one with `/mention <agent>`.
-- NULL on every row from before the upgrade, which goes on meaning what it meant: `require_mention` 1 is a tag needed,
-- 0 is none needed and the orchestrator answers. Nothing is moved: one column is added.
ALTER TABLE room_mention ADD COLUMN agent_id TEXT;
