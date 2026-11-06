/**
 * Checking for a newer Nouride, and installing one over this install.
 *
 * ## Why this is a plugin
 *
 * Not for the reason `internals/pro/packages/oauth` and `internals/pro/packages/multi-user` are. Those draw a *licence*
 * boundary: they are externalised out of the free build so a published binary provably does not
 * contain them. This one is linked into **every** edition — an install that cannot tell you it
 * is out of date is worse in the free edition than anywhere else.
 *
 * Open, like the rest of `packages/`: how this daemon replaces itself — the channel it trusts, the
 * way it verifies a download, the order it swaps files in — is the part of the system with the
 * most direct route to running someone else's code on the host, and so the part people most need
 * to be able to read.
 *
 * ## One dependency: `@nouride/runtime`
 *
 * The host is reached through the runtime, like every package here (TD-001); nothing else of this
 * repository's is imported. The shapes the engine needs are declared by hand on its side and
 * `apps/engine/tests/daemon/update-external.test.ts` fails when they drift.
 *
 * ## Three steps, because two of them are decisions
 *
 * `check` reads and changes nothing. `download` fills a `.part` file beside the install and can
 * be paused and picked up again — on a Raspberry Pi over a home connection a release takes the
 * better part of a minute, which is long enough for "not now" to be a real answer. `install`
 * verifies what was downloaded, swaps it in, and is the one that ends the process.
 *
 * Splitting the last two is not decoration: they are separate confirmations because they have
 * separate consequences. Downloading costs bandwidth and disk; installing costs the daemon.
 *
 * The one thing deliberately left outside is the **approval**. An update runs somebody else's
 * binary as this daemon's user, so it is gated in the engine, on the fixed list of what always asks (`replace`) —
 * never grantable, and refused when there is nobody to ask and the level does not answer it. That belongs with the
 * rest of the list rather than here, where a plugin edit could quietly widen it.
 *
 * Marker string for `assertEmbedded` in `scripts/build/core.ts`:
 * "update provider active in this daemon process"
 * This sentence exists here and nowhere else in the tree.
 */

export type { ParsedVersion } from "./version.ts";
export {
  checksumName,
  type Delivery,
  type Edition,
  type TargetFacts,
} from "./edition.ts";
export {
  checksumUrl,
  githubSource,
  type FetchLike,
  type Release,
  type ReleaseChannel,
  type ReleaseSource,
} from "./release.ts";
export type { InstallFacts, UpdatePlan } from "./plan.ts";
export { installStaged, type ApplyReport } from "./install.ts";
export { requiresSignature } from "./signing.ts";
export type { UpdateTrack } from "./track.ts";
export { ReleaseDownload, type DownloadSnapshot, type DownloadStatus } from "./download.ts";

import { artifactName, checksumName, targetFor } from "./edition.ts";
import {
  DEFAULT_CHANNEL,
  fetchChecksums,
  githubSource,
  newestCarrying,
  newestFirst,
  type Release,
  type ReleaseChannel,
  type ReleaseSource,
} from "./release.ts";
import { onTrack, type UpdateTrack } from "./track.ts";
import { hasChecksumFor } from "./install.ts";
import { planUpdate, type InstallFacts, type UpdatePlan } from "./plan.ts";
import { isNewer } from "./version.ts";
import { floorMessage, meetsFloor, releaseFloor, steppingStone } from "./floor.ts";

/**
 * Human-readable capability description.
 *
 * Used as the `assertEmbedded` marker in `scripts/build/core.ts`: its presence in a compiled binary
 * proves the plugin was linked. There is no `assertAbsent` counterpart, because unlike the other
 * two plugins there is no edition this is meant to be missing from.
 */
export const UPDATE_CAPABILITY = "update provider active in this daemon process" as const;

/**
 * Verification function called by the engine's boot resolver.
 *
 * Calling this ensures that Bun's dead-code eliminator does not strip {@link UPDATE_CAPABILITY}
 * when minifying the compiled binary.
 */
export function verifyUpdateProvider(): string {
  return UPDATE_CAPABILITY;
}

