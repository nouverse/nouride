-- Who paused a mission: a person's name as the other verbs write it, and the agent's id where an agent did, through
-- its `work` tool. A person's pause is a person's to end; an agent goes on only with a mission it paused itself, so
-- which of the two it was has to outlive a restart. Both empty for a mission nobody paused. Only added: no row changes.
ALTER TABLE missions ADD COLUMN paused_by TEXT;
ALTER TABLE missions ADD COLUMN paused_by_agent TEXT;
