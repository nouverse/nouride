/**
 * The System page's routes (`routes/system.ts`, `routes/system-files.ts`): an admin's alone; what the machine is
 * using, read and never made up; a folder's listing and a refusal's words; a file's words masked where they are
 * sent; a picture's, a video's and a PDF's bytes handed over as that type and no other; a download of the bytes as
 * they are, never of a file in whose words something was masked; and a delete, of what agents left behind alone,
 * held while something works there and written down.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { SystemFileOpened, SystemFileWeight, SystemFolderListing, SystemFolderSizes, SystemOverview } from "@nouride/wire";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerSystemRoutes } from "@/modules/web/control/routes/system.ts";
import type { ControlApp, ControlDeps } from "@/modules/web/control/types.ts";
import { eventually } from "../helpers.ts";

const ACCOUNTS = {
  admin: { kind: "user", actor: "gading", role: "admin", user: { id: "u1", username: "gading", displayName: "", role: "admin" } },
  operator: { kind: "user", actor: "rina", role: "operator", user: { id: "u2", username: "rina", displayName: "", role: "operator" } },
  viewer: { kind: "user", actor: "tamu", role: "viewer", user: { id: "u3", username: "tamu", displayName: "", role: "viewer" } },
} as const;

/** A token of a shape the registry knows, made here: no real one is written in a test. */
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`;
const STORED = "s3cr3t-value-kept-in-the-store-0001";

let top: string;
let root: string;
let app: Hono;
let as: keyof typeof ACCOUNTS = "admin";
/** What is running, as a test sets it, and what was written to the audit log. */
let missions: { workdir: string | null }[] = [];
let jobs: { status: string; cwd: string; logPath: string }[] = [];
const audited: { action: string; actor: string; details?: Record<string, unknown> }[] = [];

const put = (path: string, content: string | Uint8Array = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const erase = (path: unknown) => ask("/system/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(path === undefined ? {} : { path }) });
const ask = async (path: string, init?: RequestInit) => {
  const response = await app.request(path, init);
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, headers: response.headers, body: type.includes("json") ? ((await response.json()) as Record<string, unknown>) : null, bytes: type.includes("json") ? null : new Uint8Array(await response.arrayBuffer()) };
};

beforeAll(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "nr-system-")));
  root = join(top, ".nouride");
  put("config.toml", "[daemon]\n");
  put("data/.control-token", "the-control-token");
  put("encryption.key", "k".repeat(64 * 1024));
  put("data/nouride.db", "SQLite format 3\0");
  put("workspace/notes.md", `# Notes\n\nThe deploy key is ${GITHUB_TOKEN} and the gateway's is ${STORED}.\n`);
  put("workspace/plain.md", "nothing to hide here\n");
  put("workspace/long.txt", "a".repeat(500 * 1024));
  put("workspace/blob.bin", new Uint8Array([1, 2, 0, 3, 4]));
  put("workspace/shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  put("workspace/page.html", "<script>alert(1)</script>");
  put("workspace/clip.mp4", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 9, 8, 7, 6]));
  put("workspace/voice.oga", new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2]));
  put("workspace/report.pdf", "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
  // Longer than what a page is sent, with a token past where the page's reading ends.
  put("workspace/long-log.txt", `${"a".repeat(450 * 1024)}\nthe key is ${GITHUB_TOKEN}\n`);
  // A token cut in two by where a long file's check reads its second piece.
  put("workspace/edge-log.txt", `${"b".repeat(1024 * 1024 - 13)} ${GITHUB_TOKEN}\n${"c".repeat(2048)}`);
  put('workspace/we"ird\u00e9.txt', "named oddly\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  const control = new Hono();
  control.use("*", async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set("principal", ACCOUNTS[as]);
    await next();
  });
  registerSystemRoutes(control as unknown as ControlApp, {
    ctx: { config, configSource: join(root, "config.toml"), startedAt: Date.now() - 90_000 },
    secrets: { knownValues: () => ({ GATEWAY_KEY: STORED, SHORT: "abc" }) },
    registry: { all: () => [{ config: { id: "nix" } }] },
    missions: { running: () => missions },
    jobs: { list: () => jobs },
    audit: { record: (entry: (typeof audited)[number]) => audited.push(entry) },
  } as unknown as ControlDeps);
  app = control;
});
afterAll(() => rmSync(top, { recursive: true, force: true }));
beforeEach(() => {
  as = "admin";
  missions = [];
  jobs = [];
  audited.length = 0;
});