export interface UpdateCheck {
  current: string;
  /**
   * The newest release that carries a build **for this edition**, or the current version when
   * there is none.
   *
   * This is the one the button acts on, and it is deliberately not the newest tag. The public
   * channel receives the free edition's tarballs and nothing else, so a release can exist
   * without existing for this build — and telling a community install it is out of date over a
   * version it can never have is the failure this field exists to prevent.
   */
  latest: string;
  /** Whether {@link latest} is actually newer. False also when either version did not parse. */
  newer: boolean;
  /** The track this check followed (`[update] track`): {@link latest} is the newest release on it. */
  track: UpdateTrack;
  /**
   * The newest release on the other track, when it is newer than this version and is not {@link latest}: on `lts`, the
   * newer line it does not move to ("1.1.0, new"); on `latest`, the long-term line's newest. Absent while both tracks
   * offer the same, as they do until a long-term line has a newer one beside it.
   */
  otherTrack?: { track: UpdateTrack; tag: string };
  publishedAt: string | null;
  notesUrl: string | null;
  /**
   * The newest tag on the channel, whatever it was built for.
   *
   * Present only when it differs from {@link latest} — which is exactly the case worth saying
   * out loud: "v0.4.0 exists and there is no build of it for you" is information, and silence
   * about it looks like the check is broken.
   */
  latestElsewhere?: string;
  /** Why {@link latestElsewhere} is not an update here — no build for this edition, or none verifiable. */
  blockedReason?: string;
  /** Set when the channel could not be reached and this is the last answer it gave. */
  stale?: string;
  /** What the channel says about this install that is not an outage: a licence whose updates ended. */
  notice?: string;
  /** What an update would do here, or why it cannot. Present whenever something is newer. */
  plan?: UpdatePlan;
  /**
   * Set when the newest release for this edition has a floor above this version (`floor.ts`): it cannot be installed
   * over this one. {@link latest} is then the stepping stone — the newest release whose own floor this version meets —
   * or this version, when the channel lists none.
   */
  floor?: UpdateFloor;
}

export interface UpdateFloor {
  /** The release this install cannot take yet. */
  release: string;
  /** The version that has to have run first. */
  needs: string;
  /** "update to 0.7.14 first; 0.8.0 needs it" — what the CLI, the dashboard and an agent say. */
  message: string;
}

export interface CheckOptions {
  facts: InstallFacts;
  /** Where releases come from. The public GitHub channel when absent — see {@link ReleaseSource}. */
  source?: ReleaseSource;
  /** The GitHub channel to build the default source from; tests point it at a fake. */
  channel?: ReleaseChannel;
  /** Which releases this install follows (`[update] track`, `track.ts`): `latest` when absent. */
  track?: UpdateTrack;
  fetchImpl?: typeof fetch;
  /**
   * Skip the five-minute cache and ask the channel now.
   *
   * What the dashboard's "Check again" button passes, and nothing else does — a poll that
   * forced would be the rate-limit outage this cache exists to prevent, wearing a flag.
   */
  force?: boolean;
}

