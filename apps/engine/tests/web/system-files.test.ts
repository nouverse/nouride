/**
 * The data folder as System's Files tab reads it (`system-files.ts`): what is listed, what is left out whole, and
 * every way a path could lead out of the folder. On a folder of the test's making, laid out as an install's is.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFile, listFolder, pictureType } from "@/modules/web/control/system-files.ts";

let top: string;
let root: string;

const put = (path: string, text = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const names = (path: string) => {
  const listing = listFolder(root, path);
  if (!listing.ok) throw new Error(`${path}: ${listing.reason}`);
  return listing.entries.map((entry) => entry.name);
};

beforeAll(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "nr-files-")));
  root = join(top, ".nouride");
  for (const path of [
    "config.toml",
    "encryption.key",
    "agents/nouva/MEMORY.md",
    "agents/shared/.credentials/id_ed25519",
    "data/.control-token",
    "data/secrets.enc",
    "data/secrets.json",
    "data/cli-accounts.json",
    "data/whatsapp/creds.json",
    "data/advisories.json",
    "data/nouride.db",
    "data/nouride.db-wal",
    "data/backups/db/nouride-2026-11-13.db",
    "home/.ssh/id_ed25519",
    "home/.claude/.credentials.json",
    "home/.bash_history",
    "home/project/readme.md",
    "home/project/.git/config",
    "workspace/notes.md",
    "workspace/shot.png",
    "workspace/app/.env",
    "workspace/app/.env.example",
    "workspace/app/client_secret.json",
    "workspace/app/api-tokens.txt",
    "workspace/app/server.pem",
    "workspace/app/.npmrc",
    "workspace/app/token-savings.md",
    "workspace/app/keyboard.md",
    "workspace/app/src/index.ts",
  ])
    put(path);
  writeFileSync(join(top, "outside.txt"), "not Nouride's");
  symlinkSync(top, join(root, "workspace/link-out"));
  symlinkSync(join(top, "outside.txt"), join(root, "workspace/link-out-file"));
  symlinkSync(join(root, "data/.control-token"), join(root, "workspace/link-ctl"));
  symlinkSync(join(root, "data/nouride.db"), join(root, "workspace/link-db"));
  symlinkSync(join(root, "workspace/notes.md"), join(root, "workspace/link-notes"));
  symlinkSync(join(root, "workspace/app"), join(root, "workspace/link-app"));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

describe("a folder's listing", () => {
  test("the data folder itself: folders first, then files, each by name", () => {
    const listing = listFolder(root, "");
    expect(listing).toMatchObject({ ok: true, path: "", more: 0, leftOut: true });
    expect(names("")).toEqual(["agents", "data", "home", "workspace", "config.toml"]);
    const config = (listing as { entries: { name: string; kind: string; sizeBytes: number | null; modifiedAt: number | null; path: string }[] }).entries.at(-1)!;
    expect(config).toMatchObject({ name: "config.toml", path: "config.toml", kind: "file", sizeBytes: 1 });
    expect(config.modifiedAt).toBeGreaterThan(1_700_000_000_000);
    expect(listFolder(root, "/")).toEqual({ ok: false, reason: "outside" });
    // Spelled with a slash at its end or a dot in it, the same folder.
    expect(names("workspace/./app/")).toEqual(names("workspace/app"));
  });

  test("Nouride's own secrets are not in it, the database is, closed, and the listing says something was left out", () => {
    const listing = listFolder(root, "data");
    expect(names("data")).toEqual(["backups", "advisories.json", "nouride.db", "nouride.db-wal"]);
    expect(listing).toMatchObject({ leftOut: true });
    const entries = (listing as { entries: { name: string; closed?: string }[] }).entries;
    expect(entries.find((entry) => entry.name === "nouride.db")).toMatchObject({ closed: "database", sizeBytes: 1 });
    expect(entries.find((entry) => entry.name === "advisories.json")!.closed).toBeUndefined();
    expect((listFolder(root, "data/backups/db") as { entries: { closed?: string }[] }).entries[0]).toMatchObject({ closed: "database" });
  });

  test("the credentials folder, and in the agents' home every name that starts with a dot, are left out", () => {
    expect(names("agents/shared")).toEqual([]);
    expect(listFolder(root, "agents/shared")).toMatchObject({ leftOut: true });
    expect(names("home")).toEqual(["project"]);
    expect(names("home/project")).toEqual(["readme.md"]);
    // A dot elsewhere is an ordinary name: a workspace's project keeps its own.
    put("workspace/site/.gitignore");
    expect(names("workspace/site")).toEqual([".gitignore"]);
  });

  test("a project's keys and sign-ins are left out by their names, and a name that only holds such a word is not", () => {
    expect(names("workspace/app")).toEqual(["src", "keyboard.md", "token-savings.md"]);
  });

  test("a link is what it leads to: listed where that is inside and not left out", () => {
    expect(names("workspace")).toEqual(["app", "link-app", "site", "link-db", "link-notes", "notes.md", "shot.png"]);
    const listing = listFolder(root, "workspace") as { leftOut: boolean; entries: { name: string; closed?: string }[] };
    expect(listing.leftOut).toBe(true);
    // A link to the database is the database: listed, closed.
    expect(listing.entries.find((entry) => entry.name === "link-db")).toMatchObject({ kind: "file", closed: "database" });
    expect(listing.entries.find((entry) => entry.name === "link-notes")!.closed).toBeUndefined();
    // Through the link, the same rules: its left-out files are not listed there either.
    expect(names("workspace/link-app")).toEqual(["src", "keyboard.md", "token-savings.md"]);
  });

  test("a long folder is its first entries and how many more there are", () => {
    for (let n = 1; n <= 30; n += 1) put(`workspace/many/file-${n}.txt`);
    const listing = listFolder(root, "workspace/many", 10);
    expect(listing).toMatchObject({ ok: true, more: 20 });
    expect((listing as { entries: unknown[] }).entries).toHaveLength(10);
    // By number, as a person counts: 2 before 10.
    expect((listing as { entries: { name: string }[] }).entries.map((entry) => entry.name).slice(0, 3)).toEqual(["file-1.txt", "file-2.txt", "file-3.txt"]);
  });
});

describe("asked for by name", () => {
  test.each([
    "data/.control-token",
    "data/secrets.enc",
    "data/secrets.json",
    "data/cli-accounts.json",
    "data/whatsapp",
    "data/whatsapp/creds.json",
    "agents/shared/.credentials",
    "agents/shared/.credentials/id_ed25519",
    "home/.ssh",
    "home/.ssh/id_ed25519",
    "home/.claude/.credentials.json",
    "home/.bash_history",
    "home/project/.git/config",
    "workspace/app/.env",
    "workspace/app/.env.example",
    "workspace/app/client_secret.json",
    "workspace/app/api-tokens.txt",
    "workspace/app/server.pem",
    "workspace/app/.npmrc",
    // Through a link, where it leads is what is asked.
    // By where it leads alone: nothing in this link's own name says what it is.
    "workspace/link-ctl",
    // Not there at all: said as left out all the same, so asking does not tell whether such a file exists.
    "home/.aws/credentials",
    "data/secrets.key",
    "workspace/link-app/.env",
    // The secret store's own key, where an install with nowhere better keeps it.
    "encryption.key",
  ])("%s is left out: neither listed nor opened", (path) => {
    expect(findFile(root, path)).toEqual({ ok: false, reason: "left-out" });
    expect(listFolder(root, path)).toEqual({ ok: false, reason: "left-out" });
  });

  test.each(["..", "../outside.txt", "workspace/..", "workspace/../workspace/notes.md", "workspace/../../outside.txt", "workspace/app/../../../outside.txt", "/etc/passwd", "workspace\\..\\..", "workspace/\0", "workspace/link-out", "workspace/link-out/outside.txt", "workspace/link-out-file"])(
    "%s leads out of the folder and is refused",
    (path) => {
      expect(findFile(root, path)).toEqual({ ok: false, reason: "outside" });
      expect(listFolder(root, path)).toEqual({ ok: false, reason: "outside" });
    },
  );

  test("the database does not open, by its name or through a link to it", () => {
    expect(findFile(root, "data/nouride.db")).toEqual({ ok: false, reason: "database" });
    expect(findFile(root, "data/nouride.db-wal")).toEqual({ ok: false, reason: "database" });
    expect(findFile(root, "data/backups/db/nouride-2026-11-13.db")).toEqual({ ok: false, reason: "database" });
    expect(findFile(root, "workspace/link-db")).toEqual({ ok: false, reason: "database" });
  });

  test("an ordinary file opens where it really is; a link inside leads to its file", () => {
    expect(findFile(root, "workspace/notes.md")).toEqual({ ok: true, real: join(root, "workspace/notes.md"), entry: expect.objectContaining({ name: "notes.md", path: "workspace/notes.md", kind: "file", sizeBytes: 1 }) });
    expect(findFile(root, "workspace/link-notes")).toMatchObject({ ok: true, real: join(root, "workspace/notes.md"), entry: { name: "link-notes" } });
    expect(findFile(root, "config.toml")).toMatchObject({ ok: true });
    expect(findFile(root, "workspace/app/token-savings.md")).toMatchObject({ ok: true });
  });

  test("what is not there, a folder asked for as a file and a file asked for as a folder each say so", () => {
    expect(findFile(root, "workspace/gone.md")).toEqual({ ok: false, reason: "missing" });
    expect(listFolder(root, "workspace/gone")).toEqual({ ok: false, reason: "missing" });
    expect(findFile(root, "workspace")).toEqual({ ok: false, reason: "a-folder" });
    expect(listFolder(root, "workspace/notes.md")).toEqual({ ok: false, reason: "not-a-folder" });
    expect(listFolder(join(top, "no-such-root"), "")).toEqual({ ok: false, reason: "missing" });
  });
});

test("a picture is told by its name's ending, and nothing that can carry a script is one", () => {
  expect(pictureType("shot.PNG")).toBe("image/png");
  expect(pictureType("photo.jpeg")).toBe("image/jpeg");
  expect(pictureType("drawing.svg")).toBeNull();
  expect(pictureType("page.html")).toBeNull();
  expect(pictureType("png")).toBeNull();
});
