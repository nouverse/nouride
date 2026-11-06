/**
 * Whether this daemon is the newest one, and the three calls that change that.
 *
 * Split out of `api.ts` for the reason `api.setup.ts` and `api.skills.ts` were — that file is
 * over its line budget and may not grow — and spread into `api` rather than imported separately,
 * so `api.updateStatus()` reads the same at every call site.
 *
 * Downloading and installing are separate calls because they have separate consequences.
 * Downloading costs bandwidth and disk and can be stopped; installing costs the daemon and
 * cannot. One button that did both would be asking one question about two different things.
 */

import { control, post, request } from "./api.client";

/** What `GET /update` answers: what this install is, and whether anything newer exists. */
export interface UpdateInstall {
  version: string;
  /** `basic` (Community), `router` or `pro`. */
  edition: string;
  installDir: string;
  supervisor: string;
  compiled: boolean;
  platform: string;
  arch: string;
  musl: boolean;
}

export interface UpdatePlan {
  can: boolean;
  from: string;
  to: string;
  artifact?: string;
  reason?: string;
  instead?: string[];
}

export type DownloadStatus = "idle" | "downloading" | "paused" | "ready" | "failed";

export interface UpdateDownload {
  status: DownloadStatus;
  received: number;
  /** Null until the channel says how big it is. */
  total: number | null;
  tag: string | null;
  artifact: string | null;
  error: string | null;
}

export interface UpdateCheck {
  current: string;
  /**
   * The newest release carrying a build **for this edition** — not simply the newest tag.
   *
   * The public channel receives the community edition's tarballs and nothing else, so a version
   * can exist without existing for this build. This is the one the buttons act on.
   */
  latest: string;
  newer: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  /** A newer tag that exists and that this install cannot take. Worth saying out loud. */
  latestElsewhere?: string;
  /** Why it is not on offer — no build for this edition, or one its checksums do not cover. */
  blockedReason?: string;
  /** Set when the channel could not be reached and this is the last answer it gave. */
  stale?: string;
  /** What the channel says about this install that is not an outage: a licence whose updates ended. */
  notice?: string;
  plan?: UpdatePlan;
  /**
   * A newer release needs a newer version than this one first (its upgrade floor). `latest` is then the stepping stone
   * the buttons act on, or this version when the channel lists none. `message` is the daemon's sentence.
   */
  floor?: { release: string; needs: string; message: string };
  /** Which releases this install follows, `[update] track` (0.8.18); absent from a daemon before it. */
  track?: UpdateTrack;
  /** The other track's newest release, when it is newer than this version and is not `latest`. */
  otherTrack?: { track: UpdateTrack; tag: string };
}

/** `latest`: the newest release. `lts`: a long-term line (1.0 the first). */
export type UpdateTrack = "latest" | "lts";

export interface UpdateStatus {
  supported: boolean;
  install: UpdateInstall;
  download: UpdateDownload;
  /** Absent when the channel could not be reached — `error` says why. */
  check?: UpdateCheck;
  error?: string;
}

export const updateApi = {
  /**
   * Read-only: any signed-in account may ask whether the thing they rely on is current.
   *
   * `force` reaches past the daemon's five-minute channel cache, and only the Check again
   * button passes it. The progress poll must not: the unauthenticated GitHub API allows sixty
   * requests an hour, and one forcing poll a second spends that in a minute.
   */
  updateStatus: (force = false) => request<UpdateStatus>(`${control}/update${force ? "?force=1" : ""}`),
  /**
   * Progress alone, for the one-second poll while a transfer runs.
   *
   * Deliberately not `updateStatus`: that one resolves the release channel, and asking *that*
   * every second is what spent an hourly API budget in under a minute.
   */
  updateProgress: () => request<{ download: UpdateDownload }>(`${control}/update/progress`),
  /** Start, or pick up where a pause left off. Returns at once; progress is on `updateProgress`. */
  startDownload: () =>
    post<{ ok: true; check: UpdateCheck; download: UpdateDownload }>(`${control}/update/download`, {}),
  pauseDownload: () => post<{ ok: true; download: UpdateDownload }>(`${control}/update/pause`, {}),
  /** "No", as opposed to pause's "later": the partial file is removed. */
  discardDownload: () => post<{ ok: true; download: UpdateDownload }>(`${control}/update/discard`, {}),
  /**
   * Admin-only, and it ends the process.
   *
   * No follow-up turn is scheduled from here: the operator pressing the button is the one
   * watching, and the page polls until the daemon answers again. The agent's path requires one,
   * because a conversation that has ended cannot check anything.
   *
   * `plain`: when the new version takes over, in the page's words (0.8.20); `note` names the files it replaced.
   */
  installUpdate: () => post<{ ok: true; to: string; note: string; plain?: string }>(`${control}/update/install`, {}),
  /** Admin-only (0.8.18). Answers with the check on the new track, so the page shows what it now offers. */
  setUpdateTrack: (track: UpdateTrack) =>
    post<{ ok: true; track: UpdateTrack; check?: UpdateCheck; error?: string }>(`${control}/update/track`, { track }),
};
