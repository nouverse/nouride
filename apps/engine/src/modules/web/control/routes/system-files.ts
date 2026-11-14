/**
 * System's Files: the data folder listed, a file read, shown, downloaded, and what agents left behind deleted.
 *
 * An admin's, each route, and asked first. What is listed, what is left out and what may be deleted is
 * `system-files.ts`'s; the deleting is `system-remove.ts`'s. A file's words are masked here, where they are sent, of
 * every value the secret store holds and of anything shaped like a credential, and a file in whose words something
 * was masked is not handed over whole: a download is the bytes as they are, and would undo the mask.
 */

import type { SystemFileOpened, SystemFileRefusal, SystemFileWeight, SystemFolderListing } from "@nouride/wire";
import { readFileRange } from "@nouride/runtime";
import { findSecrets, maskSecrets } from "@nouride/secrets";
import { egressValues } from "@/commons/egress.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { asciiName, fileResponse } from "../file-response.ts";
import { jsonBody } from "../payloads.ts";
import { findFile, findRemovable, listFolder, mediaOf, type Found } from "../system-files.ts";
import { remove, usedBy, weigh } from "../system-remove.ts";

export const ADMINS_ONLY = { error: "admin only", plain: "Only an admin can open the System page." };

/** A file's words are shown up to this many bytes; a longer one is its beginning, and says so. */
const TEXT_MAX_BYTES = 400 * 1024;
/** A picture larger than this is not sent to a page to draw. */
const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** A file is told as words or not by this much of its beginning. */
const SNIFF_BYTES = 8192;
/** A long file's words are checked a piece at a time, each piece reaching back this far so nothing is cut in two. */
const CHECK_BYTES = 1024 * 1024;
const CHECK_OVERLAP = 4096;

/** What a refusal is answered with: its status, and the sentence a person reads. */
const REFUSALS: Record<SystemFileRefusal, { status: 400 | 403 | 404 | 409; plain: string }> = {
  outside: { status: 400, plain: "That is not in this box's data folder." },
  missing: { status: 404, plain: "It is no longer there." },
  "left-out": { status: 403, plain: "This is kept private: credentials and secrets are not shown here." },
  "not-a-folder": { status: 400, plain: "That is a file, not a folder." },
  "a-folder": { status: 400, plain: "That is a folder, not a file." },
  database: { status: 403, plain: "The database does not open here." },
  masked: { status: 403, plain: "Something in this file looks like a credential, so it is not downloaded from here." },
  kept: { status: 403, plain: "Nouride keeps this for itself, so it is not deleted from here." },
  "in-use": { status: 409, plain: "Something is still working here. Delete it once that has ended." },
};

/** Who is working there, in the refusal's own words. */
const WORKING = {
  mission: "A mission is still working here. Delete it once the mission has ended.",
  job: "A background job is still running here. Delete it once the job has ended.",
};

const refusal = (reason: SystemFileRefusal, plain = REFUSALS[reason].plain) => ({ body: { error: reason, reason, plain }, status: REFUSALS[reason].status });

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

const words = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
const bytesOf = async (real: string, start: number, end: number) => new Uint8Array(await readFileRange(real, start, end).arrayBuffer());

/**
 * What a file is shown as: what its name says a browser shows as itself, else words, else nothing a page shows. Words
 * by its beginning holding no zero byte, whatever its name says.
 */
async function kindOf(found: Extract<Found, { ok: true }>): Promise<SystemFileOpened["kind"]> {
  const size = found.entry.sizeBytes ?? 0;
  const media = mediaOf(found.entry.name);
  if (media) return media.kind === "picture" && size > PICTURE_MAX_BYTES ? "other" : media.kind;
  return (await bytesOf(found.real, 0, Math.min(size, SNIFF_BYTES))).includes(0) ? "other" : "text";
}

/**
 * A file is handed over as the type said here and no other, whatever its bytes turn out to be, and kept by no cache:
 * a browser that guessed would draw a page of script from a file named as a picture. No policy of this route's own:
 * the server sets its own on every answer (`SECURITY_HEADERS`), over whatever a route said.
 */
const INERT = { "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" };

