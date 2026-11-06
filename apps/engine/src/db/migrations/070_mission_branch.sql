-- 0.8.7: the branch a mission's worktree is made on, when the start named one. NULL is `mission/<id>`.
ALTER TABLE missions ADD COLUMN branch TEXT;
