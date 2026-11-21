-- What skill learning shows a person, counted. A class of work seen once is held as a candidate: how many times it has
-- been seen is said beside it. A skill's reads were kept as one moment, the last: how often it is read, and how often
-- since it was last changed, is what says a lesson written into it is being used. Reads are counted from here on. A
-- candidate that existed is given the sightings the audit log still holds of it (`skill_candidate_held`, one row a
-- sighting, kept for `audit_days`), and one where it holds none: fewer than there were for an old one, never more.
ALTER TABLE skill_candidates ADD COLUMN sightings INTEGER NOT NULL DEFAULT 1;
UPDATE skill_candidates SET sightings = max(1, (SELECT count(*) FROM audit_log WHERE action = 'skill_candidate_held' AND json_extract(details, '$.skill') = skill_candidates.name));
ALTER TABLE skill_reads ADD COLUMN reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_reads ADD COLUMN reads_since_change INTEGER NOT NULL DEFAULT 0;
