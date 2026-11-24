-- What strangers have used of an agent open to everyone, by the operator's own day: one row for each sender who wrote
-- to it that day, and one for the agent itself (the empty connection and sender), which keeps only that its admin was
-- told. Kept here so a restart resets no count. A row is a week's at most: older days are taken out as new ones begin.
CREATE TABLE open_door (
  agent_id TEXT NOT NULL,
  -- The start of the operator's day, in ms.
  day INTEGER NOT NULL,
  gateway_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  -- The messages of theirs that were answered that day.
  messages INTEGER NOT NULL DEFAULT 0,
  -- Said once a day, not once a message: that the agent is closed for the day, and that they have sent all they may.
  told_closed INTEGER NOT NULL DEFAULT 0,
  told_enough INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, gateway_id, sender_id)
) WITHOUT ROWID;

-- The days past keeping are found by their day, whichever agent's they were: one that was deleted leaves none behind.
CREATE INDEX open_door_day ON open_door (day);
