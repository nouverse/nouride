-- A fact its person kept to their direct chats. A person's own facts are read wherever they are the one speaking, a
-- group included, and one of them can be held back from groups by asking the agent: the line in their profile says
-- so, and this is that mark as the index keeps it. Nothing is marked by this: every fact there is follows the rule.
ALTER TABLE memory_facts ADD COLUMN readers_direct INTEGER NOT NULL DEFAULT 0;
