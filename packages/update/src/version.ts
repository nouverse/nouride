/**
 * Comparing two versions, which is the whole of "is there something newer".
 *
 * Deliberately not a semver library. The only versions this ever sees are the ones this
 * project publishes — `0.3.2`, and a tag `v0.3.2` — and a dependency here would be a
 * dependency in a module whose entire point is having none.
 *
 * Pre-release suffixes are parsed and then ordered the simple way: a pre-release sorts
 * *below* the release of the same numbers, and two pre-releases compare as strings. That
 * is enough to stop `0.4.0-rc.1` being offered as an upgrade from `0.4.0`, which is the
 * only mistake in this area that would actually reach somebody.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Everything after a `-`, or empty for a release. */
  prerelease: string;
}

/**
 * Accepts `1.2.3`, `v1.2.3`, `1.2.3-rc.1`. Returns null for anything else.
 *
 * Null rather than a zero version: a tag nobody can parse must not silently become
 * `0.0.0` and make every install look out of date.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

/** -1, 0 or 1 — `a` older, same, newer. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // A release outranks any pre-release carrying the same numbers.
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Is `candidate` newer than `current`?
 *
 * False when either is unparseable, which is the safe direction: an install that cannot
 * read one of the two numbers should report "no update" rather than offer to replace
 * itself on the strength of a string it did not understand.
 */
export function isNewer(current: string, candidate: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (!a || !b) return false;
  return compareVersions(b, a) === 1;
}
