/**
 * Asking the channel what has been released, and which of it is for *this* build.
 *
 * `get.nouride.com` is a redirector in front of the public release repository, so the tarball
 * URL shape is stable (`<base>/<tag>/<artifact>.tar.gz`, with `latest` as a path segment rather
 * than a redirect) but it publishes no version manifest. Versions therefore come from the
 * releases API of the public mirror, which needs no token because that repository is public —
 * deliberately separate from the private one this is built in.
 *
 * ## The newest release is not the newest release *for you*
 *
 * This is the part that decides whether a community install is offered something it cannot
 * have. A release carries one set of artifacts, and which ones depends on what was built: the
 * public mirror receives the free edition's tarballs and nothing else. So a version can exist
 * without existing for this edition — a Pro-only release, a run where the public job did not
 * publish — and reading only the newest *tag* would tell a community install it is out of date
 * and then fail it at the download.
 *
 * So the question asked here is "which is the newest release whose assets include the file this
 * build would need", answered from the release list's own asset names. Exact, one request, and
 * no guessing from a URL that may 404.
 */

import { signatureName } from "./signing.ts";
import type { UpdateTrack } from "./track.ts";
import { compareVersions, parseVersion } from "./version.ts";

/** Where the public GitHub channel lives: its download host and its releases API. */
export interface ReleaseChannel {
  /** Where tarballs live. `https://get.nouride.com`. */
  downloadBase: string;
  /** The public mirror's releases API, its first page; the rest are read by `page` (`fetchReleases`). */
  releasesUrl: string;
}

/**
 * A hundred a page, GitHub's most, so the whole mirror is still one request. Every updater before 0.8.18 read one page
 * of thirty and nothing past it, so a bridge release pushed off that page stranded every install below it;
 * the mirror is kept short for them, and this reads every page.
 */
export const DEFAULT_CHANNEL: ReleaseChannel = {
  downloadBase: "https://get.nouride.com",
  releasesUrl: "https://api.github.com/repos/nouverse/nouride/releases?per_page=100",
};

/** Pages read at most: a thousand releases at a hundred a page, far past the mirror, and a bound on a looping channel. */
const MAX_PAGES = 10;

/** The page size the URL asks for, GitHub's thirty when it names none: a page shorter than that is the last. */
function pageSize(url: string): number {
  const asked = /[?&]per_page=(\d+)/.exec(url);
  return asked ? Number(asked[1]) : 30;
}

