/**
 * What a person does while the nightly pass runs. A pass takes minutes — a model call per conversation —
 * and the dashboard's Run now puts one in the middle of an afternoon, so a delete, an approval or a tag
 * tidy landing inside one is ordinary. Each used to break a promise memory makes: a deleted
 * conversation's facts survived, a revision was dropped unapplied, a tidy cut short could not be undone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import { withFileLock } from "@/commons/file-lock.ts";
import type { Episode } from "@/modules/memory/episode.ts";
import { listProposals, propose } from "@/modules/memory/proposals.ts";
import { eventually, sleep } from "../helpers.ts";
import { GADING_DM, at, household, plant, scripted, type Household } from "./fixture.ts";

let h: Household;
const locked: string[] = [];

beforeEach(async () => {
  h = await household();
});

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  h.close();
});

/** A model that answers only when let go, so something can happen while it is being asked. */
function heldModel(answers: Parameters<typeof scripted>[0]) {
  const model = scripted(answers);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  return {
    ask: async (...args: Parameters<typeof model.ask>) => {
      asked += 1;
      await held;
      return await model.ask(...args);
    },
    release: () => release(),
    asked: () => asked,
  };
}

describe("while the pass asks its model", () => {
  test("a conversation deleted then keeps none of the facts it taught", async () => {
    h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3 sekarang", "Oke, dicatat.", at(9));
    const model = heldModel([{ when: "MacBook", answer: { summary: "Gading uses a MacBook M3.", facts: [{ person: "gading", op: "add", section: "Work", text: "Uses a MacBook M3." }] } }]);
    const pass = h.memory.pass(model.ask);
    await eventually(() => model.asked() > 0, 2_000);

    expect(await h.memory.deleteEpisode("2026-09-25-0900-nouva")).toMatchObject({ episodes: 1, facts: 0 });
    model.release();
    expect(await pass).toMatchObject({ filed: 0, applied: 0, failed: [] });
    expect((await readTextFileIfExists(h.vault.person("gading"))) ?? "").not.toContain("MacBook");
    expect(h.memory.episodes({}, 10)).toEqual([]);
  });

  test("a reindex waits for the pass, as the other jobs that rewrite the vault do", async () => {
    h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3 sekarang", "Oke, dicatat.", at(9));
    const model = heldModel([]);
    const order: string[] = [];
    const pass = h.memory.pass(model.ask).then(() => order.push("pass"));
    await eventually(() => model.asked() > 0, 2_000);
    const reindex = h.memory.reindex().then(() => order.push("reindex"));
    await sleep(20);
    model.release();
    await Promise.all([pass, reindex]);
    expect(order).toEqual(["pass", "reindex"]);
  });
});

describe("a proposal decided while it is revised", () => {
  test("the revision waits for the decision, and an addition approved meanwhile comes back as one of its own", async () => {
    const provenance = { source: "2026-09-25-0900-nouva", readers: { people: ["gading"] } };
    const first = await propose(h.vault, { episode: "2026-09-25-0900-nouva", subject: "gading", operation: { op: "add", section: "Work", text: "Uses a MacBook M3." }, provenance, why: "review" }, at(9));
    // Approving is held inside its profile edit, its proposal read; the pass then restates the same addition.
    let release!: () => void;
    const profile = withFileLock(h.vault.person("gading"), () => new Promise<void>((resolve) => (release = resolve)));
    const approving = h.memory.approve(first!.proposal.id);
    await sleep(10);
    const revising = propose(h.vault, { episode: "2026-09-26-0900-nouva", subject: "gading", operation: { op: "add", section: "Work", text: "Uses a MacBook M3 Pro." }, provenance, why: "review" }, at(10));
    await sleep(10);
    release();
    await profile;

    expect(await approving).toMatchObject({ status: "applied" });
    expect(await revising).toMatchObject({ merged: false });
    expect(await readTextFileIfExists(h.vault.person("gading"))).toContain("- Uses a MacBook M3. ([[2026-09-25-0900-nouva]]) {gading}");
    expect((await listProposals(h.vault)).map((proposal) => proposal.operation.op === "add" && proposal.operation.text)).toEqual(["Uses a MacBook M3 Pro."]);
  });
});

describe("a tag tidy cut short", () => {
  const tagged = (id: string, day: string, tags: string[]): Episode => ({
    id,
    status: "summarized",
    kind: "dm",
    chat: "telegram:nouva:814",
    started: `${day}T09:00:00+07:00`,
    ended: `${day}T09:05:00+07:00`,
    day,
    agents: ["nouva"],
    people: ["gading"],
    mentions: [],
    tags,
    related: [],
    summary: "Something worth keeping.",
    transcript: "09:00 · Gading\nHalo\n",
  });

  test("left its record behind first, so undo puts back what it had done", async () => {
    plant(h.vault, tagged("2026-10-01-0900-nouva", "2026-10-01", ["reminders"]));
    plant(h.vault, tagged("2026-09-20-0900-nouva", "2026-09-20", ["reminders"]));
    await h.memory.sync();
    // September's folder cannot be written: the tidy rewrites October's episode, then fails on September's.
    const september = join(h.vault.episodesDir, "2026", "09");
    chmodSync(september, 0o555);
    locked.push(september);
    await expect(h.memory.tags.merge(["reminders"], "reminder", "tester")).rejects.toThrow();
    chmodSync(september, 0o755);

    expect(h.memory.episodes({}, 10).find((episode) => episode.id === "2026-10-01-0900-nouva")?.tags).toEqual(["reminder"]);
    expect(await h.memory.tags.undo()).toEqual({ restored: 1, skipped: ["2026-09-20-0900-nouva"] });
    expect(h.memory.episodes({}, 10).map((episode) => episode.tags)).toEqual([["reminders"], ["reminders"]]);
  });

  test("one that finished says so in its record", async () => {
    plant(h.vault, tagged("2026-10-01-0900-nouva", "2026-10-01", ["reminders"]));
    await h.memory.sync();
    await h.memory.tags.merge(["reminders"], "reminder", "tester");
    const last = await h.memory.tags.last();
    expect(await readTextFileIfExists(last!.file)).toContain("status: applied");
  });
});
