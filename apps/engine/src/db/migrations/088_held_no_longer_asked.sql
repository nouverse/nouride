-- A run of a scheduled job is no longer held for a message to a chat that is not its job's: a person turned the job
-- on, and that is their yes to what it sends. What earlier runs kept of that hold, for a person to allow always, is a
-- question nobody is asked any more. Left on a run it showed under Recent runs with its button, beside newer runs that
-- held nothing, and read as the hold happening again. Taken off each run; what the second look held stays, as it is
-- still asked where the look is on. A run whose `held` is not JSON is left as it is.
UPDATE cron_runs
  SET held = (
    SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_array(json(kept.value)) END
    FROM json_each(cron_runs.held) AS kept
    WHERE coalesce(json_extract(kept.value, '$.reason'), '') NOT LIKE 'this run of a scheduled job sends to %'
  )
  WHERE held IS NOT NULL AND json_valid(held)
    AND EXISTS (SELECT 1 FROM json_each(cron_runs.held) AS one WHERE json_extract(one.value, '$.reason') LIKE 'this run of a scheduled job sends to %');
