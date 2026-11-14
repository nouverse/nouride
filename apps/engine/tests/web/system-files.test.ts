/**
 * The data folder as System's Files tab reads it (`system-files.ts`): what is listed, what is left out whole, every
 * way a path could lead out of the folder, and what an admin may delete from it. On a folder of the test's making,
 * laid out as an install's is.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFile, findRemovable, listFolder, mediaOf, removableAt } from "@/modules/web/control/system-files.ts";

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
    "workspace/shared/report/out.txt",
    "workspace/private/nix/app/main.ts",
    "attachments/nix/photo.png",
    "tool-output/nix/ses_1/out.txt",
    "jobs/job_1.log",
    "jobs/nix/job_2.log",
  ])
    put(path);
  writeFileSync(join(top, "outside.txt"), "not Nouride's");
  symlinkSync(top, join(root, "workspace/link-out"));
  symlinkSync(join(top, "outside.txt"), join(root, "workspace/link-out-file"));
  symlinkSync(join(root, "data/.control-token"), join(root, "workspace/link-ctl"));
  symlinkSync(join(root, "data/nouride.db"), join(root, "workspace/link-db"));
  symlinkSync(join(root, "workspace/notes.md"), join(root, "workspace/link-notes"));
  symlinkSync(join(root, "workspace/app"), join(root, "workspace/link-app"));
  symlinkSync(join(root, "agents"), join(root, "workspace/shared/link-agents"));
  symlinkSync(join(root, "workspace/shared"), join(root, "agents/link-shared"));
  // A folder with nothing private in it, reached by a name under which a tool keeps a sign-in.
  put("workspace/shared/plain/config");
  symlinkSync(join(root, "workspace/shared/plain"), join(root, "workspace/shared/.kube"));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

describe("a folder's listing", () => {
  test("the data folder itself: folders first, then files, each by name", () => {
    const listing = listFolder(root, "");
    expect(listing).toMatchObject({ ok: true, path: "", more: 0, leftOut: true });
    expect(names("")).toEqual(["agents", "attachments", "data", "home", "jobs", "tool-output", "workspace", "config.toml"]);
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
    expect(names("workspace")).toEqual(["app", "link-app", "private", "shared", "site", "link-db", "link-notes", "notes.md", "shot.png"]);
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

describe("what an admin may delete", () => {
  test.each([
    ["workspace/shared/report", "folder"],
    ["workspace/shared/report/out.txt", "file"],
    ["workspace/private/nix/app", "folder"],
    ["workspace/private/nix/notes.md", "file"],
    // Left in the workspaces' folder by an older layout: nobody's own folder.
    ["workspace/old", "folder"],
    ["workspace/old.txt", "file"],
    ["attachments/nix/photo.png", "file"],
    ["attachments/nix/2026-11", "folder"],
    ["tool-output/nix/ses_1", "folder"],
    ["jobs/nix/job_2.log", "file"],
    // A log from before each agent had a folder of its own there.
    ["jobs/job_1.log", "file"],
    // Where the data is a volume of its own and they stayed inside it.
    ["data/jobs/job_1.log", "file"],
    ["data/attachments/nix/photo.png", "file"],
    ["data/tool-output/nix/ses_1", "folder"],
  ] as const)("%s, a %s: what agents and chats left behind", (path, kind) => {
    expect(removableAt(path, kind)).toBe(true);
  });

  test.each([
    ["", "folder"],
    // The folders Nouride lays out, each with its agent's own user and group on it.
    ["workspace", "folder"],
    ["workspace/shared", "folder"],
    ["workspace/private", "folder"],
    ["workspace/private/nix", "folder"],
    ["attachments", "folder"],
    ["attachments/nix", "folder"],
    ["tool-output", "folder"],
    ["tool-output/nix", "folder"],
    ["jobs", "folder"],
    ["jobs/nix", "folder"],
    ["data/attachments/nix", "folder"],
    ["data/jobs", "folder"],
    // Everything else is Nouride's own.
    ["config.toml", "file"],
    ["data/nouride.db", "file"],
    ["data/backups/db/nouride-2026-11-13.db", "file"],
    ["data/uploads/a.png", "file"],
    ["agents/nouva/MEMORY.md", "file"],
    ["agents/nouva", "folder"],
    ["home/project/readme.md", "file"],
    ["memory/nouva/2026-11-13.md", "file"],
    ["bin/tool", "file"],
    // Only the three kept folders are known inside `data/`: a workspace is never there.
    ["data/workspace/shared/report", "folder"],
    ["data/workspace/old.txt", "file"],
    // A name that only begins as one of them.
    ["workspace-old/notes.md", "file"],
    ["jobs-old/job_1.log", "file"],
  ] as const)("%s, a %s, is kept", (path, kind) => {
    expect(removableAt(path, kind)).toBe(false);
  });

  test("a listing marks what may be deleted, and nothing else", () => {
    const marked = (path: string) => {
      const listing = listFolder(root, path);
      if (!listing.ok) throw new Error(`${path}: ${listing.reason}`);
      return Object.fromEntries(listing.entries.map((entry) => [entry.name, entry.removable === true]));
    };
    expect(marked("")).toEqual({ agents: false, attachments: false, data: false, home: false, jobs: false, "tool-output": false, workspace: false, "config.toml": false });
    expect(marked("workspace")).toMatchObject({ app: true, private: false, shared: false, "notes.md": true, "link-db": true });
    expect(marked("workspace/private")).toEqual({ nix: false });
    expect(marked("workspace/private/nix")).toEqual({ app: true });
    expect(marked("workspace/shared")).toEqual({ report: true, "link-agents": true, plain: true, ".kube": true });
    expect(marked("jobs")).toEqual({ nix: false, "job_1.log": true });
    expect(marked("attachments")).toEqual({ nix: false });
    expect(marked("attachments/nix")).toEqual({ "photo.png": true });
    expect(marked("data")).toMatchObject({ "nouride.db": false, "advisories.json": false });
    // Through a link out of the workspaces, where the folder really is decides: an agent's persona files are kept.
    expect(marked("workspace/shared/link-agents")).toEqual({ nouva: false, shared: false, "link-shared": false });
    expect(marked("workspace/shared/link-agents/nouva")).toEqual({ "MEMORY.md": false });
    // Through a link inside them, they are still the workspace's.
    expect(marked("workspace/link-app")).toEqual({ src: true, "keyboard.md": true, "token-savings.md": true });
    // And the other way: the shared folder reached from among the agents' persona files is not marked there, by the
    // path it is asked by.
    expect(marked("agents/link-shared")).toEqual({ report: false, "link-agents": false, plain: false, ".kube": false });
  });

  test("a file and a folder are found where they really are", () => {
    expect(findRemovable(root, "workspace/shared/report/out.txt")).toEqual({
      ok: true,
      real: join(root, "workspace/shared/report/out.txt"),
      led: "workspace/shared/report/out.txt",
      link: false,
      entry: expect.objectContaining({ name: "out.txt", path: "workspace/shared/report/out.txt", kind: "file", sizeBytes: 1 }),
    });
    expect(findRemovable(root, "workspace/private/nix/app")).toMatchObject({ ok: true, real: join(root, "workspace/private/nix/app"), link: false, entry: { kind: "folder", sizeBytes: null } });
    // Through a link to a folder of the workspace: the folder it leads to, and the entry in it.
    expect(findRemovable(root, "workspace/link-app/src")).toMatchObject({ ok: true, real: join(root, "workspace/app/src"), led: "workspace/app/src", entry: { path: "workspace/link-app/src" } });
  });

  test("a link is the link itself, never what it leads to: the database, a secret and a folder outside stay", () => {
    for (const name of ["link-notes", "link-db", "link-ctl", "link-out", "link-app"]) {
      expect(findRemovable(root, `workspace/${name}`)).toMatchObject({ ok: true, real: join(root, "workspace", name), led: `workspace/${name}`, link: true, entry: { kind: "file" } });
    }
  });

  test.each([
    ["", "kept"],
    ["workspace", "kept"],
    ["workspace/shared", "kept"],
    ["workspace/private/nix", "kept"],
    ["attachments/nix", "kept"],
    ["jobs/nix", "kept"],
    ["config.toml", "kept"],
    ["data/nouride.db", "kept"],
    ["agents/nouva/MEMORY.md", "kept"],
    // In the workspaces by its path, an agent's persona folder by where it is.
    ["workspace/shared/link-agents/nouva", "kept"],
    ["workspace/shared/link-agents/nouva/MEMORY.md", "kept"],
    // The workspace's by where it is, an agent's persona folder by the path it is asked by.
    ["agents/link-shared/report", "kept"],
    ["agents/link-shared/report/out.txt", "kept"],
    ["workspace/app/.env", "left-out"],
    ["workspace/link-app/.env", "left-out"],
    // A sign-in by the path it is asked by, though the folder that name leads to holds nothing private.
    ["workspace/shared/.kube/config", "left-out"],
    ["data/.control-token", "left-out"],
    ["../outside.txt", "outside"],
    ["workspace/../../outside.txt", "outside"],
    ["/etc/passwd", "outside"],
    ["workspace/link-out/outside.txt", "outside"],
    ["workspace/gone.md", "missing"],
    ["workspace/gone/notes.md", "missing"],
  ] as const)("%s is refused: %s", (path, reason) => {
    expect(findRemovable(root, path)).toEqual({ ok: false, reason });
  });
});

test("what a browser shows as itself is told by a name's ending, and nothing that can carry a script is one", () => {
  expect(mediaOf("shot.PNG")).toEqual({ kind: "picture", type: "image/png" });
  expect(mediaOf("photo.jpeg")).toEqual({ kind: "picture", type: "image/jpeg" });
  expect(mediaOf("demo.mp4")).toEqual({ kind: "video", type: "video/mp4" });
  expect(mediaOf("screen.MOV")).toEqual({ kind: "video", type: "video/quicktime" });
  expect(mediaOf("clip.webm")).toEqual({ kind: "video", type: "video/webm" });
  expect(mediaOf("voice.oga")).toEqual({ kind: "audio", type: "audio/ogg" });
  expect(mediaOf("song.mp3")).toEqual({ kind: "audio", type: "audio/mpeg" });
  expect(mediaOf("memo.m4a")).toEqual({ kind: "audio", type: "audio/mp4" });
  expect(mediaOf("report.pdf")).toEqual({ kind: "pdf", type: "application/pdf" });
  expect(mediaOf("drawing.svg")).toBeNull();
  expect(mediaOf("page.html")).toBeNull();
  expect(mediaOf("notes.md")).toBeNull();
  expect(mediaOf("mp4")).toBeNull();
});
