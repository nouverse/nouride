-- What one agent did for another, kept once it has ended: an `ask`, answered inside the asking turn or in the
-- background, and a mission another agent started. An ask answered inside the asking turn left no row anywhere, so
-- neither agent could be told of it in another chat. Read as a turn's message is composed (`pipeline/work-done.ts`).
--
-- `said_at`, `said`: the helper's next answer to the same person in a private chat of its own, which the asker is then
-- told of, and `said_gateway_id`, `said_chat_id`: that chat, so the answer goes when its conversation is deleted. A row
-- goes with the conversation it was asked from, and rows a week old are removed when one is written.
CREATE TABLE work_for_another (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                             -- ask | mission
  helper TEXT NOT NULL,                           -- the agent that did it
  asker TEXT NOT NULL,                            -- the agent that asked
  gateway_id TEXT NOT NULL,                       -- the chat it was asked from
  chat_id TEXT NOT NULL,
  sender_id TEXT,                                 -- the person the asking turn answered; none where no person began it
  task TEXT NOT NULL,                             -- what was asked, cut
  outcome TEXT NOT NULL,                          -- how it ended and the start of what was handed back, cut
  ref TEXT,                                       -- a job's or a mission's id, where there is one
  ended_at INTEGER NOT NULL,
  said_at INTEGER,
  said TEXT,
  said_gateway_id TEXT,
  said_chat_id TEXT
);
CREATE INDEX idx_work_for_another_helper ON work_for_another(helper, ended_at);
CREATE INDEX idx_work_for_another_asker ON work_for_another(asker, ended_at);
-- The week-old rows a write removes: found by their time, not by reading them all.
CREATE INDEX idx_work_for_another_ended ON work_for_another(ended_at);
