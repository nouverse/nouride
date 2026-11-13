/**
 * The System page's calls: what the machine is using, and the data folder to read. An admin's, each of them.
 * The payload types are `@nouride/wire`'s.
 */

import { control, request } from "./api.client";
import type { SystemFileOpened, SystemFolderListing, SystemFolderSizes, SystemOverview } from "@nouride/wire";

const at = (path: string) => `path=${encodeURIComponent(path)}`;

export const systemApi = {
  system: () => request<SystemOverview>(`${control}/system`),
  /** How large the data folder is. Asked again while it says `measuring`: the count comes later. */
  systemFolderSizes: () => request<SystemFolderSizes>(`${control}/system/folder-sizes`),
  /** A folder of the data folder, by its path under it; the folder itself for an empty path. */
  systemFiles: (path: string) => request<SystemFolderListing>(`${control}/system/files?${at(path)}`),
  systemFile: (path: string) => request<SystemFileOpened>(`${control}/system/files/read?${at(path)}`),
  /** Where a picture's own bytes are, for an `<img>`. */
  systemPicture: (path: string) => `${control}/system/files/raw?${at(path)}`,
};
