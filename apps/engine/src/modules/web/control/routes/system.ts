/**
 * The System page: what the machine is using, and the data folder to read.
 *
 * An admin's, each route, and asked first: the data folder holds every person's files and chats, as the logs hold
 * their every line. What is listed and what is left out is `system-files.ts`'s; a file's words are masked here, where
 * they are sent, of every value the secret store holds and of anything shaped like a credential.
 */

import type { SystemFileOpened, SystemFileRefusal, SystemFolderListing, SystemFolderSizes, SystemOverview } from "@nouride/wire";
import { commandsMemory, dirname, diskSpace, processMemory, readFileRange, readMachine, readMemoryUse } from "@nouride/runtime";
import { findSecrets, maskSecrets } from "@nouride/secrets";
import { egressValues } from "@/commons/egress.ts";
import { VERSION } from "@/commons/version.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { findFile, listFolder, pictureType } from "../system-files.ts";
import { FolderSizes } from "../system-usage.ts";

const ADMINS_ONLY = { error: "admin only", plain: "Only an admin can open the System page." };

/** A file's words are shown up to this many bytes; a longer one is its beginning, and says so. */
const TEXT_MAX_BYTES = 400 * 1024;
/** A picture larger than this is not sent to a page to draw. */
const PICTURE_MAX_BYTES = 25 * 1024 * 1024;

/** What a refusal is answered with: its status, and the sentence a person reads. */
const REFUSALS: Record<SystemFileRefusal, { status: 400 | 403 | 404; plain: string }> = {
  outside: { status: 400, plain: "That is not in this box's data folder." },
  missing: { status: 404, plain: "It is no longer there." },
  "left-out": { status: 403, plain: "This is kept private: credentials and secrets are not shown here." },
  "not-a-folder": { status: 400, plain: "That is a file, not a folder." },
  "a-folder": { status: 400, plain: "That is a folder, not a file." },
  database: { status: 403, plain: "The database does not open here." },
};

/**
 * A file's words with every credential in them hidden: the values the secret store holds, by exact value, and
 * anything a rule knows the shape of or that sits where a credential is written (`password = …`). Not the registry's
 * eager rules, which take any long run of letters and digits: a lock file's hashes and a log's ids are what a person
 * opens a file to read.
 */
function hidden(text: string, stored: Record<string, string>): string {
  const known = maskSecrets(text, egressValues(stored), { whole: true });
  let out = "";
  let at = 0;
  for (const match of findSecrets(known, "ingress")) {
    out += `${known.slice(at, match.start)}[hidden: ${match.pattern.redactAs}]`;
    at = match.end;
  }
  return out + known.slice(at);
}

/** Nothing a file holds is run by the browser that is handed it, whatever its bytes turn out to be. */
const INERT = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store" };

export function registerSystemRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The folder the config file is in: `.nouride`, where agents, workspaces and the data all live by default. Worked
   * out when a route is first asked, not as they are registered: a context a test wires holds less than a config.
   */
  let folder: { root: string; sizes: FolderSizes } | null = null;
  const at = () => (folder ??= ((root) => ({ root, sizes: new FolderSizes(root) }))(deps.ctx.configSource ? dirname(deps.ctx.configSource) : dirname(deps.ctx.config.daemon.dataDir)));

  control.get("/system", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const memory = readMemoryUse();
    const { root } = at();
    return c.json({
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.ctx.startedAt) / 1000),
      cores: (deps.ctx.machine ?? readMachine()).cores,
      memory: {
        daemonBytes: processMemory().rssBytes,
        commands: commandsMemory(),
        usedBytes: memory.usedBytes,
        totalBytes: memory.totalBytes > 0 ? memory.totalBytes : null,
        limited: memory.limited,
        machineBytes: memory.machineBytes > 0 ? memory.machineBytes : null,
      },
      disk: diskSpace(root),
      folder: root,
    } satisfies SystemOverview);
  });

  control.get("/system/folder-sizes", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const { root, sizes } = at();
    const read = sizes.read();
    // By name only what Files lists: what is left out there is in the total and nowhere else.
    const listed = listFolder(root, "", Number.MAX_SAFE_INTEGER);
    const kinds = new Map(listed.ok ? listed.entries.map((entry) => [entry.name, entry.kind]) : []);
    return c.json({ ...read, entries: read.entries.flatMap((entry) => (kinds.has(entry.name) ? [{ ...entry, kind: kinds.get(entry.name)! }] : [])) } satisfies SystemFolderSizes);
  });

  control.get("/system/files", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const asked = c.req.query("path") ?? "";
    const { root } = at();
    const listing = listFolder(root, asked);
    if (!listing.ok && listing.reason === "not-a-folder") {
      // A path to a file, as a link from a chat is: the page learns it is one, and opens it.
      const found = findFile(root, asked);
      if (found.ok) return c.json({ path: found.entry.path, entries: [], more: 0, leftOut: false, file: found.entry } satisfies SystemFolderListing);
      return c.json({ error: found.reason, reason: found.reason, plain: REFUSALS[found.reason].plain }, REFUSALS[found.reason].status);
    }
    if (!listing.ok) return c.json({ error: listing.reason, reason: listing.reason, plain: REFUSALS[listing.reason].plain }, REFUSALS[listing.reason].status);
    return c.json({ path: listing.path, entries: listing.entries, more: listing.more, leftOut: listing.leftOut } satisfies SystemFolderListing);
  });

  control.get("/system/files/read", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const found = findFile(at().root, c.req.query("path") ?? "");
    if (!found.ok) return c.json({ error: found.reason, reason: found.reason, plain: REFUSALS[found.reason].plain }, REFUSALS[found.reason].status);
    const size = found.entry.sizeBytes ?? 0;
    if (pictureType(found.entry.name)) return c.json({ entry: found.entry, kind: size <= PICTURE_MAX_BYTES ? "picture" : "other" } satisfies SystemFileOpened);
    const bytes = new Uint8Array(await readFileRange(found.real, 0, Math.min(size, TEXT_MAX_BYTES)).arrayBuffer());
    // A zero byte in its beginning: not words, whatever its name says.
    if (bytes.subarray(0, 8192).includes(0)) return c.json({ entry: found.entry, kind: "other" } satisfies SystemFileOpened);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = hidden(raw, deps.secrets.knownValues());
    return c.json({ entry: found.entry, kind: "text", text, truncated: size > TEXT_MAX_BYTES, masked: text !== raw } satisfies SystemFileOpened);
  });

  /** A picture's own bytes, for the page to draw. A picture by its name only; anything else is refused. */
  control.get("/system/files/raw", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const found = findFile(at().root, c.req.query("path") ?? "");
    if (!found.ok) return c.json({ error: found.reason, reason: found.reason, plain: REFUSALS[found.reason].plain }, REFUSALS[found.reason].status);
    const type = pictureType(found.entry.name);
    if (!type || (found.entry.sizeBytes ?? 0) > PICTURE_MAX_BYTES) return c.json({ error: "not a picture", plain: "Only a picture is shown this way." }, 400);
    return new Response(readFileRange(found.real, 0, found.entry.sizeBytes ?? 0), { headers: { "Content-Type": type, ...INERT } });
  });
}
