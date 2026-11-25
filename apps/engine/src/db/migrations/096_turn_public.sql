-- A turn answered by an agent that was open to everyone when it ran. What was said to such an agent is never cut into
-- memory, and that was decided by what the agent is at the cut: closed, deleted, or a pack that no longer loads, and
-- the next pass filed every conversation it had with strangers. The mark is the turn's own, set once as it begins.
ALTER TABLE turn_records ADD COLUMN public INTEGER;
