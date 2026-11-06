/**
 * The upgrade floor: 0.8.0, which every install starts once before this version (`docs/DEPLOY.md` § The upgrade
 * window). Every release after 0.8.0 has it — the owner's call once 0.8.0 shipped.
 *
 * That one start brought every form 0.8.0 still read forward — the database migrated to its schema, each pack's
 * `fallback_model` written as `fallbacks` — and this version carries none of those steps. Data in a form from before is
 * refused at start, with nothing written, and the refusal ends with the way across: these lines, so the database's,
 * the vault's and the record's say it the same way.
 *
 * 0.8.0 has a floor of its own, the last 0.7.x (`EARLIER_FLOOR`). Data from before that crosses both, and is told both
 * at once: sent to 0.8.0 alone it would only be refused again, and on Docker each refusal is a restart loop somebody
 * has to notice in the log.
 *
 * Docker is named on its own line because it has no update guard: an image that refuses the data restarts in a loop
 * until somebody reads the log, so the log has to say which image to run instead. The floor's own tag, `0.8.0`: `0.8`
 * moves to every 0.8.x, this one too.
 */

export const UPGRADE_FLOOR = "0.8.0";

/**
 * 0.8.0's floor: it starts only on data `floor` or a later 0.7.x has run on. `take` is the 0.7.x to install for it — the
 * last one, which the `0.7` image is.
 */
export const EARLIER_FLOOR = { floor: "0.7.28", take: "0.7.29", image: "ghcr.io/nouverse/nouride:0.7" } as const;

/**
 * The way across the floor, for a refusal to end with — `does` is what that one start does to what was refused. With
 * `older`, data from before 0.8.0's own floor: the last 0.7.x first, whose start is what `does` says, then 0.8.0.
 */
export function crossTheFloor(does: string, older = false): string {
  const image = `ghcr.io/nouverse/nouride:${UPGRADE_FLOOR}`;
  if (!older) {
    return (
      `  → install ${UPGRADE_FLOOR} and start it once (${does}, after a snapshot), then this version again\n` +
      `  → on Docker: run ${image} once on the same volume, then this image again`
    );
  }
  return (
    `  → install ${EARLIER_FLOOR.take} and start it once (${does}, after a snapshot), then ${UPGRADE_FLOOR} once, then this version again\n` +
    `  → on Docker: run ${EARLIER_FLOOR.image} once on the same volume, then ${image} once, then this image again`
  );
}
