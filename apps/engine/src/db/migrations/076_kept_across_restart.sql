-- 0.8.18: a conversation's `/model` and `/effort`, on its row so a restart keeps them. Held in memory, every restart
-- dropped them, and the daemon restarts at every update. NULL is none: the agent's own. One set before the upgrade is
-- gone, as a restart left it before.
ALTER TABLE sessions ADD COLUMN model_override TEXT;
ALTER TABLE sessions ADD COLUMN effort_override TEXT;
-- 0.8.18: what only the process that asked an approval knew (who asked, its turn, the grant "always" writes), as JSON on
-- the approval's row from the moment it is asked. It was handed to the next process in a file at a clean shutdown only,
-- so a crash or a kill lost it. NULL is none on the row: one asked before the upgrade, which that file may still hold.
ALTER TABLE approvals ADD COLUMN extras_json TEXT;
