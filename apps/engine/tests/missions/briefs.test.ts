/**
 * What an agent writes for another model to act on — a brief — is in English and whole (0.8.8). The `ask_agent` task, the
 * `delegate` brief and a mission's goal and review were already refused unless English; two places were not: the brief
 * file a long mission goal points at (0.8.7: "write the detail to a file first"), read turn after turn and by the
 * reviewer, and a proposed job's `prompt` and mission, which each run starts from with nothing of the conversation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { Tool, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { briefFilesOf } from "@/modules/missions/start.ts";
import { readBrief as readBriefFile } from "@/boot/missions.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { missionsHarness } from "./harness.ts";

const ENGLISH_BRIEF = [
  "# v0.8.8: a brief",
  "",
  "Gading's decision: the preset stays `folder`. Run `bun test ./apps/engine/tests/missions/` and `du -sh /var/lib`, compare",
  "with the base, and write what is not verified. The owner said \"itu saja simple jangan dibikin ribet\" — keep it simple.",
  "",
  "| Part | Done when |",
  "|---|---|",
  "| A | /status shows what answers |",
].join("\n");
const INDONESIAN_BRIEF = "# Brief\n\nTolong cek semua log di server dan kirim laporan ke Gading kalau ada yang error. Jangan hapus apa pun tanpa izin dulu.";

describe("the brief file a mission goal points at", () => {
  const files: Record<string, string> = {
    "/work/nix/e2e/BRIEF.md": ENGLISH_BRIEF,
    "/work/nix/e2e/brief-id.md": INDONESIAN_BRIEF,
    "/work/nix/notes/plan.md": INDONESIAN_BRIEF,
    "/home/rina/docs/panduan.md": INDONESIAN_BRIEF,
  };
  const asked: string[] = [];
  const readBrief = (path: string) => (asked.push(path), files[path] ?? null);
  const byAgent = { byAgent: "nova", startedBy: "8142" };

  test("are the paths named a brief, or called one just before — not every document the goal mentions", () => {
    expect(briefFilesOf("Full brief, read first: /work/nix/e2e/BRIEF.md. Evidence goes to /work/nix/e2e/evidence.md.")).toEqual(["/work/nix/e2e/BRIEF.md"]);
    expect(briefFilesOf("Do what the brief at `/work/nix/notes/plan.md` says")).toEqual(["/work/nix/notes/plan.md"]);
    expect(briefFilesOf("Translate /home/rina/docs/panduan.md into English as /home/rina/docs/guide.md")).toEqual([]);
    expect(briefFilesOf('Read "/a/mission-brief.txt", then /a/BRIEF.md and /a/BRIEF.md again')).toEqual(["/a/mission-brief.txt", "/a/BRIEF.md"]);
    // "brief" about length names the person's document, which is the work.
    expect(briefFilesOf("Write a brief summary of /home/rina/laporan.md")).toEqual([]);
    expect(briefFilesOf("The brief at /a/plan.md, then a brief note in /a/notes.md")).toEqual(["/a/plan.md"]);
    expect(briefFilesOf("Keep it brief: translate /docs/panduan.md")).toEqual([]);
    expect(briefFilesOf("Summarise /work/rina/debrief-rapat.md for her")).toEqual([]);
  });

  test("the daemon reads one only where it is a plain file it can read whole — never a pipe, a device, a folder or a link (Nox's review)", () => {
    // A FIFO or `/dev/zero` read on the daemon's event loop stopped every agent and gateway.
    const dir = mkdtempSync(join(tmpdir(), "briefs-read-"));
    try {
      writeFileSync(join(dir, "BRIEF.md"), ENGLISH_BRIEF);
      expect(readBriefFile(join(dir, "BRIEF.md"))).toBe(ENGLISH_BRIEF);
      expect(spawnSync("mkfifo", [join(dir, "pipe-BRIEF.md")]).status).toBe(0);
      mkdirSync(join(dir, "dir-BRIEF.md"));
      writeFileSync(join(dir, "big-BRIEF.md"), "word ".repeat(20_000));
      symlinkSync("/dev/zero", join(dir, "zero-BRIEF.md"));
      const started = Date.now();
      for (const name of ["pipe-BRIEF.md", "dir-BRIEF.md", "big-BRIEF.md", "zero-BRIEF.md", "missing-BRIEF.md"]) expect(readBriefFile(join(dir, name))).toBeNull();
      expect(readBriefFile("/dev/zero")).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is read only for a start the day's count allows (Nox's review)", async () => {
    asked.length = 0;
    const h = await missionsHarness({ readBrief, settings: { perAgent: 30, maxRunning: 30 } });
    for (let i = 0; i < 20; i += 1) await h.start(`Job ${i}: check /work/nix/notes/${i}.md`, byAgent);
    await expect(h.start("Full brief, read first: /work/nix/e2e/brief-id.md", byAgent)).rejects.toThrow("missions in the last day");
    expect(asked).toEqual([]);
  });

  test("one not in English is refused at start with the write-in-English answer, and nothing starts", async () => {
    const h = await missionsHarness({ readBrief });
    await expect(h.start("Full brief, read first: /work/nix/e2e/brief-id.md", byAgent)).rejects.toThrow(
      "The brief file /work/nix/e2e/brief-id.md, which the goal points at, is not in English",
    );
    await expect(h.start("Do what the brief at /work/nix/notes/plan.md says", byAgent)).rejects.toThrow("write it again in English");
    expect(h.store.recent(10)).toEqual([]);
  });

  test("an English one passes — code, paths, a table and a person's words quoted in their language included", async () => {
    const h = await missionsHarness({ readBrief });
    const mission = await h.start("Full brief, read first: /work/nix/e2e/BRIEF.md", byAgent);
    expect(h.store.get(mission.id)?.goal).toBe("Full brief, read first: /work/nix/e2e/BRIEF.md");
  });

  test("a document the goal works on is not a brief, a file the daemon cannot read is the mission's to report, and a person's own mission is theirs", async () => {
    asked.length = 0;
    const h = await missionsHarness({ readBrief, settings: { perAgent: 5, maxRunning: 8 } });
    await h.start("Translate /home/rina/docs/panduan.md into English as /home/rina/docs/guide.md", byAgent);
    expect(asked).toEqual([]);
    await h.start("Full brief, read first: /work/nix/e2e/missing-BRIEF.md", byAgent);
    await h.start("Full brief, read first: /work/nix/e2e/brief-id.md", { startedBy: "8142" });
    expect(h.store.recent(10)).toHaveLength(3);
  });

  test("the goal's field says it must be whole, and where a long one goes", () => {
    const start = createMissionTools({} as never).chat.definition.parameters as { properties: { goal: { description: string } } };
    expect(start.properties.goal.description).toBe(
      "What must be true when it is done, in English, and whole: each turn starts from it, not from this conversation. A long one points at a brief file by its absolute path.",
    );
  });
});

describe("a proposed job's prompt and mission", () => {
  let dir = "";
  let db: SqliteDb;
  let store: CronStore;
  let tool: Tool;
  const DM = { agentId: "nouva", gatewayId: "telegram:main", chatId: "8142", senderId: "8142", workspaceRoots: [] } as unknown as ToolContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "briefs-"));
    db = openDatabase(join(dir, "t.db"));
    await migrate(db);
    store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta" });
    tool = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: (id) => id === "nouva", post: async () => true });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const propose = (args: Record<string, unknown>) => tool.execute({ name: "Morning check", when: "cron 0 7 * * *", ...args }, DM);

  test("a prompt, a mission goal or a review not in English is refused, and nothing is proposed", async () => {
    for (const [key, what] of [["prompt", "The `prompt`"], ["mission", "The `mission` goal"]] as const) {
      const result = await propose({ [key]: "Cek disk server dan kirim laporan kalau penuh." });
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toStartWith(`${what} is not in English`);
    }
    expect((await propose({ mission: "Check the disks and report when one is over 90%.", review: "Laporan sudah dikirim ke Rina dan Gading." })).content).toStartWith("The `review` is not in English");
    expect(store.list({ includeDisabled: true })).toEqual([]);
  });

  test("…and passes in English with commands, paths and a person's words quoted; `text` for the person is never judged", async () => {
    expect((await propose({ prompt: 'Run `du -sh /var/lib` and tell Rina "disknya hampir penuh" if it is over 50G.' })).isError).toBe(false);
    expect((await propose({ mission: "The nightly backup of /srv/data is on the NAS and `restic check` passes." })).isError).toBe(false);
    expect((await propose({ text: "Selamat pagi, jangan lupa minum obat dan sarapan dulu sebelum ke kantor ya." })).isError).toBe(false);
    // A review given with no mission is dropped with the call, so it is not judged either.
    expect((await propose({ prompt: "Check the disks.", review: "Laporan sudah dikirim ke Rina dan Gading." })).isError).toBe(false);
    expect(store.list({ includeDisabled: true })).toHaveLength(4);
  });

  test("a mission's goal pointing at a brief not in English is refused at proposal — a run's start does not read it (D6)", async () => {
    const briefs: Record<string, string> = { "/work/nouva/BRIEF.md": ENGLISH_BRIEF, "/work/nouva/brief-id.md": INDONESIAN_BRIEF };
    const reading = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: (id) => id === "nouva", post: async () => true, readBrief: (path) => briefs[path] ?? null });
    const offer = (mission: string) => reading.execute({ name: "Nightly audit", when: "cron 0 7 * * *", mission }, DM);
    const refused = await offer("Full brief, read first: /work/nouva/brief-id.md");
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toStartWith("The brief file /work/nouva/brief-id.md, which the goal points at, is not in English");
    expect(store.list({ includeDisabled: true })).toEqual([]);
    expect((await offer("Full brief, read first: /work/nouva/BRIEF.md")).isError).toBe(false);
  });

  test("the prompt's field says a run starts with none of this conversation", () => {
    const { properties } = tool.definition.parameters as { properties: Record<string, { description: string }> };
    expect(properties.prompt!.description).toBe("What you are woken with, in English, and whole: a run starts with none of this conversation.");
    expect(properties.mission!.description).toBe("Long work: each run's goal, as `mission` takes one.");
  });
});
