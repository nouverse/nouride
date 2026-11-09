/**
 * The editions' old names, said only where they are mapped to the new ones.
 *
 * Device, Device Pro and Cloud became Pro and Pro Router on 2026-09-30, and before them the flags named what an edition
 * bundled (`--device-nougate`, `wa-nougate`). Pro Router became Pro in 0.7.20 (owner, 2026-10-19), and 0.8.0 reads its
 * name as nothing, like the others. No install carries an old name, and install.sh and the build refuse them,
 * so one in a doc tells a person to ask for an edition that does not exist, and one in code tests for an edition no
 * daemon reports. The register's bookkeeping found them in docs nobody had reread since the rename.
 *
 * Matched as names, not as words: `device` alone is an ordinary word (and an `nmcli` object), `normal` an old approval
 * level. The files below are the ones that say what each old name became, refuse it, or hold that refusal to a test —
 * each with why. An entry whose file no longer names any of them is reported, so the list only shrinks.
 */

/** An old edition's name, in each spelling it was used in: a flag, an image or artefact, a label, a quoted value. */
export const RETIRED_EDITION =
  /\bpro-router\b|\bPro Router\b|\b[Dd]evice-[Pp]ro\b|\bDevice Pro\b|\bdevice-nougate\b|\bwa-nougate\b|(?<![\w-])--(?:device|cloud)\b(?!-)|\bnouride-(?:device|cloud)\b|`(?:device|cloud)`|(?<![\w-])(?:[Dd]evice|[Cc]loud) edition|EDITION=(?:device|cloud)\b|["'](?:cloud|device-pro)["']/g;

export const MAPS_RETIRED_EDITIONS: Readonly<Record<string, string>> = {
  ".github/workflows/release.yml": "the editions' table, and what each old name and image became",
  ".github/workflows/ci-image.yml": "why the Cloud edition is no longer built there",
  "scripts/build/core.ts": "the retired flags, refused by name",
  "scripts/targets.ts": "why the release's asset check looked for a name the build never made",
  "scripts/pointers/editions.ts": "this rule, which has to spell them",
  "apps/engine/tests/contracts/check-pointers.test.ts": "plants each spelling, to hold this rule to it",
  "scripts/install.sh": "the old --variant names, refused like any other",
  "apps/dashboard/src/commons/lib/api.appliance.ts": "says the names that once meant a Box are carried by no daemon",
  "apps/dashboard/tests/paired-box.test.ts": "holds that an old name no longer makes a Box",
  "apps/dashboard/tests/update-badge.test.ts": "holds that the badge reads no old name as an edition",
  "apps/engine/tests/contracts/artifact-names.test.ts": "holds install.sh's refusal of each old name",
  "apps/engine/tests/contracts/build-flags.test.ts": "holds the build's refusal of each old flag, and the images' names",
  "internals/pro/docs/DISTRIBUTION.md": "the editions' history",
  "internals/pro/docs/APPLIANCE_UPDATES.md": "Nouverse Core still reads the old names, as the new ones",
  "internals/pro/docs/CARRY_OVER_FROM_0.7.md": "Core's old names and the old image, carried past 0.7",
  "internals/pro/docs/RUNBOOK_OWNER_AWAY.md": "the GHCR package still named after the Cloud edition",
  "internals/pro/packages/build-pro/README.md": "the build's retired flags",
  "internals/pro/packages/build-pro/editions.ts": "what the three Pro editions were before they became one",
  "internals/pro/packages/build-pro/flash/install.ts": "the box a bug was found on, by the edition it was then",
  "internals/pro/packages/appliance/src/ui/lib/messages.ts": "why the badge was renamed by hand, and what that broke",
  // Pro Router, retired in 0.7.20 and read as nothing since 0.8.0.
  "apps/dashboard/tests/bundled-gateway.test.ts": "holds that no dashboard source reads the name, the label included",
  "docs/SYSTEM_REQUIREMENTS.md": "a measurement, labelled by the edition's name when it was taken",
  "docs/SYSTEM_REQUIREMENTS.id.md": "a measurement, labelled by the edition's name when it was taken",
};

/** Lines of `text` naming a retired edition — empty for a file that maps them. */
export function retiredEditionLines(rel: string, text: string): number[] {
  if (rel in MAPS_RETIRED_EDITIONS) return [];
  const lines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.match(RETIRED_EDITION)) lines.push(i + 1);
  });
  return lines;
}

/** Entries for files that are gone or no longer name an old edition. `read` is undefined for a file not in the tree. */
export function staleEditionMaps(read: (rel: string) => string | undefined, absent: readonly string[]): string[] {
  return Object.keys(MAPS_RETIRED_EDITIONS).filter((rel) => {
    if (absent.some((dir) => rel.startsWith(dir))) return false;
    const text = read(rel);
    return text === undefined || !text.match(RETIRED_EDITION);
  });
}
