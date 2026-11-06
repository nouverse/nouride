-- 0.8.11: a mission's result, two or three sentences, the chat's text when it ends — beside its report, which is sent
-- whole as `report.md`. Kept on the record because the notice is built after the checks and the review, across a restart.
ALTER TABLE missions ADD COLUMN summary TEXT;
