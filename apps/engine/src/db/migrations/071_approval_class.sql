-- 0.8.9: the fixed list's entry an approval was asked under, so who may answer reads it from the row. NULL is none.
-- A persona change waiting across the upgrade keeps 0.8.8's rule: only an admin answers it.
ALTER TABLE approvals ADD COLUMN hardline_class TEXT;
UPDATE approvals SET hardline_class = 'persona' WHERE tool = 'persona';
-- A change to People an agent asked before the upgrade and still waiting was `access` then; it is an admin's alone now.
-- Read off its words as widely as they go: a row taken for one when it is not only asks an admin more. A row whose
-- params are not JSON is read as no words.
UPDATE approvals SET hardline_class = 'people'
  WHERE status = 'pending' AND tool = 'nouride'
    AND (
      EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(params) THEN params ELSE '{}' END, '$.args') AS word WHERE word.value = 'people')
      OR (
        EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(params) THEN params ELSE '{}' END, '$.args') AS word WHERE word.value = 'approve')
        AND EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(params) THEN params ELSE '{}' END, '$.args') AS word
          WHERE word.value IN ('--as', '--me', '--new') OR substr(word.value, 1, 5) = '--as=' OR substr(word.value, 1, 6) = '--new='
        )
      )
    );
-- So is a program for every agent waiting since then: `nouride tools run`, an admin's to answer from 0.8.9.
UPDATE approvals SET hardline_class = 'shared-tools'
  WHERE status = 'pending' AND tool = 'nouride' AND hardline_class IS NULL
    AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(params) THEN params ELSE '{}' END, '$.args') AS word WHERE word.value = 'tools')
    AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(params) THEN params ELSE '{}' END, '$.args') AS word WHERE word.value = 'run');
