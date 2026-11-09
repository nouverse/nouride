-- 0.8.29: the room log keyed by the connection and the chat a line was heard in, with the platform's id for it. The id
-- alone was the key, and a platform numbers messages per chat: Telegram's message 412 in one group and 412 in another
-- were one row, and the second group's line was dropped. Two of our bots in one group are two connections, each handed
-- its own copy of a line; the first one's was kept and the second's dropped, so the second agent's room log missed what
-- it heard. Every row is carried across: under the stricter key there were no two alike.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt (copy, drop, rename) and its two indexes made
-- again as `069_baseline.sql` made them. The columns are the same, in the same order, and one more after them.
CREATE TABLE chat_messages_rebuild (
  id TEXT NOT NULL,               -- the envelope's own id: the platform's id for the message, unique only in its chat
  gateway_id TEXT NOT NULL,       -- the connection that heard it: each of our bots in a room keeps its own copy
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  text TEXT NOT NULL,
  attachments TEXT,
  at INTEGER NOT NULL,
  -- 1 where the platform numbered the line for this connection alone (the envelope's `idsPerConnection`: a Telegram
  -- basic group). Another of our bots' copy then has an id of its own, and is the same line by who said it, when and what.
  ids_per_connection INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gateway_id, chat_id, id)
);
INSERT INTO chat_messages_rebuild (id, gateway_id, chat_id, sender_id, sender_name, text, attachments, at)
  SELECT id, gateway_id, chat_id, sender_id, sender_name, text, attachments, at FROM chat_messages ORDER BY rowid;
DROP TABLE chat_messages;
ALTER TABLE chat_messages_rebuild RENAME TO chat_messages;

-- Copies under ids of their own were two rows already, and the old key let them be: one chat, two of our connections,
-- the same person, moment and words. Marked, so each reads as one line. The old key let no id be under two connections,
-- so a pair found here is one line under two ids.
UPDATE chat_messages SET ids_per_connection = 1
 WHERE (chat_id, sender_id, at, text) IN (
   SELECT chat_id, sender_id, at, text FROM chat_messages
    GROUP BY chat_id, sender_id, at, text HAVING COUNT(DISTINCT gateway_id) > 1);

CREATE INDEX idx_chat_messages_at ON chat_messages(at);

CREATE INDEX idx_chat_messages_chat ON chat_messages(gateway_id, chat_id, at);
