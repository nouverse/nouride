-- 0.8.30: when a turn's person was asked whether to carry on. A turn a restart cut off is taken up by itself only when it
-- was cut off minutes ago; one cut off longer ago was left where it stopped and its person, told "I'll carry on once I'm
-- back", heard nothing more. Now they are asked, once: this is the once. NULL on every turn never asked about, and on
-- every turn from before the upgrade. A turn with a time here is its person's to take up, never the daemon's by itself.
ALTER TABLE turn_records ADD COLUMN resume_asked_at INTEGER;
