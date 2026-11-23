/** An install taken to another machine: what the export and import routes answer, and the page draws. */

/** How much one part of an export holds. */
export interface TransferPart {
  files: number;
  bytes: number;
}

/** The parts an export is made of, by the names its manifest uses. */
export type TransferParts = Partial<Record<"config" | "agents" | "memory" | "knowledge" | "uploads" | "notes" | "attachments" | "workspace", TransferPart>>;

/** What an export would hold, said before it is made. */
export interface ExportPlan {
  parts: TransferParts;
  /** The database as it is on disk now; its snapshot in the file is usually smaller. */
  database: number;
  /** The agents' own folders, whether or not they were asked for: the size shown beside their tick. */
  folders: TransferPart;
  /** Everything asked for, before it is compressed. */
  bytes: number;
  /** How many secrets there are to seal, and room on the disk the file is made on. */
  secrets: number;
  freeBytes: number | null;
}

/** An export being made, or the last one made. */
export interface ExportStatus {
  state: "none" | "working" | "ready" | "failed";
  /** While it works: how far, and against what size once what goes in has been counted. */
  done?: { files: number; bytes: number };
  total?: number;
  /** When ready: the file's name and size, when it was made, and whether it holds the secrets and the folders. */
  name?: string;
  bytes?: number;
  madeAt?: number;
  secrets?: boolean;
  folders?: boolean;
  error?: string;
}

/** A file that was opened and can be imported: what it holds, beside what is here now. */
export interface ImportChecked {
  version: string;
  madeAt: number;
  agents: string[];
  /** How many secrets it holds, sealed; null when it holds none. */
  secrets: number | null;
  folders: boolean;
  database: number;
  parts: TransferParts;
  /** What this install holds now, which the import replaces. */
  here: { agents: string[]; people: number; bytes: number };
}

/** What an import brought and left, kept until the install has gone live and the note is put away. */
export interface ImportReport {
  at: number;
  from: { version: string; madeAt: number };
  agents: string[];
  secrets: number | null;
  folders: boolean;
  parts: TransferParts;
  /** Passed over when the file was made: links, and files that hold a sign-in or a key. */
  passed: { links: number; credentials: number };
  /** Sign-ins ended by it. */
  ended: { sessions: number; devices: number };
  /** What waits for "Go live": the connections that were on, how many automations, the missions it paused. */
  held: { connections: string[]; automations: number; missions: number };
  /** A place the config names that is not on this machine: its setting, and the path. */
  missing: { setting: string; path: string }[];
  /** Where what this install held before is kept. */
  kept: string;
  /** False from the import until "Go live". */
  live: boolean;
}

/** `GET /transfer`: the last export, an upload on its way, and the import this install came from, if it did. */
export interface TransferState {
  export: ExportStatus;
  /** A file uploaded for an import and not yet applied: how much of it has arrived. */
  upload: { bytes: number } | null;
  imported: ImportReport | null;
  /** Whether Nouride can restart itself here: an import is applied as it starts. */
  restarts: boolean;
  /** The last import asked for here that did not go in, and whether everything was put back as it was. */
  failed: { at: number; error: string; restored: boolean } | null;
  /** An import is left ready, and goes in when Nouride next starts. */
  staged: boolean;
  /** Whether connections and automations are held back: imported, and not live. */
  held: boolean;
  /** How many secrets are kept here: whether an export has any to lock, known before anything is counted. */
  secrets: number;
}
