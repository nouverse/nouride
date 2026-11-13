/**
 * The System page's routes (`routes/system.ts`): an admin's alone; what the machine is using, read and never made up;
 * a folder's listing and a refusal's words; a file's words masked where they are sent; a picture's bytes handed over
 * so that nothing in them runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { SystemFileOpened, SystemFolderListing, SystemFolderSizes, SystemOverview } from "@nouride/wire";
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

const put = (path: string, content: string | Uint8Array = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const ask = async (path: string) => {
  const response = await app.request(path);
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
  } as unknown as ControlDeps);
  app = control;
});
afterAll(() => rmSync(top, { recursive: true, force: true }));
beforeEach(() => {
  as = "admin";
});

describe("the System page is an admin's", () => {
  test("an operator and a viewer are refused at each of its routes, in words a page can say", async () => {
    for (const who of ["operator", "viewer"] as const) {
      as = who;
      for (const path of ["/system", "/system/folder-sizes", "/system/files", "/system/files?path=workspace", "/system/files/read?path=workspace/plain.md", "/system/files/raw?path=workspace/shot.png"]) {
        const refused = await ask(path);
        expect({ who, path, status: refused.status, body: refused.body }).toEqual({ who, path, status: 403, body: { error: "admin only", plain: "Only an admin can open the System page." } });
      }
    }
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
    expect(await said("/system/files?path=workspace/plain.md")).toEqual({ status: 400, reason: "not-a-folder", plain: "That is a file, not a folder." });
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

  test("a picture is fetched as a picture, with headers that let nothing in it run; nothing else is handed over that way", async () => {
    expect(((await ask("/system/files/read?path=workspace/shot.png")).body as unknown as SystemFileOpened).kind).toBe("picture");
    const picture = await ask("/system/files/raw?path=workspace/shot.png");
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");
    expect(picture.headers.get("x-content-type-options")).toBe("nosniff");
    expect(picture.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(picture.headers.get("cache-control")).toBe("private, no-store");
    expect([...picture.bytes!]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    // A page of script asked for as bytes: refused, so it is never served from the dashboard's own address.
    const page = await ask("/system/files/raw?path=workspace/page.html");
    expect({ status: page.status, plain: page.body?.plain }).toEqual({ status: 400, plain: "Only a picture is shown this way." });
    expect(((await ask("/system/files/read?path=workspace/page.html")).body as unknown as SystemFileOpened)).toMatchObject({ kind: "text", text: "<script>alert(1)</script>" });
  });
});
