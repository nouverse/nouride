/**
 * Where a coding CLI's version stands against the versions this Nouride was tested with (0.8.24, `CliRow.tested`) and the
 * newest its package has published: one decision, which `nouride agents scan`, `nouride doctor` and the dashboard read,
 * so the three say the same.
 *
 * Not a semver library: a CLI package's versions are `x.y.z`, a pre-release after a `-` sorting below its release. A
 * version of any other shape is no verdict, and nothing is said of it.
 */

/** Older than this Nouride supports; a newer version is out; up to date; newer than it was tested with. */
export type CliStanding = "older" | "update" | "current" | "newer";

export interface CliVersionView {
  standing: CliStanding;
  /**
   * What an update installs, where there is one: the newest version out, tested with this Nouride or not; where the
   * registry was not reached, the newest version this Nouride was tested with, which is out already. A version past the
   * tested ones was once kept back, and a new model in the CLI then reached a box only with a Nouride release.
   */
  offer?: string;
  /** `offer` is past every version this Nouride was tested with: offered all the same, and said. */
  offerUntested?: boolean;
  /** The CLI's own version that update brings, where the registry said and it is newer than the one installed. */
  brings?: string;
  /** The CLI's own newest version, where no connector out carries it yet: out, and not to be had by an update. */
  ahead?: string;
}

/** What the registry said is out: the connector's newest, the CLI's own version it carries, and the CLI's own newest. */
export interface CliOut {
  version?: string;
  carries?: string;
  own?: string;
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
 * `version` against `tested` and what is `out`, where the registry was reached. `own` is the CLI's own version as
 * installed, the connector's being `version`. Null where a version cannot be read.
 */
export function cliStanding(version: string, tested: { lowest: string; highest: string }, out: CliOut = {}, own?: string): CliVersionView | null {
  const low = compareCliVersions(version, tested.lowest);
  const high = compareCliVersions(version, tested.highest);
  if (low === null || high === null) return null;
  const newer = out.version !== undefined && compareCliVersions(out.version, version) === 1 ? out.version : undefined;
  // Nothing said of what is out: the tested versions are out already, and the newest of them is offered.
  const offer = newer ?? (out.version === undefined && high === -1 ? tested.highest : undefined);
  const offered = offer === undefined ? {} : { offer, ...(compareCliVersions(offer, tested.highest) === 1 ? { offerUntested: true } : {}) };
  const brings = newer !== undefined && out.carries !== undefined && (own === undefined || compareCliVersions(out.carries, own) === 1) ? { brings: out.carries } : {};
  // The CLI's own newest against what the newest connector carries: only where both were said.
  const ahead = out.own !== undefined && out.carries !== undefined && compareCliVersions(out.own, out.carries) === 1 ? { ahead: out.own } : {};
  const standing: CliStanding = low === -1 ? "older" : offer !== undefined ? "update" : high === 1 ? "newer" : "current";
  return { standing, ...offered, ...brings, ...ahead };
}
