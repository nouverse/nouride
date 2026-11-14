/**
 * Deleting from System's Files (`system-remove.ts`): what the question before it says, what holds it back, and who
 * deletes. On folders of the test's making; an agent's own user is stood in for by a command line that writes down
 * which agent it was run as, since a test has no second user to be.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { findRemovable } from "@/modules/web/control/system-files.ts";
import { countFiles, remove, usedBy, weigh } from "@/modules/web/control/system-remove.ts";

let top: string;
let root: string;

const put = (path: string, text = "x") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const found = (path: string) => {
  const at = findRemovable(root, path);
  if (!at.ok) throw new Error(`${path}: ${at.reason}`);
  return at;
};
const there = (path: string) => {
  try {
    lstatSync(join(root, path));
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "nr-remove-")));
  root = join(top, ".nouride");
  put("data/nouride.db", "the database");
  put("agents/nouva/MEMORY.md", "remembered");
});
afterAll(() => rmSync(top, { recursive: true, force: true }));
afterEach(() => runAgentCommandsThrough(null));

describe("what a delete would take", () => {
  test("a folder's files are counted, each link as one and never followed", () => {
    for (const path of ["a.txt", "b/c.txt", "b/d/e.txt", "b/d/f.txt"]) put(`workspace/shared/count/${path}`);
    mkdirSync(join(root, "workspace/shared/count/empty"));
    // A link to a folder of many files: one file here.
    for (let n = 0; n < 30; n += 1) put(`workspace/shared/many/file-${n}.txt`);
    symlinkSync(join(root, "workspace/shared/many"), join(root, "workspace/shared/count/link"));
    expect(countFiles(join(root, "workspace/shared/count"))).toEqual({ files: 5, more: false });
    expect(countFiles(join(root, "workspace/shared/many"))).toEqual({ files: 30, more: false });
  });

  test("past its ceiling the count stops and says there are more", () => {
    expect(countFiles(join(root, "workspace/shared/many"), 10)).toEqual({ files: 10, more: true });
    expect(countFiles(join(root, "workspace/shared/many"), 30)).toEqual({ files: 30, more: false });
  });

  test("a file is itself; a folder is its files and what it takes on disk, as the system counts it", async () => {
    put("workspace/shared/big/one.bin", "a".repeat(300 * 1024));
    put("workspace/shared/big/sub/two.bin", "b".repeat(200 * 1024));
    const file = await weigh(found("workspace/shared/big/one.bin"));
    expect(file).toEqual({ entry: expect.objectContaining({ name: "one.bin", kind: "file" }), files: 1, more: false, bytes: 300 * 1024 });
    const folder = await weigh(found("workspace/shared/big"));
    expect(folder).toMatchObject({ entry: { name: "big", kind: "folder" }, files: 2, more: false });
    expect(folder.bytes).toBeGreaterThanOrEqual(500 * 1024);
    expect(folder.bytes).toBeLessThan(2 * 1024 * 1024);
  });

  test("the size is asked of the folder itself, and one that cannot be measured is said as not known", async () => {
    const asked: string[][] = [];
    const sized = await weigh(found("workspace/shared/big"), async (cmd) => (asked.push(cmd), { stdout: "1234\t/somewhere\n", timedOut: false }));
    expect(asked).toEqual([["du", "-sk", "--", join(root, "workspace/shared/big")]]);
    expect(sized.bytes).toBe(1234 * 1024);
    expect((await weigh(found("workspace/shared/big"), async () => ({ stdout: "1234\t/somewhere\n", timedOut: true }))).bytes).toBeNull();
    expect((await weigh(found("workspace/shared/big"), async () => ({ stdout: "du: not found\n", timedOut: false }))).bytes).toBeNull();
    expect((await weigh(found("workspace/shared/big"), async () => Promise.reject(new Error("no such program")))).bytes).toBeNull();
  });

  test("a link is said as a link, of no size: what it leads to stays, and is not counted", async () => {
    symlinkSync(join(root, "workspace/shared/big"), join(root, "workspace/shared/link-big"));
    const ran: string[][] = [];
    expect(await weigh(found("workspace/shared/link-big"), async (cmd) => (ran.push(cmd), { stdout: "", timedOut: false }))).toEqual({ entry: expect.objectContaining({ name: "link-big", kind: "file" }), files: 1, more: false, bytes: null, link: true });
    expect(ran).toEqual([]);
  });
});

describe("whether something is working there", () => {
  const working = (missions: (string | null)[], jobs: { cwd: string; logPath: string }[] = []) => ({ missions: () => missions.map((workdir) => ({ workdir })), jobs: () => jobs });
  const at = (path: string) => join(root, path);

  beforeAll(() => {
    for (const path of ["workspace/shared/report/out/chart.png", "workspace/shared/report/BRIEF.md", "workspace/shared/other/notes.md", "workspace/private/nix/app/src/index.ts", "workspace/private/nix/old.mp4", "jobs/nix/job_1.log", "jobs/nix/job_2.log"]) put(path);
  });

  test("a running mission holds its folder, what its folder is in, and every file of it", () => {
    const mission = working([at("workspace/shared/report")]);
    expect(usedBy(found("workspace/shared/report"), root, mission)).toBe("mission");
    expect(usedBy(found("workspace/shared/report/out"), root, mission)).toBe("mission");
    expect(usedBy(found("workspace/shared/report/out/chart.png"), root, mission)).toBe("mission");
    expect(usedBy(found("workspace/shared/report/BRIEF.md"), root, mission)).toBe("mission");
    // Beside it, nothing of its own.
    expect(usedBy(found("workspace/shared/other"), root, mission)).toBeNull();
    expect(usedBy(found("workspace/shared/other/notes.md"), root, mission)).toBeNull();
    // A name that only begins as its folder's does.
    put("workspace/shared/report-old/notes.md");
    expect(usedBy(found("workspace/shared/report-old"), root, mission)).toBeNull();
  });

  test("a mission in a folder inside what would be deleted holds it too", () => {
    expect(usedBy(found("workspace/shared/report"), root, working([at("workspace/shared/report/out")]))).toBe("mission");
  });

  test("a running job holds the folder it runs in and its log", () => {
    const job = working([], [{ cwd: at("workspace/private/nix/app"), logPath: at("jobs/nix/job_1.log") }]);
    expect(usedBy(found("workspace/private/nix/app"), root, job)).toBe("job");
    expect(usedBy(found("workspace/private/nix/app/src/index.ts"), root, job)).toBe("job");
    expect(usedBy(found("jobs/nix/job_1.log"), root, job)).toBe("job");
    expect(usedBy(found("jobs/nix/job_2.log"), root, job)).toBeNull();
    expect(usedBy(found("workspace/private/nix/old.mp4"), root, job)).toBeNull();
  });

  test("a job that runs in an agent's whole workspace does not hold every file that agent has", () => {
    const job = working([], [{ cwd: at("workspace/private/nix"), logPath: at("jobs/nix/job_1.log") }]);
    expect(usedBy(found("workspace/private/nix/old.mp4"), root, job)).toBeNull();
    expect(usedBy(found("workspace/private/nix/app"), root, job)).toBeNull();
    // The same of a mission given the shared folder itself to work in.
    expect(usedBy(found("workspace/shared/other"), root, working([at("workspace/shared")]))).toBeNull();
  });

  test("nothing running, a mission with no folder yet and one outside the data folder hold nothing", () => {
    expect(usedBy(found("workspace/shared/report"), root, working([]))).toBeNull();
    expect(usedBy(found("workspace/shared/report"), root, working([null, "", join(top, "elsewhere")]))).toBeNull();
    expect(usedBy(found("workspace/shared/report/BRIEF.md"), root, working([top]))).toBeNull();
  });

  test("a folder named through a link is the folder it leads to", () => {
    symlinkSync(join(root, "workspace/shared/report"), join(top, "report-link"));
    expect(usedBy(found("workspace/shared/report/BRIEF.md"), root, working([join(top, "report-link")]))).toBe("mission");
  });
});

describe("the deleting", () => {
  /** Stands in for the helper: writes down the agent it was asked to run as, then runs the command or, for `lazy`, does not. */
  const asAgents = () => {
    const log = join(top, `ran-${Math.random().toString(36).slice(2)}.log`);
    runAgentCommandsThrough({ prefix: (agent) => ["/bin/sh", "-c", `echo "$0" >> '${log}'; case "$0" in lazy*) exit 1;; esac; exec "$@"`, agent], put: () => [] });
    return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  };

  test("where agents run as the daemon's user, the daemon deletes: a file, a folder whole, a link and not what it leads to", async () => {
    put("workspace/shared/gone/a.txt");
    put("workspace/shared/gone/sub/b.txt");
    put("workspace/shared/single.txt");
    put("workspace/shared/kept/c.txt");
    symlinkSync(join(root, "workspace/shared/kept"), join(root, "workspace/shared/link-kept"));
    symlinkSync(join(root, "data/nouride.db"), join(root, "workspace/shared/link-db"));
    expect(await remove(found("workspace/shared/single.txt"), ["nix"])).toBe(true);
    expect(await remove(found("workspace/shared/gone"), ["nix"])).toBe(true);
    expect(await remove(found("workspace/shared/link-kept"), ["nix"])).toBe(true);
    expect(await remove(found("workspace/shared/link-db"), ["nix"])).toBe(true);
    expect([there("workspace/shared/single.txt"), there("workspace/shared/gone"), there("workspace/shared/link-kept"), there("workspace/shared/link-db")]).toEqual([false, false, false, false]);
    expect(readFileSync(join(root, "workspace/shared/kept/c.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(root, "data/nouride.db"), "utf8")).toBe("the database");
  });

  test("an agent's own folder is emptied as that agent, and as no other", async () => {
    const ran = asAgents();
    put("workspace/private/nix/build/out.bin");
    expect(await remove(found("workspace/private/nix/build"), ["nouva", "nix", "nox"])).toBe(true);
    expect(there("workspace/private/nix/build")).toBe(false);
    expect(ran()).toEqual(["nix"]);
  });

  test("the shared folder is emptied as each agent in turn, until it is gone", async () => {
    const ran = asAgents();
    put("workspace/shared/handover/a.txt");
    expect(await remove(found("workspace/shared/handover"), ["lazy-1", "lazy-2", "nix", "nox"])).toBe(true);
    expect(there("workspace/shared/handover")).toBe(false);
    expect(ran()).toEqual(["lazy-1", "lazy-2", "nix"]);
  });

  test("what no agent could delete, the daemon then does itself: the folder of an agent that is gone", async () => {
    const ran = asAgents();
    put("workspace/private/old-agent/notes.md");
    put("workspace/shared/stuck/a.txt");
    expect(await remove(found("workspace/private/old-agent/notes.md"), ["nix"])).toBe(true);
    expect(await remove(found("workspace/shared/stuck"), ["lazy-1"])).toBe(true);
    expect([there("workspace/private/old-agent/notes.md"), there("workspace/shared/stuck")]).toEqual([false, false]);
    // Nobody's own folder: no agent is asked for the first, and the one asked for the second did nothing.
    expect(ran()).toEqual(["lazy-1"]);
  });

  test("the daemon does not follow a folder an agent has turned into a link meanwhile", async () => {
    asAgents();
    put("workspace/shared/swap/nouride.db", "an agent's own file");
    const at = found("workspace/shared/swap/nouride.db");
    // Between the look and the delete: the folder becomes a link to the daemon's own.
    rmSync(join(root, "workspace/shared/swap"), { recursive: true });
    symlinkSync(join(root, "data"), join(root, "workspace/shared/swap"));
    expect(await remove(at, ["lazy-1"])).toBe(false);
    expect(readFileSync(join(root, "data/nouride.db"), "utf8")).toBe("the database");
  });

  // Root deletes from a folder whatever its mode says: nothing to hold back, so nothing to see.
  test.skipIf(process.getuid?.() === 0)("what could not be deleted is said as still there, never as gone", async () => {
    put("workspace/shared/locked/inner.txt");
    const at = found("workspace/shared/locked/inner.txt");
    chmodSync(join(root, "workspace/shared/locked"), 0o555);
    try {
      expect(await remove(at, ["nix"])).toBe(false);
      expect(there("workspace/shared/locked/inner.txt")).toBe(true);
    } finally {
      chmodSync(join(root, "workspace/shared/locked"), 0o755);
    }
    expect(await remove(at, ["nix"])).toBe(true);
  });

  test("the daemon's own folders are the daemon's to delete from, whoever the agents are", async () => {
    const ran = asAgents();
    put("attachments/nix/photo.png");
    put("jobs/nix/job_9.log");
    put("tool-output/nix/ses_1/out.txt");
    put("workspace/stray.txt");
    for (const path of ["attachments/nix/photo.png", "jobs/nix/job_9.log", "tool-output/nix/ses_1", "workspace/stray.txt"]) expect(await remove(found(path), ["nix"])).toBe(true);
    expect(ran()).toEqual([]);
    expect([there("attachments/nix/photo.png"), there("jobs/nix/job_9.log"), there("tool-output/nix/ses_1"), there("workspace/stray.txt")]).toEqual([false, false, false, false]);
    // The folders they were in stay.
    expect([there("attachments/nix"), there("jobs/nix"), there("tool-output/nix")]).toEqual([true, true, true]);
  });
});