const pageUrl = (url: string, page: number) => (page === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${page}`);

/**
 * Newest version first, whatever order the channel listed them in. The API lists by date, so a patch to an older line
 * published after a newer release came first and was taken as the newest. A tag that is not a version
 * goes last, in the order it came.
 */
export function newestFirst(releases: Release[]): Release[] {
  return releases
    .map((release, index) => ({ release, index, version: parseVersion(release.tag) }))
    .sort((a, b) => (a.version && b.version ? compareVersions(b.version, a.version) || a.index - b.index : a.version ? -1 : b.version ? 1 : a.index - b.index))
    .map(({ release }) => release);
}

export interface Release {
  /** The tag, as published — `v0.3.2`. */
  tag: string;
  /** ISO 8601, or null when the channel did not say. */
  publishedAt: string | null;
  /** Where a human reads what changed. */
  notesUrl: string | null;
  /** Asset file names. This is what decides whether a release is for this build. */
  assets: string[];
}

/** Everything this module needs from the outside world, so a test can hand it a fake. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * How long an answer from the channel is reused.
 *
 * Five minutes, and the number is not a guess. The unauthenticated GitHub API allows **60
 * requests an hour per address**, and the dashboard polls `GET /update` once a second while a
 * download runs — so a single 70-second download made 70 calls, exhausted the hour's budget,
 * and every check after it answered 403 including the one the install does. Which is how a
 * finished download met "the release channel answered 403" instead of installing.
 *
 * Releases are published a few times a week. Asking more than twelve times an hour buys
 * nothing, and asking once a second buys an outage.
 */
const CACHE_TTL_MS = 5 * 60_000;

interface Cached<T> {
  at: number;
  key: string;
  value: T;
}

let releaseCache: Cached<Release[]> | null = null;
/** By URL, a few: the upgrade floor can read the newest release's file and the stepping stone's in one check (`floor.ts`). */
const checksumCache = new Map<string, Cached<string | null>>();
const CHECKSUM_CACHE_SIZE = 8;

/**
 * A failure is remembered too, and for a shorter time.
 *
 * Without this, a channel that is down is asked again on *every* request — and the page polls
 * once a second while a download runs. That is the behaviour that exhausted the hourly limit in
 * the first place, so leaving it in place for the failure path would mean a rate-limited daemon
 * spending its recovery hammering the thing that rate-limited it.
 *
 * A minute rather than five: this is the path that should recover quickly once the channel
 * comes back, and a minute of holding one error costs nothing but bounds the retries to sixty
 * an hour — which is, not coincidentally, the whole budget.
 */
const FAILURE_TTL_MS = 60_000;

let failureCache: Cached<string> | null = null;

/** For tests. The "Check again" button passes `force` instead, which skips the cache without dropping it. */
export function forgetChannel(): void {
  releaseCache = null;
  checksumCache.clear();
  failureCache = null;
  lastError = null;
}

/**
 * Every published release, on every page, in the channel's order (`newestFirst` sorts them), with drafts and
 * pre-releases left out.
 *
 * Throws with the status rather than returning an empty list on a bad response: "the channel
 * answered 403" and "there is nothing newer" are answers a person acts on differently, and
 * collapsing them is how a rate-limited check starts reporting that everything is up to date.
 *
 * Cached — see {@link CACHE_TTL_MS}. `force` is what the Check again button passes.
 */
export async function fetchReleases(
  channel: ReleaseChannel,
  fetchImpl: FetchLike,
  options: { force?: boolean; now?: number } = {},
): Promise<Release[]> {
  const now = options.now ?? Date.now();
  if (
    !options.force &&
    releaseCache &&
    releaseCache.key === channel.releasesUrl &&
    now - releaseCache.at < CACHE_TTL_MS
  ) {
    return releaseCache.value;
  }

  /**
   * A recent failure answers for itself rather than becoming another request.
   *
   * Only when there is no cached success to fall back on — with one, the stale answer is
   * better than an error and is returned below.
   */
  if (
    !options.force &&
    !releaseCache &&
    failureCache &&
    failureCache.key === channel.releasesUrl &&
    now - failureCache.at < FAILURE_TTL_MS
  ) {
    throw new Error(failureCache.value);
  }

  const releases: Release[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = pageUrl(channel.releasesUrl, page);
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        // Named so a rate-limit log on the other end says who it was.
        "user-agent": "nouride-update",
      },
    });
    if (!response.ok) {
      /**
       * A failed ask is not the same as knowing nothing.
       *
       * If the channel answered at some point, that answer is still the best information there
       * is — releases do not un-publish — and "the channel is unreachable, here is what it said
       * twenty minutes ago" is more use than "unknown". The staleness travels with it so nothing
       * downstream presents it as fresh.
       *
       * The case that made this worth having: an hour of rate limiting, during which the page
       * would otherwise have had nothing at all to show. A later page failing is the same failure: the list it leaves
       * is short, and a short list can hide the release that matters.
       */
      const message = describe(response.status, url);
      if (releaseCache && releaseCache.key === channel.releasesUrl) {
        lastError = message;
        return releaseCache.value;
      }
      failureCache = { at: now, key: channel.releasesUrl, value: message };
      throw new Error(message);
    }

    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("the release channel did not return a list of releases");

    let added = 0;
    for (const entry of body as Record<string, unknown>[]) {
      if (entry.draft === true || entry.prerelease === true) continue;
      const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      added++;
      const assets = Array.isArray(entry.assets)
        ? (entry.assets as Record<string, unknown>[])
            .map((asset) => (typeof asset.name === "string" ? asset.name : ""))
            .filter(Boolean)
        : [];
      releases.push({
        tag,
        publishedAt: typeof entry.published_at === "string" ? entry.published_at : null,
        notesUrl: typeof entry.html_url === "string" ? entry.html_url : null,
        assets,
      });
    }
    // A page shorter than the size asked for is the last; drafts and pre-releases skipped above still count in it. A
    // page that adds nothing is a channel ignoring `page` and answering the first again: stop rather than read it ten times.
    if (body.length < pageSize(channel.releasesUrl) || (added === 0 && page > 1)) break;
  }
  releaseCache = { at: now, key: channel.releasesUrl, value: releases };
  failureCache = null;
  lastError = null;
  return releases;
}

/**
 * 403 from this API is almost always the hourly rate limit rather than a permission problem,
 * and the two need different things from a person: one is "wait", the other is "the repository
 * moved or went private". Saying which saves the wrong investigation.
 */
function describe(status: number, url: string): string {
  const hint = status === 403 ? ". This is usually the hourly rate limit; it resets within the hour" : "";
  return `the release channel answered ${status} (${url})${hint}`;
}

/** Set when the last ask failed and a cached answer was served instead. */
let lastError: string | null = null;

/** Why the answer in hand is older than it should be, or null when it is current. */
export function channelStaleness(): string | null {
  return lastError;
}

/**
 * Where releases come from, as the rest of this plugin sees it.
 *
 * The public GitHub mirror was the only answer, as a constant nothing could override — so an
 * edition whose builds are not mirrored there (Device, and the Pro editions) had nowhere else to look, and a
 * box that had shipped could never update. A source is
 * the question behind that constant: what has been released, and where each file is.
 *
 * Everything that decides whether an update is *safe* stays in this plugin whatever the source:
 * the release has to carry this edition's artefact and a checksum file that covers it, the download
 * is verified against that checksum before anything moves, and the swap keeps the previous version.
 * A source only answers where. That is why one supplied from outside — the appliance's, which asks
 * the Nouverse service and downloads from short-lived storage URLs — cannot weaken any of it.
 *
 * {@link githubSource} is the default, and every public edition keeps it.
 */
export interface ReleaseSource {
  /** For logs and the dashboard: `github`, `appliance`. */
  readonly name: string;
  /**
   * Whether `releases()` is everything this channel publishes, for every edition and target. The public mirror's list
   * is; the appliance's is what the Nouverse service offers one box. Only a complete list can say that a build none
   * of its releases carries is not published here at all (`checkForUpdate`). Absent means not.
   */
  readonly complete?: boolean;
  /**
   * Published releases, in any order: the check sorts them by version (`newestFirst`). May be cached; `force` asks now.
   * `track` is the install's (`track.ts`): a source that chooses for the install, the appliance's, asks within it; one
   * that lists everything, the mirror's, ignores it and the check applies it.
   */
  releases(options?: { force?: boolean; track?: UpdateTrack }): Promise<Release[]>;
  /** Where `<artifact>.tar.gz` of `tag` is downloaded from. */
  tarballUrl(tag: string, artifact: string): string;
  /** Where that release's checksum file is. */
  checksumUrl(tag: string, checksums: string): string;
  /**
   * Where the signature over that checksum file is, when this source publishes one (see
   * `signing.ts`). Required for the private editions; on the public GitHub channel, used where a
   * release lists one.
   */
  signatureUrl?(tag: string, checksums: string): string;
  /** Why the releases in hand are older than they should be, or null when current. */
  staleness(): string | null;
  /**
   * What the channel said about this install that is neither an outage nor a refusal — a Pro licence past its year
   * of updates, which keeps working and is offered only critical releases. Null when there is nothing to say.
   */
  notice?(): string | null;
}

/** The public mirror, as a {@link ReleaseSource}. Exactly the behaviour this plugin always had. */
export function githubSource(channel: ReleaseChannel = DEFAULT_CHANNEL, fetchImpl: FetchLike = fetch as never): ReleaseSource {
  return {
    name: "github",
    // Every public release is on the mirror, and nothing else ever is: the Pro editions are never attached to it.
    complete: true,
    releases: (options = {}) => fetchReleases(channel, fetchImpl, options),
    tarballUrl: (tag, artifact) => tarballUrl(channel, tag, artifact),
    checksumUrl: (tag, checksums) => checksumUrl(channel, tag, checksums),
    // Beside the checksum file, from 0.7.4 on. Asked for only where a release lists it (`planUpdate`).
    signatureUrl: (tag, checksums) => checksumUrl(channel, tag, signatureName(checksums)),
    staleness: channelStaleness,
  };
}

/**
 * The newest release that actually carries this edition's tarball *and* its checksums.
 *
 * Both, not just the tarball: the checksum file is what the install is verified against, and a
 * release with one and not the other is one that would fail after the download rather than
 * before it.
 *
 * `null` when nothing published carries them — which is a real and correct answer for an
 * edition whose builds are not mirrored to this channel, and the whole reason this function
 * exists rather than reading the newest tag.
 */
export function newestCarrying(releases: Release[], artifact: string, checksumsIn: (tag: string) => string): Release | null {
  return (
    releases.find(
      (release) => release.assets.includes(`${artifact}.tar.gz`) && release.assets.includes(checksumsIn(release.tag)),
    ) ?? null
  );
}

/** `<base>/<tag>/<artifact>.tar.gz`, the one URL shape the installer also builds. */
function tarballUrl(channel: ReleaseChannel, tag: string, artifact: string): string {
  return `${channel.downloadBase.replace(/\/$/, "")}/${tag}/${artifact}.tar.gz`;
}

export function checksumUrl(channel: ReleaseChannel, tag: string, checksums: string): string {
  return `${channel.downloadBase.replace(/\/$/, "")}/${tag}/${checksums}`;
}

/**
 * The release's checksum file, as text.
 *
 * Fetched during the *check* and not only at install time, because a release can carry a
 * tarball the checksum file does not cover — the published `SHA256SUMS` lists the four Linux
 * builds and not the two macOS ones, so a Mac install was offered an update, downloaded 55 MB
 * of it, and met "no checksum for nouride-darwin-arm64.tar.gz" at the verify step. Found by
 * running the flow rather than by reading the workflow.
 *
 * A few hundred bytes, and only when something newer exists.
 */
export async function fetchChecksums(
  url: string,
  fetchImpl: typeof fetch,
  options: { force?: boolean; now?: number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now();
  const cached = checksumCache.get(url);
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const response = await fetchImpl(url);
    const text = response.ok ? await response.text() : null;
    checksumCache.delete(url);
    checksumCache.set(url, { at: now, key: url, value: text });
    // The oldest first out: a Map iterates in insertion order.
    if (checksumCache.size > CHECKSUM_CACHE_SIZE) checksumCache.delete(checksumCache.keys().next().value!);
    return text;
  } catch {
    return null;
  }
}
