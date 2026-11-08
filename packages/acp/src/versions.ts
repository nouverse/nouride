/**
 * Where a coding CLI's version stands against the versions this Nouride was tested with (0.8.24, `CliRow.tested`) and the
 * newest its package has published: one decision, which `nouride agents scan`, `nouride doctor` and the dashboard read,
 * so the three say the same.
 *
 * Not a semver library: a CLI package's versions are `x.y.z`, a pre-release after a `-` sorting below its release. A
 * version of any other shape is no verdict, and nothing is said of it.
 */

/** Older than this Nouride supports; a newer version it was tested with is out; up to date; newer than it was tested with. */
export type CliStanding = "older" | "update" | "current" | "newer";

export interface CliVersionView {
  standing: CliStanding;
  /** What an update installs, where there is one to offer: the newest version this Nouride was tested with. */
  offer?: string;
  /** The newest published, where it is past every version this Nouride was tested with: out, and not tried. */
  untested?: string;
}

function parse(raw: string): { numbers: [number, number, number]; pre: string } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" } : null;
}

/** -1, 0 or 1 as `a` is older, the same or newer than `b`; null where either is not a version. */
function compareCliVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i]! < y.numbers[i]! ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  // A release outranks a pre-release of the same numbers: 0.101.1-preview.7 is not newer than 0.101.1.
  if (x.pre === "") return 1;
  if (y.pre === "") return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * `version` against `tested`, and `newest` where the registry was reached — absent, nothing is said of what is out but
 * the versions this Nouride was tested with, which are out already. Null where a version cannot be read.
 */
export function cliStanding(version: string, tested: { lowest: string; highest: string }, newest?: string): CliVersionView | null {
  const low = compareCliVersions(version, tested.lowest);
  const high = compareCliVersions(version, tested.highest);
  if (low === null || high === null) return null;
  const past = newest !== undefined && compareCliVersions(newest, tested.highest) === 1 ? { untested: newest } : {};
  if (low === -1) return { standing: "older", offer: tested.highest, ...past };
  if (high === 1) return { standing: "newer" };
  if (high === -1) return { standing: "update", offer: tested.highest, ...past };
  return { standing: "current", ...past };
}
