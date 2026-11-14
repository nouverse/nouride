/**
 * The System page's calls: what the machine is using, and the data folder to read, keep a file of, and clear of what
 * agents left behind. An admin's, each of them. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { SystemFileOpened, SystemFileWeight, SystemFolderListing, SystemFolderSizes, SystemOverview } from "@nouride/wire";

const at = (path: string) => `path=${encodeURIComponent(path)}`;

/** A long file's words are all read before it is handed over, which a large log takes a while for. */
const CHECK_TIMEOUT_MS = 5 * 60_000;
/** A folder of a project's dependencies is many thousands of files to delete. */
const DELETE_TIMEOUT_MS = 5 * 60_000;

export const systemApi = {
  system: () => request<SystemOverview>(`${control}/system`),
  /** How large the data folder is. Asked again while it says `measuring`: the count comes later. */
  systemFolderSizes: () => request<SystemFolderSizes>(`${control}/system/folder-sizes`),
  /** A folder of the data folder, by its path under it; the folder itself for an empty path. */
  systemFiles: (path: string) => request<SystemFolderListing>(`${control}/system/files?${at(path)}`),
  systemFile: (path: string) => request<SystemFileOpened>(`${control}/system/files/read?${at(path)}`),
  /** Where a file's own bytes are, for an `<img>`, a `<video>`, an `<audio>`, or a PDF in a tab of its own. */
  systemMedia: (path: string) => `${control}/system/files/raw?${at(path)}`,
  /** Whether a file would be handed over to keep: refused, in a sentence, where its words hold a credential. */
  systemDownloadCheck: (path: string) => request<{ ok: true }>(`${control}/system/files/download?${at(path)}&check=1`, { timeoutMs: CHECK_TIMEOUT_MS }),
  /** Where the browser fetches a file to keep, once `systemDownloadCheck` has said it would be handed over. */
  systemDownload: (path: string) => `${control}/system/files/download?${at(path)}`,
  /** What a delete would take, for the question asked before it. */
  systemWeigh: (path: string) => request<SystemFileWeight>(`${control}/system/files/weigh?${at(path)}`, { timeoutMs: 30_000 }),
  systemDelete: (path: string) => post<{ ok: true; path: string }>(`${control}/system/files/delete`, { path }, { timeoutMs: DELETE_TIMEOUT_MS }),
};
