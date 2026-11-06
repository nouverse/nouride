-- 0.8.10: what a person told a mission while it worked (`tell`), each with whether and in which turn it was read.
ALTER TABLE missions ADD COLUMN told TEXT NOT NULL DEFAULT '[]';
