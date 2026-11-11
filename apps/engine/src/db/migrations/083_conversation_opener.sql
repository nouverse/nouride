-- Who opened a conversation: the first person who said something in it, as `[[people]]` writes an id
-- (`web:<account id>`, `telegram:814…`). Every account read every chat; a private chat is now its person's, and an
-- admin's. In a group or a room it says only who spoke first: who may read one is who spoke there.
--
-- NULL where nobody has spoken yet, and on a conversation whose turns are gone with their retention. A person is a
-- turn with no cause and a sender that is not the daemon's own (`nouride:system`) or another agent (`agent:<id>`).
ALTER TABLE sessions ADD COLUMN opened_by TEXT;

UPDATE sessions SET opened_by = (
  SELECT substr(t.gateway_id, 1, instr(t.gateway_id, ':') - 1) || ':' || t.sender_id
  FROM turn_records t
  WHERE t.session_id = sessions.id
    AND t.cause IS NULL
    AND t.sender_id IS NOT NULL AND t.sender_id <> ''
    AND t.sender_id <> 'nouride:system' AND t.sender_id NOT LIKE 'agent:%'
    AND instr(t.gateway_id, ':') > 1
  ORDER BY t.started_at, t.rowid
  LIMIT 1
);

CREATE INDEX idx_sessions_opened_by ON sessions(opened_by);

-- Which groups and rooms a person spoke in: their lines, by who said them.
CREATE INDEX idx_chat_messages_sender ON chat_messages(sender_id);
