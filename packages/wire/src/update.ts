/**
 * Whether this daemon is the newest one, and the three calls that change that (`routes/update.ts`).
 */

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
