-- What an agent open to everyone's page counts, apart from what a limit is held to. `messages` is a person's count for
-- the day, written to each of their addresses so one that writes alone still reads it, and set to the most once their
-- day is over: summed, it said messages that were never answered and a person twice. `answered` is the messages of
-- theirs answered by this address, and `person` the address they were first counted by, which their others name.
ALTER TABLE open_door ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE open_door ADD COLUMN person TEXT;
