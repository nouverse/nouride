-- 0.8.30: whether a turn its provider ended told its person it would be tried again. The boot found the turns to retry
-- by the last sentence of their reply, so rewording that sentence would have left the promises made before it unfound.
-- 1 on a turn that promised; NULL on every other, and on a turn closed before the upgrade, which is still found by the
-- words it was told in (`modules/turns/close.ts`).
ALTER TABLE turn_records ADD COLUMN retry_promised INTEGER;