describe("the System page is an admin's", () => {
  test("an operator and a viewer are refused at each of its routes, in words a page can say", async () => {
    for (const who of ["operator", "viewer"] as const) {
      as = who;
      for (const path of [
        "/system",
        "/system/folder-sizes",
        "/system/files",
        "/system/files?path=workspace",
        "/system/files/read?path=workspace/plain.md",
        "/system/files/raw?path=workspace/shot.png",
        "/system/files/download?path=workspace/plain.md",
        "/system/files/download?path=workspace/plain.md&check=1",
        "/system/files/weigh?path=workspace/plain.md",
      ]) {
        const refused = await ask(path);
        expect({ who, path, status: refused.status, body: refused.body }).toEqual({ who, path, status: 403, body: { error: "admin only", plain: "Only an admin can open the System page." } });
      }
      // And nothing is deleted for them.
      put("workspace/theirs.txt");
      const refused = await erase("workspace/theirs.txt");
      expect({ who, status: refused.status, body: refused.body }).toEqual({ who, status: 403, body: { error: "admin only", plain: "Only an admin can open the System page." } });
      expect(existsSync(join(root, "workspace/theirs.txt"))).toBe(true);
    }
    expect(audited).toEqual([]);
  });
});

describe("what the machine is using", () => {
  test("is read from this machine: its own process, what is in use of what there is, the disk the folder is on", async () => {
    const { status, body } = await ask("/system");
    expect(status).toBe(200);
    const overview = body as unknown as SystemOverview;
    expect(overview.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(overview.uptimeSeconds).toBeGreaterThanOrEqual(90);
    expect(overview.uptimeSeconds).toBeLessThan(120);
    expect(overview.cores).toBeGreaterThanOrEqual(1);
    expect(overview.folder).toBe(root);
    // This process holds memory, and less than the machine has.
    expect(overview.memory.daemonBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(overview.memory.totalBytes).toBeGreaterThan(overview.memory.daemonBytes);
    if (overview.memory.usedBytes !== null) expect(overview.memory.usedBytes).toBeGreaterThan(0);
    // A test's daemon has no group for its commands: said as nothing, not as zero bytes.
    expect(overview.memory.commands).toBeNull();
    expect(overview.disk!.totalBytes).toBeGreaterThan(0);
    expect(overview.disk!.freeBytes).toBeLessThanOrEqual(overview.disk!.totalBytes);
  });

  test("the folder's size is measured after it is asked for, and names only what Files lists", async () => {
    const first = (await ask("/system/folder-sizes")).body as unknown as SystemFolderSizes;
    expect(["measuring", "ready"]).toContain(first.state);
    let sizes = first;
    // Asked again until the count is in: each look starts the next ask.
    await eventually(
      () => {
        void ask("/system/folder-sizes").then((answer) => (sizes = answer.body as unknown as SystemFolderSizes));
        return sizes.state === "ready";
      },
      15_000,
      "the folder measured",
    );
    expect(sizes.measuredAt).toBeGreaterThan(Date.now() - 60_000);
    expect(sizes.totalBytes).toBeGreaterThan(500 * 1024);
    // The store's key is on the disk and in the total, and is not named.
    expect(sizes.entries.map((entry) => entry.name).sort()).toEqual(["config.toml", "data", "workspace"]);
    expect(sizes.totalBytes!).toBeGreaterThanOrEqual(sizes.entries.reduce((sum, entry) => sum + entry.bytes, 0) + 64 * 1024);
    // Largest first: the workspace holds the half megabyte.
    expect(sizes.entries[0]!.name).toBe("workspace");
    // Each says what kind of thing it is, as Files does.
    expect(Object.fromEntries(sizes.entries.map((entry) => [entry.name, entry.kind]))).toEqual({ "config.toml": "file", data: "folder", workspace: "folder" });
    expect(sizes.entries[0]!.bytes).toBeGreaterThan(400 * 1024);
  });
});

describe("the data folder, to read", () => {
  test("a folder's listing, and the root's when no path is given", async () => {
    const rootListing = (await ask("/system/files")).body as unknown as SystemFolderListing;
    expect(rootListing.entries.map((entry) => entry.name)).toEqual(["data", "workspace", "config.toml"]);
    const data = (await ask("/system/files?path=data")).body as unknown as SystemFolderListing;
    expect(data).toMatchObject({ path: "data", leftOut: true, more: 0 });
    expect(data.entries).toEqual([expect.objectContaining({ name: "nouride.db", closed: "database" })]);
  });

  test("a path to a file, asked for as a folder, answers that file: what a link from a chat opens", async () => {
    const at = (await ask("/system/files?path=workspace/plain.md")).body as unknown as SystemFolderListing;
    expect(at).toEqual({ path: "workspace/plain.md", entries: [], more: 0, leftOut: false, file: expect.objectContaining({ name: "plain.md", kind: "file", sizeBytes: 21, removable: true }) });
    // One of Nouride's own opens the same, and is not marked as something to delete.
    const own = (await ask("/system/files?path=config.toml")).body as unknown as SystemFolderListing;
    expect(own.file).toMatchObject({ name: "config.toml" });
    expect(own.file!.removable).toBeUndefined();
  });

  test("each refusal has its status and a sentence for the person", async () => {
    const said = async (path: string) => {
      const answer = await ask(path);
      return { status: answer.status, reason: answer.body?.reason, plain: answer.body?.plain };
    };
    expect(await said("/system/files?path=../")).toEqual({ status: 400, reason: "outside", plain: "That is not in this box's data folder." });
    expect(await said("/system/files?path=workspace/gone")).toEqual({ status: 404, reason: "missing", plain: "It is no longer there." });
    expect(await said("/system/files/read?path=data/.control-token")).toEqual({ status: 403, reason: "left-out", plain: "This is kept private: credentials and secrets are not shown here." });
    expect(await said("/system/files/read?path=data/nouride.db")).toEqual({ status: 403, reason: "database", plain: "The database does not open here." });
    expect(await said("/system/files/read?path=workspace")).toEqual({ status: 400, reason: "a-folder", plain: "That is a folder, not a file." });
    // Asked for as a folder, the database says what it is; a link to it from a chat lands here.
    expect(await said("/system/files?path=data/nouride.db")).toEqual({ status: 403, reason: "database", plain: "The database does not open here." });
    expect(await said("/system/files/raw?path=data/.control-token")).toMatchObject({ status: 403, reason: "left-out" });
  });

  test("a file's words are sent as they are, and say nothing was masked", async () => {
    const opened = (await ask("/system/files/read?path=workspace/plain.md")).body as unknown as SystemFileOpened;
    expect(opened).toEqual({ entry: expect.objectContaining({ name: "plain.md", path: "workspace/plain.md", sizeBytes: 21 }), kind: "text", text: "nothing to hide here\n", truncated: false, masked: false });
  });

  test("a value the secret store holds and anything shaped like a credential are masked in a file's words", async () => {
    const opened = (await ask("/system/files/read?path=workspace/notes.md")).body as unknown as SystemFileOpened;
    expect(opened.kind).toBe("text");
    expect(opened.masked).toBe(true);
    expect(opened.text).not.toContain(GITHUB_TOKEN);
    expect(opened.text).not.toContain(STORED);
    // What is around them stays: a person still reads what the line is about.
    expect(opened.text).toContain("# Notes");
    expect(opened.text).toContain("The deploy key is ");
    expect(opened.text).toContain("and the gateway's is ");
    // Said as hidden, with what kind of thing it was.
    expect(opened.text).toMatch(/The deploy key is \[hidden: [^\]]+\]/);
  });

  test("a long file is its beginning and says so; one that is not words is not sent as words", async () => {
    const long = (await ask("/system/files/read?path=workspace/long.txt")).body as unknown as SystemFileOpened;
    expect(long).toMatchObject({ kind: "text", truncated: true });
    expect(long.text!.length).toBe(400 * 1024);
    const blob = (await ask("/system/files/read?path=workspace/blob.bin")).body as unknown as SystemFileOpened;
    expect(blob).toEqual({ entry: expect.objectContaining({ name: "blob.bin", sizeBytes: 5 }), kind: "other" });
  });

  test("a picture is fetched as a picture, its type said and never guessed; nothing else is handed over that way", async () => {
    expect(((await ask("/system/files/read?path=workspace/shot.png")).body as unknown as SystemFileOpened).kind).toBe("picture");
    const picture = await ask("/system/files/raw?path=workspace/shot.png");
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");
    expect(picture.headers.get("x-content-type-options")).toBe("nosniff");
    expect(picture.headers.get("cache-control")).toBe("private, no-store");
    expect([...picture.bytes!]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    // A page of script asked for as bytes: refused, so it is never served from the dashboard's own address.
    const page = await ask("/system/files/raw?path=workspace/page.html");
    expect({ status: page.status, plain: page.body?.plain }).toEqual({ status: 400, plain: "Only a picture, a video, a sound or a PDF is shown this way." });
    expect(((await ask("/system/files/read?path=workspace/page.html")).body as unknown as SystemFileOpened)).toMatchObject({ kind: "text", text: "<script>alert(1)</script>" });
  });

  test("a video, a sound and a PDF are told by their names, and read as that", async () => {
    const kind = async (name: string) => ((await ask(`/system/files/read?path=workspace/${name}`)).body as unknown as SystemFileOpened).kind;
    expect(await kind("clip.mp4")).toBe("video");
    expect(await kind("voice.oga")).toBe("audio");
    expect(await kind("report.pdf")).toBe("pdf");
    // Its words are not sent with it: a PDF's are not what a person reads.
    expect((await ask("/system/files/read?path=workspace/report.pdf")).body).toEqual({ entry: expect.objectContaining({ name: "report.pdf" }), kind: "pdf" });
  });

  test("a video's bytes are handed over in the ranges a player asks for", async () => {
    const whole = await ask("/system/files/raw?path=workspace/clip.mp4");
    expect({ status: whole.status, type: whole.headers.get("content-type"), ranges: whole.headers.get("accept-ranges"), length: whole.headers.get("content-length") }).toEqual({ status: 200, type: "video/mp4", ranges: "bytes", length: "12" });
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    const part = await ask("/system/files/raw?path=workspace/clip.mp4", { headers: { range: "bytes=4-7" } });
    expect({ status: part.status, range: part.headers.get("content-range"), length: part.headers.get("content-length") }).toEqual({ status: 206, range: "bytes 4-7/12", length: "4" });
    expect([...part.bytes!]).toEqual([0x66, 0x74, 0x79, 0x70]);
    const past = await ask("/system/files/raw?path=workspace/clip.mp4", { headers: { range: "bytes=40-" } });
    expect({ status: past.status, range: past.headers.get("content-range") }).toEqual({ status: 416, range: "bytes */12" });
    expect((await ask("/system/files/raw?path=workspace/voice.oga")).headers.get("content-type")).toBe("audio/ogg");
    // Shown, each of them, and said so: a player is not handed a file to save.
    expect(whole.headers.get("content-disposition")).toBe('inline; filename="clip.mp4"');
    expect(part.headers.get("content-disposition")).toBe('inline; filename="clip.mp4"');
  });

  test("a PDF is handed to the browser's own reader: its type said, nothing sniffed, shown and not saved", async () => {
    const pdf = await ask("/system/files/raw?path=workspace/report.pdf");
    expect({ status: pdf.status, type: pdf.headers.get("content-type"), sniff: pdf.headers.get("x-content-type-options"), shown: pdf.headers.get("content-disposition") }).toEqual({ status: 200, type: "application/pdf", sniff: "nosniff", shown: 'inline; filename="report.pdf"' });
  });
});

describe("a file to keep", () => {
  const download = (path: string, check = false) => ask(`/system/files/download?path=${encodeURIComponent(path)}${check ? "&check=1" : ""}`);

  test("is its bytes as they are, saved under its name and never shown", async () => {
    const plain = await download("workspace/plain.md");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("application/octet-stream");
    expect(plain.headers.get("content-disposition")).toBe('attachment; filename="plain.md"');
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    expect(plain.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(plain.bytes!)).toBe("nothing to hide here\n");
    // What a page would run is a file to save like any other.
    const page = await download("workspace/page.html");
    expect({ type: page.headers.get("content-type"), saved: page.headers.get("content-disposition") }).toEqual({ type: "application/octet-stream", saved: 'attachment; filename="page.html"' });
    // What is not words, and what a browser would show: handed over as they are.
    expect([...(await download("workspace/blob.bin")).bytes!]).toEqual([1, 2, 0, 3, 4]);
    expect((await download("workspace/clip.mp4")).headers.get("content-disposition")).toBe('attachment; filename="clip.mp4"');
    // A name a header cannot carry is made one it can.
    expect((await download('workspace/we"ird\u00e9.txt')).headers.get("content-disposition")).toBe('attachment; filename="we_ird_.txt"');
  });

  test("asked first, it says only whether it would be handed over", async () => {
    const asked = await download("workspace/plain.md", true);
    expect({ status: asked.status, body: asked.body }).toEqual({ status: 200, body: { ok: true } });
    expect((await download("workspace/blob.bin", true)).body).toEqual({ ok: true });
  });

  test("a file in whose words something would be masked is not handed over, asked first or not", async () => {
    const said = { status: 403, reason: "masked", plain: "Something in this file looks like a credential, so it is not downloaded from here." };
    for (const check of [true, false]) {
      const refused = await download("workspace/notes.md", check);
      expect({ status: refused.status, reason: refused.body?.reason, plain: refused.body?.plain }).toEqual(said);
    }
  });

  test("all of a long file is read first: a token past what the page shows, and one cut in two by a piece's end", async () => {
    // The page's reading ends before it, and says nothing was masked there.
    expect((await ask("/system/files/read?path=workspace/long-log.txt")).body).toMatchObject({ kind: "text", truncated: true, masked: false });
    expect((await download("workspace/long-log.txt")).body).toMatchObject({ reason: "masked" });
    expect((await download("workspace/edge-log.txt")).body).toMatchObject({ reason: "masked" });
    // A long file with nothing in it to mask is handed over whole.
    const long = await download("workspace/long.txt");
    expect({ status: long.status, bytes: long.bytes!.length }).toEqual({ status: 200, bytes: 500 * 1024 });
  });

  test("a file that has changed since it was asked about is read again", async () => {
    put("workspace/draft.txt", "nothing yet\n");
    expect((await download("workspace/draft.txt", true)).body).toEqual({ ok: true });
    put("workspace/draft.txt", `nothing yet\nthe key is ${GITHUB_TOKEN}\n`);
    expect((await download("workspace/draft.txt")).body).toMatchObject({ reason: "masked" });
    put("workspace/draft.txt", "nothing, again\n");
    expect((await download("workspace/draft.txt")).status).toBe(200);
  });

  test("a secret, the database and what is outside are refused as they are when read", async () => {
    const said = async (path: string) => {
      const answer = await download(path);
      return { status: answer.status, reason: answer.body?.reason };
    };
    expect(await said("data/.control-token")).toEqual({ status: 403, reason: "left-out" });
    expect(await said("encryption.key")).toEqual({ status: 403, reason: "left-out" });
    expect(await said("data/nouride.db")).toEqual({ status: 403, reason: "database" });
    expect(await said("../outside.txt")).toEqual({ status: 400, reason: "outside" });
    expect(await said("workspace")).toEqual({ status: 400, reason: "a-folder" });
    expect(await said("workspace/gone.md")).toEqual({ status: 404, reason: "missing" });
  });
});

describe("deleting what agents left behind", () => {
  const weighed = async (path: string) => {
    const answer = await ask(`/system/files/weigh?path=${encodeURIComponent(path)}`);
    return { status: answer.status, body: answer.body };
  };

  test("the question before it: what it is, how many files and how much of the disk", async () => {
    put("workspace/shared/report/out/a.bin", "a".repeat(64 * 1024));
    put("workspace/shared/report/out/b.bin", "b".repeat(64 * 1024));
    put("workspace/shared/report/BRIEF.md", "the brief\n");
    const folder = (await weighed("workspace/shared/report")).body as unknown as SystemFileWeight;
    expect(folder).toMatchObject({ entry: { name: "report", path: "workspace/shared/report", kind: "folder" }, files: 3, more: false });
    expect(folder.bytes).toBeGreaterThanOrEqual(128 * 1024);
    expect((await weighed("workspace/shared/report/BRIEF.md")).body).toMatchObject({ entry: { name: "BRIEF.md", kind: "file" }, files: 1, more: false, bytes: 10 });
    // Asking deletes nothing.
    expect(existsSync(join(root, "workspace/shared/report/BRIEF.md"))).toBe(true);
    expect(audited).toEqual([]);
  });

  test("a file is deleted, a folder with all that is in it, and each is written down with who did it", async () => {
    put("workspace/shared/old/a.txt");
    put("workspace/shared/old/deep/b.txt");
    put("workspace/shared/single.txt");
    expect(await erase("workspace/shared/single.txt")).toMatchObject({ status: 200, body: { ok: true, path: "workspace/shared/single.txt" } });
    expect(await erase("workspace/shared/old")).toMatchObject({ status: 200, body: { ok: true, path: "workspace/shared/old" } });
    expect([existsSync(join(root, "workspace/shared/single.txt")), existsSync(join(root, "workspace/shared/old"))]).toEqual([false, false]);
    // What was beside them stays.
    expect(existsSync(join(root, "workspace/shared/report/BRIEF.md"))).toBe(true);
    expect(audited).toEqual([
      { action: "system_file_deleted", actor: "gading", details: { path: "workspace/shared/single.txt", kind: "file", deleted: true } },
      { action: "system_file_deleted", actor: "gading", details: { path: "workspace/shared/old", kind: "folder", deleted: true } },
    ]);
  });

  test("what Nouride keeps for itself is not deleted: its config, its database, the folders it lays out, a secret", async () => {
    const kept = { status: 403, reason: "kept", plain: "Nouride keeps this for itself, so it is not deleted from here." };
    for (const path of ["config.toml", "workspace", "workspace/shared", "data", "data/nouride.db"]) {
      for (const answer of [await weighed(path), await erase(path)]) expect({ path, status: answer.status, reason: answer.body?.reason, plain: answer.body?.plain }).toEqual({ path, ...kept });
    }
    expect((await erase("data/.control-token")).body).toMatchObject({ reason: "left-out" });
    expect((await erase("../outside.txt")).body).toMatchObject({ reason: "outside" });
    expect((await erase("workspace/shared/gone.txt")).status).toBe(404);
    for (const path of ["config.toml", "data/nouride.db", "data/.control-token", "workspace/shared"]) expect({ path, there: existsSync(join(root, path)) }).toEqual({ path, there: true });
    expect(existsSync(join(top, "outside.txt"))).toBe(false);
    expect(audited).toEqual([]);
  });

  test("a delete that names nothing is refused, and deletes nothing", async () => {
    for (const path of [undefined, "", 7, null]) {
      const answer = await erase(path);
      expect({ status: answer.status, plain: answer.body?.plain }).toEqual({ status: 400, plain: "Nothing was named to delete." });
    }
    const empty = await ask("/system/files/delete", { method: "POST" });
    expect(empty.status).toBe(400);
    expect(existsSync(join(root, "workspace/plain.md"))).toBe(true);
  });

  // Root deletes from a folder whatever its mode says: nothing to hold back, so nothing to see.
  test.skipIf(process.getuid?.() === 0)("what could not be deleted is said so, and written down as asked for and not done", async () => {
    put("workspace/shared/locked/inner.txt");
    chmodSync(join(root, "workspace/shared/locked"), 0o555);
    try {
      const answer = await erase("workspace/shared/locked/inner.txt");
      expect({ status: answer.status, plain: answer.body?.plain }).toEqual({ status: 500, plain: "Not all of it could be deleted: part of it belongs to another user on this machine." });
      expect(existsSync(join(root, "workspace/shared/locked/inner.txt"))).toBe(true);
      expect(audited).toEqual([{ action: "system_file_deleted", actor: "gading", details: { path: "workspace/shared/locked/inner.txt", kind: "file", deleted: false } }]);
    } finally {
      chmodSync(join(root, "workspace/shared/locked"), 0o755);
    }
  });

  test("while a mission or a job is working there it waits, and says which", async () => {
    put("workspace/shared/busy/out.txt");
    missions = [{ workdir: join(root, "workspace/shared/busy") }];
    const mission = { status: 409, reason: "in-use", plain: "A mission is still working here. Delete it once the mission has ended." };
    for (const answer of [await weighed("workspace/shared/busy/out.txt"), await erase("workspace/shared/busy/out.txt"), await erase("workspace/shared/busy")]) expect({ status: answer.status, reason: answer.body?.reason, plain: answer.body?.plain }).toEqual(mission);
    missions = [];
    // A job that has ended holds nothing; one that runs does.
    jobs = [{ status: "succeeded", cwd: join(root, "workspace/shared/busy"), logPath: join(root, "jobs/nix/job_1.log") }];
    expect((await weighed("workspace/shared/busy")).status).toBe(200);
    jobs = [{ status: "running", cwd: join(root, "workspace/shared/busy"), logPath: join(root, "jobs/nix/job_1.log") }];
    const job = await erase("workspace/shared/busy");
    expect({ status: job.status, reason: job.body?.reason, plain: job.body?.plain }).toEqual({ status: 409, reason: "in-use", plain: "A background job is still running here. Delete it once the job has ended." });
    expect(existsSync(join(root, "workspace/shared/busy/out.txt"))).toBe(true);
    expect(audited).toEqual([]);
    jobs = [];
    expect((await erase("workspace/shared/busy")).status).toBe(200);
    expect(existsSync(join(root, "workspace/shared/busy"))).toBe(false);
  });
});
