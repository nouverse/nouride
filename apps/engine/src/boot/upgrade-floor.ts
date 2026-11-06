/**
 * This version starts only on data 0.8.0 has run on (`docs/DEPLOY.md` § The upgrade window).
 *
 * 0.8.0's first start brought what it still read forward on disk — the database to its schema, each pack's
 * `fallback_model` written as `fallbacks` — and recorded the version once the database was done (`last-run.ts`). This
 * version keeps none of those steps, so data no 0.8.0 has run on holds forms it no longer reads. Refused here, before
 * anything writes, with the way across; the update guard puts the previous build back when an update lands on such
 * data. `install.sh` refuses the same case before it installs (`check_floor`), and the updater of every version from
 * 0.7.11 is offered the last 0.7.x and then 0.8.0 on its way — this is for what reaches the binary anyway: a Docker tag
 * moved by hand, a tarball unpacked over an old install.
 *
 * Fresh data — no database yet — has nothing to bring forward and starts.
 */

import { fileExistsSync, join, readTextFileIfExists } from "@nouride/runtime";
import { ConfigError, NourideError } from "@nouride/shared";
import { crossTheFloor, EARLIER_FLOOR, UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";
import { configuredDataDir, loadGlobalConfig } from "@/modules/config/global/index.ts";
import { LAST_RUN_FILE, PENDING_FILE } from "./last-run.ts";

export class UpgradeFloorError extends NourideError {
  override name = "UpgradeFloorError";
  constructor(message: string) {
    super("upgrade_floor", message);
  }
}

/** The three numbers of a version, or null for one this cannot read — which reads as older, the side that loses nothing. */
function numbers(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function below(version: string, floor: string): boolean {
  const a = numbers(version);
  const b = numbers(floor);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** Refuses to go on when the data in `dataDir` has not been through the floor; says nothing and returns otherwise. */
export async function assertUpgradeFloor(dataDir: string): Promise<void> {
  if (!fileExistsSync(join(dataDir, "nouride.db"))) return;
  const last = (await readTextFileIfExists(join(dataDir, LAST_RUN_FILE)))?.split("\n")[0]?.trim() ?? "";
  if (last && !below(last, UPGRADE_FLOOR)) return;

  // A 0.7.x that could not finish its rewrites held the record back and named what was left: say that, not only
  // "install it first" — starting it again changes nothing until those are fixed.
  const pending = ((await readTextFileIfExists(join(dataDir, PENDING_FILE))) ?? "").split("\n").filter((line) => line.trim());
  const ran = last ? `last ran ${last.replace(/^v/, "")}` : "has no record of the version that last ran it (a release before 0.7.11)";
  const left =
    pending.length > 0
      ? `\nThe last 0.7.x that ran here could not bring these forward, and starting it again will not until they are fixed:\n` +
        pending.map((line) => `  - ${line}`).join("\n") +
        "\n"
      : "\n";
  // From before 0.8.0's own floor too: the last 0.7.x first, which brings 0.7's forms forward, then 0.8.0.
  const older = !last || below(last, EARLIER_FLOOR.floor);
  throw new UpgradeFloorError(
    `refusing to start: this release upgrades only from ${UPGRADE_FLOOR}, and the data in ${dataDir} ${ran}.\n` +
      `This version no longer reads the forms ${UPGRADE_FLOOR} brought forward on disk, so it would start on data it cannot read.${left}` +
      (older
        ? crossTheFloor("it brings the database, the memory vault, config.toml and every pack forward on disk", true)
        : crossTheFloor("it brings the database and every pack forward on disk")),
  );
}

/**
 * The config, loaded as `loadGlobalConfig` loads it — with the floor answering first when it will not load. For the
 * daemon's boot and for `nouride config check`, which says whether it would start.
 *
 * Data no 0.8.0 has run on may hold a config.toml in forms this version refuses. Refused for the first of them —
 * `[daemon] default_agent is gone` on a 0.7.7 volume, in the 0.8.0 upgrade run — a person fixes it by hand, then the
 * next, then meets the database's refusal; the way across is a start of the floor, so that is what is said. On data
 * past the floor, the config's own refusal stands.
 */
export async function loadConfigPastTheFloor(options: Parameters<typeof loadGlobalConfig>[1] = {}): ReturnType<typeof loadGlobalConfig> {
  try {
    return await loadGlobalConfig(undefined, options);
  } catch (err) {
    if (err instanceof ConfigError) {
      const dataDir = await configuredDataDir().catch(() => null);
      if (dataDir) await assertUpgradeFloor(dataDir);
    }
    throw err;
  }
}
