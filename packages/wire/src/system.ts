/**
 * What the System page reads: what the machine is using, and the data folder to read.
 *
 * A figure nothing on the machine says is `null`, never 0: a page that drew 0 would say "none in use" where the
 * truth is "this install cannot tell".
 */

export interface SystemOverview {
  version: string;
  /** Seconds since the daemon started. */
  uptimeSeconds: number;
  /** The cores this install may run on, a container's limit counted. */
  cores: number;
  memory: {
    /** Nouride's own process, in bytes. */
    daemonBytes: number;
    /** What the agents' commands hold together and may hold, where they have a group of their own. */
    commands: { usedBytes: number; maxBytes: number | null } | null;
    /** In use of what Nouride may use: its container's or its service's own count where a limit is set, the machine's otherwise. */
    usedBytes: number | null;
    /** What there is to use: that limit, or the machine's memory. */
    totalBytes: number | null;
    /** Whether `totalBytes` is a limit set for Nouride here, below the machine's memory. */
    limited: boolean;
    /** The machine's own memory, where it says. */
    machineBytes: number | null;
  };
  /** The disk the data folder is on: in a container, its volume. */
  disk: { totalBytes: number; freeBytes: number } | null;
  /** Where the data folder is, as the machine names it. */
  folder: string;
}

/** How large the data folder is, by what is in it. Measured in the background, since a large folder takes a while. */
export interface SystemFolderSizes {
  state: "measuring" | "ready" | "unavailable";
  /** When the sizes below were measured, in milliseconds; null before the first measure has ended. */
  measuredAt: number | null;
  totalBytes: number | null;
  /** The folder's own entries, largest first. What is left out of Files is counted in the total and not named here. */
  entries: { name: string; bytes: number; kind: "folder" | "file" }[];
}

export interface SystemFileEntry {
  name: string;
  /** Its path under the data folder, `/` between its parts: what a listing or an opening of it is asked by. */
  path: string;
  kind: "folder" | "file";
  /** A file's size in bytes; null for a folder. */
  sizeBytes: number | null;
  /** When it was last changed, in milliseconds; null when the system will not say. */
  modifiedAt: number | null;
  /** Why a file does not open, where it does not. */
  closed?: "database";
}

export interface SystemFolderListing {
  path: string;
  entries: SystemFileEntry[];
  /** Entries past the ones listed. */
  more: number;
  /** Whether anything here is left out: credentials and secrets are not listed. */
  leftOut: boolean;
  /** Set where the path asked for is a file and not a folder: that file, and no entries. */
  file?: SystemFileEntry;
}

/** Why a path is not listed or opened. */
export type SystemFileRefusal = "outside" | "missing" | "left-out" | "not-a-folder" | "a-folder" | "database";

export interface SystemFileOpened {
  entry: SystemFileEntry;
  /** `text`: its words are in `text`. `picture`: fetched as a picture. `other`: not something a page shows. */
  kind: "text" | "picture" | "other";
  text?: string;
  /** Whether `text` is only the file's beginning. */
  truncated?: boolean;
  /** Whether something that looked like a credential was masked in `text`. */
  masked?: boolean;
}
