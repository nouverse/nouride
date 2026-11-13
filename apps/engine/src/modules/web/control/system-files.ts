/**
 * The data folder, to read: what System's Files tab lists and opens.
 *
 * Whoever runs a box wants to see what is on it without a terminal. What a page must never show them is what somebody
 * with their session would be after, so three things hold here, for every path however it is spelled:
 *
 * - **Nothing outside the folder is reached.** `..`, an absolute path, and a link on disk that points out are each
 *   refused, the last by where the path really is once every link in it is followed.
 * - **What holds a credential is left out whole, its name with it** (`leftOut`): by the list a command's arguments are
 *   read against (`holdsCredential`), Nouride's own secret files, the sign-ins tools keep in the agents' home, and
 *   the names a key or a token is kept under anywhere.
 * - **The database does not open.** It is listed, with its size, because how large it is matters to whoever watches a
 *   disk; it is everything, and no page shows it.
 *
 * A secret inside an ordinary file is the route's to mask, where the text is sent (`routes/system.ts`).
 */

import type { SystemFileEntry, SystemFileRefusal } from "@nouride/wire";
import { holdsCredential } from "@nouride/policy";
import { join, linkTarget, listDir, realPathStrict, statFile } from "@nouride/runtime";

/** Nouride's own files that hold a secret, by their path under the data folder. */
const OWN_SECRETS = [
  /^data\/\.control-token$/,
  /^data\/secrets\./,
  /^data\/cli-accounts\.json$/,
  // A chat app's session: whoever holds it is that account.
  /^data\/whatsapp(\/|$)/,
];

/** A file's name that says a key, a password or a token is kept in it, whatever folder it is in. */
const SECRET_NAME = /(^|[._-])(secrets?|credentials?|passwords?|passwd|tokens?|keys?)(\.[a-z0-9]+)?$/i;

/** Where tools keep a sign-in by a name that does not say so, and the files a key is stored as. */
const SIGN_IN_NAMES = new Set([".npmrc", ".pypirc", ".git-credentials", ".htpasswd", ".pgpass", ".my.cnf", ".dockercfg", "kubeconfig", "adbkey", "auth.json"]);
const KEY_FILE = /\.(pem|p12|pfx|jks|keystore|kdbx|ppk|asc)$/i;

/** The database and its copies: listed, never opened. */
const DATABASE = /\.db(-wal|-shm|\.epoch)?$|\.sqlite3?$/i;

/**
 * Whether what is at `path`, a path under the data folder with `/` between its parts, is left out of every listing
 * and refused when asked for by name. A folder left out takes what is in it with it.
 *
 * Under `home/`, every name that starts with a dot: that is where a tool keeps its own state and its sign-in
 * (`.claude`, `.config`, `.docker`, a shell's history), under names no list could keep up with.
 */
function leftOut(path: string): boolean {
  if (holdsCredential(path) || OWN_SECRETS.some((pattern) => pattern.test(path))) return true;
  const parts = path.split("/");
  if (parts[0] === "home" && parts.slice(1).some((part) => part.startsWith("."))) return true;
  return parts.some((part) => SIGN_IN_NAMES.has(part.toLowerCase()) || KEY_FILE.test(part) || SECRET_NAME.test(part));
}

export type Listing =
  | { ok: true; path: string; entries: SystemFileEntry[]; /** Entries past the first `limit`, not listed. */ more: number; /** Whether anything here was left out. */ leftOut: boolean }
  | { ok: false; reason: SystemFileRefusal };

/** The parts of a path asked for, or null where it could lead out: an absolute path, a `..`, a NUL. */
function partsOf(asked: string): string[] | null {
  if (asked.includes("\0") || asked.startsWith("/") || asked.includes("\\")) return null;
  const parts = asked.split("/").filter((part) => part !== "" && part !== ".");
  return parts.includes("..") ? null : parts;
}

/**
 * Where `asked` really is, every link followed, when that is inside the folder and nothing on the way is left out.
 * Left out is asked of the path as written and of where it leads: a link in a workspace to the control token is the
 * control token.
 */
function resolveInside(root: string, asked: string): { ok: true; real: string; path: string } | { ok: false; reason: SystemFileRefusal } {
  const parts = partsOf(asked);
  if (!parts) return { ok: false, reason: "outside" };
  const path = parts.join("/");
  if (path !== "" && leftOut(path)) return { ok: false, reason: "left-out" };
  const base = realPathStrict(root);
  if (!base) return { ok: false, reason: "missing" };
  const real = realPathStrict(join(base, ...parts));
  if (!real) return { ok: false, reason: "missing" };
  if (real !== base && !real.startsWith(`${base}/`)) return { ok: false, reason: "outside" };
  const led = real === base ? "" : real.slice(base.length + 1);
  if (led !== "" && leftOut(led)) return { ok: false, reason: "left-out" };
  return { ok: true, real, path };
}

const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** A folder's entries, folders first and then by name, the first `limit` of them. */
export function listFolder(root: string, asked: string, limit = 500): Listing {
  const at = resolveInside(root, asked);
  if (!at.ok) return at;
  const here = statFile(at.real);
  if (!here) return { ok: false, reason: "missing" };
  if (!here.isDirectory) return { ok: false, reason: "not-a-folder" };

  let hidden = false;
  const entries: SystemFileEntry[] = [];
  for (const entry of listDir(at.real)) {
    const path = at.path === "" ? entry.name : `${at.path}/${entry.name}`;
    // A link is what it leads to, and is listed only where that is inside and not left out; anything else that is
    // neither a file nor a folder (a socket, a pipe) is not a file to read.
    const link = linkTarget(join(at.real, entry.name)) !== null;
    const led = link ? resolveInside(root, path) : null;
    if (led ? !led.ok : leftOut(path)) {
      hidden = true;
      continue;
    }
    const stat = statFile(join(at.real, entry.name));
    if (!stat || (!link && !entry.isDirectory && !entry.isFile)) continue;
    const database = !stat.isDirectory && (DATABASE.test(entry.name) || (led?.ok === true && DATABASE.test(led.real)));
    entries.push({
      name: entry.name,
      path,
      kind: stat.isDirectory ? "folder" : "file",
      sizeBytes: stat.isDirectory ? null : stat.size,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
      ...(database ? { closed: "database" as const } : {}),
    });
  }
  entries.sort((a, b) => (a.kind === b.kind ? byName.compare(a.name, b.name) : a.kind === "folder" ? -1 : 1));
  return { ok: true, path: at.path, entries: entries.slice(0, limit), more: Math.max(0, entries.length - limit), leftOut: hidden };
}

export type Found =
  | { ok: true; real: string; entry: SystemFileEntry }
  | { ok: false; reason: SystemFileRefusal };

/** One file that may be opened: where it really is, and what a listing says of it. */
export function findFile(root: string, asked: string): Found {
  const at = resolveInside(root, asked);
  if (!at.ok) return at;
  const stat = statFile(at.real);
  if (!stat) return { ok: false, reason: "missing" };
  if (stat.isDirectory) return { ok: false, reason: "a-folder" };
  const name = at.path.split("/").pop() ?? "";
  if (DATABASE.test(name) || DATABASE.test(at.real)) return { ok: false, reason: "database" };
  return { ok: true, real: at.real, entry: { name, path: at.path, kind: "file", sizeBytes: stat.size, modifiedAt: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null } };
}

/** The pictures a browser draws as a picture, by a file's ending: nothing that can carry a script. */
const PICTURES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

/** A picture's type by its name, or null for anything else. */
export function pictureType(name: string): string | null {
  return PICTURES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? null;
}