/**
 * The one call the engine makes for "is there an update, and could we take it".
 *
 * Both halves in one answer on purpose. A check that only reported a version number left every
 * caller — the CLI, the dashboard, an agent — to work out separately whether this install could
 * act on it, and they would not have agreed.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const source = options.source ?? githubSource(options.channel ?? DEFAULT_CHANNEL, fetchImpl as never);
  const track = options.track ?? "latest";
  // By version, whatever order the channel gave (`newestFirst`), then what the track offers (`onTrack`).
  const everything = newestFirst(await source.releases({ force: options.force ?? false, track }));
  const releases = onTrack(everything, options.facts.version, track);

  const facts = options.facts;
  const target = targetFor(facts);
  const artifact = target ? artifactName(facts.edition, target) : null;
  // Per release: `SHA256SUMS` up to the last 0.7.x, `CHECKSUMS` from 0.8.0 (`CHECKSUMS_RENAMED_IN`).
  const checksumsIn = (tag: string) => checksumName(facts.edition, tag);

  /**
   * A platform with no published tarball is matched on the tag alone.
   *
   * No release will ever carry a file for it, so asset matching would report "up to date" for ever.
   * The tag is the honest answer there, and the plan refuses the update anyway with what does work.
   */
  let forThisEdition: Release | null =
    artifact ? newestCarrying(releases, artifact, checksumsIn) : (releases[0] ?? null);

  /**
   * No release on a complete channel carries this build, the newest or any before it: the channel does not publish it.
   * The Pro editions on the public mirror, which never carries them, and a macOS install, for which no release has a
   * build. Read as "up to date" that was the wrong answer — an off-box Pro server was told it while it missed fixes —
   * so it is matched on the tag, like a platform with no target, and the plan says why this install cannot take the
   * newer release and what does work: which of the two it is, from whether the channel carries the edition at all.
   *
   * Only a complete list says so (`ReleaseSource.complete`). The appliance's lists what is offered to one box, where
   * a release carrying no build for it is one the box is not offered, as before.
   */
  let unpublished: "edition" | "target" | undefined;
  const carriedAnywhere = releases.some((release) => release.assets.includes(`${artifact}.tar.gz`));
  if (source.complete && artifact && !forThisEdition && releases.length > 0 && !carriedAnywhere) {
    unpublished = releases.some((release) => release.assets.includes(checksumsIn(release.tag))) ? "target" : "edition";
    forThisEdition = releases[0] ?? null;
  }

  /**
   * Carrying the file is not the same as covering it.
   *
   * The published checksum file lists the four Linux builds and not the two macOS ones, so a
   * Mac install matched on assets, downloaded 55 MB, and met "no checksum for
   * nouride-darwin-arm64.tar.gz" at the verify step. The verify is right to refuse — an
   * unverified binary is not one to run — so the *check* has to know the same thing, before
   * anything is moved. A few hundred bytes, and only when something newer exists.
   */
  let unverifiable: string | null = null;
  let floor: UpdateFloor | undefined;
  if (forThisEdition && artifact && isNewer(facts.version, forThisEdition.tag)) {
    /**
     * The edition's own checksum file — or, on a channel with no build of this edition, whichever one the release
     * lists: the floor is the release's, and every checksum file of it carries the same line. An off-box Pro server
     * is pointed at a release by hand, and the one it is pointed at has to be one it may take.
     */
    const covers = (text: string) => unpublished !== undefined || hasChecksumFor(text, artifact);
    const read = async (release: Release): Promise<string | null> => {
      const name = unpublished ? release.assets.find((asset) => /^(SHA256SUMS|CHECKSUMS)(-[\w-]+)?$/.test(asset)) : checksumsIn(release.tag);
      return name ? await fetchChecksums(source.checksumUrl(release.tag, name), fetchImpl, { force: options.force ?? false }) : null;
    };
    const text = await read(forThisEdition);
    if (text !== null && !covers(text)) {
      unverifiable = forThisEdition.tag;
      forThisEdition = null;
    } else if (text !== null && !meetsFloor(facts.version, releaseFloor(text))) {
      const blocked = forThisEdition.tag;
      const needs = releaseFloor(text)!;
      const carries = (release: Release) =>
        unpublished !== undefined || (release.assets.includes(`${artifact}.tar.gz`) && release.assets.includes(checksumsIn(release.tag)));
      const older = releases.slice(releases.indexOf(forThisEdition) + 1).filter((release) => carries(release) && isNewer(facts.version, release.tag));
      forThisEdition = await steppingStone(older, facts.version, async (release) => {
        const sums = await read(release);
        return sums !== null && covers(sums) ? releaseFloor(sums) : undefined;
      });
      floor = { release: blocked, needs, message: floorMessage(blocked, needs, forThisEdition?.tag ?? null) };
    }
  }

  const newestAnywhere = releases[0] ?? null;
  const latest = forThisEdition?.tag ?? facts.version;
  const newer = isNewer(facts.version, latest);

  const check: UpdateCheck = {
    current: facts.version,
    latest,
    newer,
    track,
    publishedAt: forThisEdition?.publishedAt ?? null,
    notesUrl: forThisEdition?.notesUrl ?? null,
  };

  // What the other track would offer, carried for this edition as the choice above is: the page offers both when both
  // exist ("1.0.7, LTS: fixes only" and "1.1.0, new"), and `nouride update` says the other is there.
  const otherName: UpdateTrack = track === "lts" ? "latest" : "lts";
  const otherList = onTrack(everything, facts.version, otherName);
  const other = artifact ? newestCarrying(otherList, artifact, checksumsIn) : (otherList[0] ?? null);
  if (other && other.tag !== latest && isNewer(facts.version, other.tag)) check.otherTrack = { track: otherName, tag: other.tag };

  if (newestAnywhere && newestAnywhere.tag !== latest && isNewer(facts.version, newestAnywhere.tag)) {
    check.latestElsewhere = newestAnywhere.tag;
    check.blockedReason =
      unverifiable === newestAnywhere.tag
        ? `it publishes ${artifact}.tar.gz but its checksum file does not cover it, so the download could not be verified`
        : floor?.release === newestAnywhere.tag
          ? `it upgrades only from ${floor.needs} or later, which this install has to run first`
          : `it carries no build for the ${facts.edition} edition on ${facts.platform}/${facts.arch}`;
  }
  if (floor) check.floor = floor;
  if (newer) {
    check.plan = planUpdate({ facts, tag: latest, source, ...(unpublished ? { unpublished } : {}), ...(forThisEdition ? { assets: forThisEdition.assets } : {}) });
  }
  const stale = source.staleness();
  if (stale) check.stale = stale;
  const notice = source.notice?.();
  if (notice) check.notice = notice;
  return check;
}