export function registerSystemFileRoutes(control: ControlApp, deps: ControlDeps, rootOf: () => string): void {
  /**
   * Whether nothing in a file's words would be masked, all of it read: asked before a download, and kept by where
   * the file is, its size and when it changed, so the download that follows the question does not read it twice.
   */
  const checked = new Map<string, { size: number; changed: number | null; clean: Promise<boolean> }>();
  const clean = (found: Extract<Found, { ok: true }>): Promise<boolean> => {
    const size = found.entry.sizeBytes ?? 0;
    const known = checked.get(found.real);
    if (known && known.size === size && known.changed === found.entry.modifiedAt) return known.clean;
    const stored = deps.secrets.knownValues();
    const read = (async () => {
      for (let at = 0; at < size; at += CHECK_BYTES) {
        const piece = words(await bytesOf(found.real, Math.max(0, at - CHECK_OVERLAP), Math.min(size, at + CHECK_BYTES)));
        if (hidden(piece, stored) !== piece) return false;
      }
      return true;
    })();
    if (checked.size >= 64) checked.delete(checked.keys().next().value!);
    checked.set(found.real, { size, changed: found.entry.modifiedAt, clean: read });
    return read;
  };

  control.get("/system/files", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const asked = c.req.query("path") ?? "";
    const root = rootOf();
    const listing = listFolder(root, asked);
    if (!listing.ok && listing.reason === "not-a-folder") {
      // A path to a file, as a link from a chat is: the page learns it is one, and opens it.
      const found = findFile(root, asked);
      if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
      const removable = findRemovable(root, asked).ok;
      return c.json({ path: found.entry.path, entries: [], more: 0, leftOut: false, file: { ...found.entry, ...(removable ? { removable: true as const } : {}) } } satisfies SystemFolderListing);
    }
    if (!listing.ok) return c.json(refusal(listing.reason).body, refusal(listing.reason).status);
    return c.json({ path: listing.path, entries: listing.entries, more: listing.more, leftOut: listing.leftOut } satisfies SystemFolderListing);
  });

  control.get("/system/files/read", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const found = findFile(rootOf(), c.req.query("path") ?? "");
    if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
    const kind = await kindOf(found);
    if (kind !== "text") return c.json({ entry: found.entry, kind } satisfies SystemFileOpened);
    const size = found.entry.sizeBytes ?? 0;
    const raw = words(await bytesOf(found.real, 0, Math.min(size, TEXT_MAX_BYTES)));
    const text = hidden(raw, deps.secrets.knownValues());
    return c.json({ entry: found.entry, kind, text, truncated: size > TEXT_MAX_BYTES, masked: text !== raw } satisfies SystemFileOpened);
  });

  /**
   * A file's own bytes for the page to draw or play, and for the browser's reader to open: a picture, a video, a
   * sound, a PDF, told by its name, sent as that type and in the ranges a player asks for. Anything else is refused,
   * so a page of script is never served from the dashboard's own address.
   */
  control.get("/system/files/raw", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const found = findFile(rootOf(), c.req.query("path") ?? "");
    if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
    const media = mediaOf(found.entry.name);
    const size = found.entry.sizeBytes ?? 0;
    if (!media || (media.kind === "picture" && size > PICTURE_MAX_BYTES)) return c.json({ error: "not shown", plain: "Only a picture, a video, a sound or a PDF is shown this way." }, 400);
    // Said as shown, with its name: the server names a file it is handed where a route does not, and a name alone,
    // with no word for shown or saved, is read by one browser as the first and by another as the second.
    return fileResponse(found.real, size, c.req.header("range"), { "Content-Type": media.type, "Content-Disposition": `inline; filename="${asciiName(found.entry.name)}"`, ...INERT });
  });

  /**
   * A file to keep: its bytes as they are, saved under its name and never shown. Not one in whose words something
   * would be masked, all of it read first. `check=1` asks only whether it would be handed over, so the page can say
   * why not in a sentence, where a refused download is a failed one in the browser's own list.
   */
  control.get("/system/files/download", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const found = findFile(rootOf(), c.req.query("path") ?? "");
    if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
    // A long log is read whole before a byte of it is sent: longer than a connection that says nothing is kept.
    c.env?.keepOpen?.(0);
    if ((await kindOf(found)) === "text" && !(await clean(found))) return c.json(refusal("masked").body, refusal("masked").status);
    if (c.req.query("check") === "1") return c.json({ ok: true } satisfies { ok: true });
    return fileResponse(found.real, found.entry.sizeBytes ?? 0, c.req.header("range"), {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${asciiName(found.entry.name)}"`,
      ...INERT,
    });
  });

  /** What is running now and where, read when a delete is asked. */
  const working = {
    missions: () => deps.missions?.running() ?? [],
    jobs: () => (deps.jobs?.list({ all: true }) ?? []).filter((job) => job.status === "running"),
  };

  /** What a delete would take, for the question asked before it; refused as the delete itself would be. */
  control.get("/system/files/weigh", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const root = rootOf();
    const found = findRemovable(root, c.req.query("path") ?? "");
    if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
    const by = usedBy(found, root, working);
    if (by) return c.json(refusal("in-use", WORKING[by]).body, 409);
    return c.json((await weigh(found)) satisfies SystemFileWeight);
  });

  control.post("/system/files/delete", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json(ADMINS_ONLY, 403);
    const asked = (await jsonBody(c))?.path;
    if (typeof asked !== "string" || asked === "") return c.json({ error: "path required", plain: "Nothing was named to delete." }, 400);
    const root = rootOf();
    const found = findRemovable(root, asked);
    if (!found.ok) return c.json(refusal(found.reason).body, refusal(found.reason).status);
    const by = usedBy(found, root, working);
    if (by) return c.json(refusal("in-use", WORKING[by]).body, 409);
    // A project's dependencies are many thousands of files, each deleted before this answers.
    c.env?.keepOpen?.(0);
    const done = await remove(found, deps.registry.all().map((agent) => agent.config.id));
    // Written whether or not all of it went: what was asked for is what somebody did.
    deps.audit.record({ action: "system_file_deleted", actor: principal.actor, details: { path: found.entry.path, kind: found.entry.kind, deleted: done } });
    if (!done) return c.json({ error: "not deleted", plain: "Not all of it could be deleted: part of it belongs to another user on this machine." }, 500);
    return c.json({ ok: true, path: found.entry.path } satisfies { ok: true; path: string });
  });
}
