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
import type { UpdateCheck, UpdateDownload, UpdateStatus, UpdateTrack } from "@nouride/wire";

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
