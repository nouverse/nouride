-- A mission's name for a person, apart from its goal. The goal is an instruction to the agent, written whole because
-- every turn starts from it, and it was also what a person read as the mission's name: on the cards of what waits for
-- them, in the list, in the chat's notices and on its page. A title is what the work is called, in a few words.
ALTER TABLE missions ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- Filled once for the missions already there, the way a mission started with no title is named from its goal
-- (`titleFromGoal`, `@nouride/shared`): the goal on one line, its first sentence without its closing stop, and past
-- 60 characters cut at a word with an ellipsis, or where the room ends when the last space comes before the 36th.
UPDATE missions SET title = (
  WITH flat(t) AS (
    SELECT trim(replace(replace(replace(replace(replace(replace(replace(goal, char(13), ' '), char(10), ' '), char(9), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))
  ),
  ends(t, at) AS (
    SELECT t, min(
      coalesce(nullif(instr(t, '. '), 0), 1000000),
      coalesce(nullif(instr(t, '! '), 0), 1000000),
      coalesce(nullif(instr(t, '? '), 0), 1000000)
    ) FROM flat
  ),
  first(t) AS (
    SELECT rtrim(CASE WHEN at < 1000000 THEN substr(t, 1, at) ELSE t END, '.') FROM ends
  ),
  cut(t, head, word) AS (
    SELECT t, substr(t, 1, 59), rtrim(rtrim(substr(t, 1, 59), replace(substr(t, 1, 59), ' ', ''))) FROM first
  )
  SELECT CASE
    WHEN length(t) <= 60 THEN t
    WHEN length(word) >= 36 THEN rtrim(word, ' ,;:') || '…'
    ELSE rtrim(head, ' ,;:') || '…'
  END FROM cut
);
