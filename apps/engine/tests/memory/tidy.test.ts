/**
 * The tag tidy on a household whose tags grew the way the production box's did: a plural beside its
 * singular, a qualified tag beside a broad one, an import's one-offs. Plan, apply, undo — what the
 * files say afterwards, what the index says, and what is refused while the pass holds the turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { listDir, readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import type { Episode } from "@/modules/memory/episode.ts";
import { parseSuggestions } from "@/modules/memory/tag-suggest.ts";
import { retag } from "@/modules/memory/tidy.ts";
import { registerMemoryTagRoutes } from "@/modules/web/control/routes/memory-tags.ts";
import { GADING_DM, at, household, plant, type Household } from "./fixture.ts";
import { sleep } from "../wait.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const episode = (day: number, kind: "dm" | "archive", tags: string[]): Episode => ({
  id: kind === "archive" ? `2026-09-${String(day).padStart(2, "0")}-2359-archive` : `2026-09-${String(day).padStart(2, "0")}-0900-nouva`,
  status: "summarized",
  kind,
  chat: kind === "archive" ? "archive:noumind" : "telegram:nouva:814",
  started: `2026-09-${String(day).padStart(2, "0")}T09:00:00+07:00`,
  ended: `2026-09-${String(day).padStart(2, "0")}T09:05:00+07:00`,
  day: `2026-09-${String(day).padStart(2, "0")}`,
  agents: kind === "archive" ? [] : ["nouva"],
  people: ["gading"],
  mentions: [],
  tags,
  related: [],
  summary: "Something worth keeping.",
  transcript: kind === "archive" ? "" : "09:00 · Gading\nHalo\n",
});

/** Six conversations with `architecture`, two with `reminder` and one `reminders`, a review, and an import's one-offs. */
async function messy(): Promise<void> {
  for (let day = 1; day <= 6; day += 1) plant(h.vault, episode(day, "dm", ["architecture", "homelab"]));
  plant(h.vault, episode(7, "dm", ["reminder"]));
  plant(h.vault, episode(8, "dm", ["reminder", "homelab"]));
  plant(h.vault, episode(9, "dm", ["reminders", "architecture-review"]));
  plant(h.vault, episode(10, "archive", ["homelab", "tokenomics", "lxc-migration", "nouverse-launch", "proxmox"]));
  await h.memory.sync();
}

describe("the plan", () => {
  test("merges by the rules into the more used tag, trims an import's one-offs, and caps", async () => {
    await messy();
    const plan = h.memory.tags.plan();
    const byId = Object.fromEntries(plan.changes.map((change) => [change.id, change]));
    expect(byId["merge:R1:reminder"]).toMatchObject({ from: ["reminders"], into: "reminder", episodes: 1 });
    expect(byId["merge:R5:architecture"]).toMatchObject({ from: ["architecture-review"], into: "architecture" });
    expect(byId["trim:archive"]).toMatchObject({ from: ["lxc-migration", "nouverse-launch", "proxmox", "tokenomics"], episodes: 1 });
    expect(plan).toMatchObject({ tags: 9, once: 6 });
  });
});

describe("the plan, whole", () => {
  test("a plural folded into its singular does not hide that the singular is a narrower tag of a broad one", async () => {
    for (let day = 1; day <= 12; day += 1) plant(h.vault, episode(day, "dm", day <= 5 ? ["cron", "cron-job"] : ["cron"]));
    plant(h.vault, episode(13, "dm", ["cron-jobs"]));
    await h.memory.sync();
    const ids = h.memory.tags.plan().changes.map((change) => change.id);
    expect(ids).toEqual(expect.arrayContaining(["merge:R1:cron-job", "merge:R5:cron"]));
    // Both ticked, the plural follows the chain to the broad tag.
    await h.memory.tags.apply(["merge:R1:cron-job", "merge:R5:cron"], [], "tester");
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-13-0900-nouva")?.tags).toEqual(["cron"]);
  });

  test("one apply settles: a tag the cap leaves on a single episode is trimmed in the same tidy", async () => {
    // Four tags on three conversations each; `rare` on one of them and on one imported day.
    for (let day = 1; day <= 3; day += 1) plant(h.vault, episode(day, "dm", ["alpha", "bravo", "charlie", "delta"]));
    plant(h.vault, episode(4, "dm", ["alpha", "bravo", "charlie", "delta", "rare"]));
    plant(h.vault, episode(5, "archive", ["alpha", "rare"]));
    await h.memory.sync();
    await h.memory.tags.apply(h.memory.tags.plan().changes.map((change) => change.id), [], "tester");
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-05-2359-archive")?.tags).toEqual(["alpha"]);
    expect(h.memory.tags.plan().changes).toEqual([]);
  });
});

describe("applying it", () => {
  test("rewrites only the tags line, gives the target its alias, removes the merged stub, and records it", async () => {
    await messy();
    const file = h.vault.episode("2026-09-09-0900-nouva");
    const before = (await readTextFileIfExists(file))!;
    const plan = h.memory.tags.plan();
    const record = await h.memory.tags.apply(plan.changes.map((change) => change.id), [], "tester");
    expect("refused" in record).toBe(false);

    const after = (await readTextFileIfExists(file))!;
    expect(after).toBe(retag(before, ["reminder", "architecture"])!);
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-10-2359-archive")?.tags).toEqual(["homelab"]);
    expect(await readTextFileIfExists(h.vault.tag("reminder"))).toContain('aliases: ["reminders"]');
    expect(await readTextFileIfExists(h.vault.tag("reminders"))).toBeNull();
    expect(listDir(join(h.vault.tagsDir, "_tidy")).map((entry) => entry.name)).toHaveLength(1);
    // The alias is live: a model writing `reminders` tomorrow is folded by the lookup.
    expect(h.memory.tags.list().tags.find((entry) => entry.tag === "reminder")?.aliases).toEqual(["reminders"]);
  });

  test("undo puts back what still reads as the tidy left it, and names what changed since", async () => {
    await messy();
    await h.memory.tags.apply(h.memory.tags.plan().changes.map((change) => change.id), [], "tester");
    // Someone edits one of the tidied conversations afterwards.
    const changed = h.vault.episode("2026-09-10-2359-archive");
    await writeTextFile(changed, retag((await readTextFileIfExists(changed))!, ["homelab", "nouverse"])!);
    await h.memory.sync();

    const undone = await h.memory.tags.undo();
    expect(undone).toMatchObject({ skipped: ["2026-09-10-2359-archive"] });
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-09-0900-nouva")?.tags.toSorted()).toEqual(["architecture-review", "reminders"]);
    // The stub the tidy wrote for the merge target did not exist before it, so undo removes it again.
    expect(await readTextFileIfExists(h.vault.tag("reminder"))).toBeNull();
    expect(await h.memory.tags.last()).toBeNull();
  });

  test("a trim keeps the one-off its writer listed first, not the first by name", async () => {
    for (let day = 1; day <= 3; day += 1) plant(h.vault, episode(day, "dm", ["homelab"]));
    plant(h.vault, episode(4, "dm", ["zigbee-hub", "homelab", "alarm-panel"]));
    await h.memory.sync();
    await h.memory.tags.apply(["trim:conversation"], [], "tester");
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-04-0900-nouva")?.tags.toSorted()).toEqual(["homelab", "zigbee-hub"]);
  });

  test("a hand merge is a tidy of one change", async () => {
    await messy();
    const record = await h.memory.tags.merge(["homelab"], "home-lab", "tester");
    expect("refused" in record ? record.refused : Object.keys(record.episodes).length).toBe(8);
    expect(h.memory.tags.list().tags[0]).toMatchObject({ tag: "home-lab", aliases: ["homelab"] });
  });
});

describe("the record undo reads", () => {
  const recordFile = () => join(h.vault.tagsDir, "_tidy", listDir(join(h.vault.tagsDir, "_tidy"))[0]!.name);
  /** Rewrites the record's undo block, as a synced or hand-edited vault could. */
  async function edit(change: (block: { episodes: Record<string, unknown>; stubs: Record<string, string | null> }) => void): Promise<void> {
    const text = (await readTextFileIfExists(recordFile()))!;
    const block = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
    change(block);
    await writeTextFile(recordFile(), text.replace(/```json\n[\s\S]*?\n```/, `\`\`\`json\n${JSON.stringify(block)}\n\`\`\``));
  }

  test("keys a stub by its tag, not by where the vault was", async () => {
    await messy();
    await writeTextFile(h.vault.tag("reminders"), "---\ntype: tag\n---\n");
    await h.memory.tags.merge(["reminders"], "reminder", "tester");
    const text = (await readTextFileIfExists(recordFile()))!;
    expect(Object.keys(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!).stubs).sort()).toEqual(["reminder", "reminders"]);
  });

  test("a record naming a file outside the vault is refused whole: nothing written, nothing removed, nothing undone", async () => {
    await messy();
    await h.memory.tags.merge(["reminders"], "reminder", "tester");
    const written = join(h.vault.root, "..", "config.toml");
    const removed = join(h.vault.root, "..", "secrets.json");
    await writeTextFile(written, "kept");
    await writeTextFile(removed, "kept");
    await edit((block) => {
      block.stubs[written] = "written by a tidy undo";
      block.stubs[removed] = null;
    });

    expect(await h.memory.tags.undo()).toMatchObject({ refused: expect.stringContaining("cannot be read") });
    expect(await readTextFileIfExists(written)).toBe("kept");
    expect(await readTextFileIfExists(removed)).toBe("kept");
    // All or nothing: the episodes keep the tidy's tags, and the record is still the one to undo.
    expect(h.memory.episodes({}, 20).find((e) => e.id === "2026-09-09-0900-nouva")?.tags).toContain("reminder");
    expect(await h.memory.tags.last()).not.toBeNull();
  });

  test("a stub key that climbs, or an episode that is no id, is refused the same way", async () => {
    await messy();
    await h.memory.tags.merge(["reminders"], "reminder", "tester");
    await edit((block) => {
      block.stubs["../../config"] = "x";
    });
    expect(await h.memory.tags.undo()).toMatchObject({ refused: expect.any(String) });
    await edit((block) => {
      delete block.stubs["../../config"];
      block.episodes["../../config"] = { before: [], after: [] };
    });
    expect(await h.memory.tags.undo()).toMatchObject({ refused: expect.any(String) });
  });

  test("a record from before 0.7.7, keyed by the stub's old absolute path, is refused whole — 0.7.x rekeyed it by tag", async () => {
    await messy();
    await writeTextFile(h.vault.tag("reminders"), "---\ntype: tag\n---\nThe plural, hand-written.\n");
    await h.memory.tags.merge(["reminders"], "reminder", "tester");
    // Written where the vault used to be, before it was copied here.
    await edit((block) => {
      block.stubs = Object.fromEntries(Object.entries(block.stubs).map(([tag, stub]) => [`/srv/old-install/.nouride/memory/tags/${tag}.md`, stub]));
    });
    const merged = await readTextFileIfExists(h.vault.tag("reminder"));

    expect(await h.memory.tags.undo()).toMatchObject({ refused: expect.stringContaining("cannot be read") });
    // Nothing it names was written or removed.
    expect(await readTextFileIfExists(h.vault.tag("reminder"))).toBe(merged);
  });

  test("refused while the nightly pass holds the turn", async () => {
    await messy();
    h.dm(GADING_DM, "nouva", "Halo lagi", "Hai.", at(9));
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const pass = h.memory.pass(async () => {
      await slow;
      return JSON.stringify({ summary: "A hello." });
    });
    await sleep(20);
    expect(await h.memory.tags.apply(["merge:R1:reminder"], [], "tester")).toEqual({ refused: "the nightly pass is running, so try again when it is done" });
    release();
    await pass;
  });
});

describe("the model's groups", () => {
  test("kept when every check passes; one naming an unknown tag or a tag twice is dropped; two big tags are flagged", () => {
    const counts = new Map([["cctv", 3], ["security-camera", 1], ["docker", 30], ["kubernetes", 25], ["garden", 4]]);
    const answer = JSON.stringify({
      groups: [
        { from: ["security-camera"], into: "cctv", reason: "the same cameras" },
        { from: ["kubernetes"], into: "docker", reason: "containers" },
        { from: ["unknown-tag"], into: "garden" },
        { from: ["cctv"], into: "security" },
      ],
    });
    const result = parseSuggestions(answer, counts);
    expect(result.changes[0]).toEqual({ id: "model:cctv", kind: "merge", from: ["security-camera"], into: "cctv", episodes: 0, why: "model", reason: "the same cameras" });
    // Two big tags may be two subjects or two spellings of one: offered, with a warning in front.
    expect(result.changes[1]).toMatchObject({ id: "model:docker", from: ["kubernetes"], reason: expect.stringMatching(/^Check first: two tags on 20\+ conversations each/) });
    // What was dropped says why, so "the model found nothing" is never a check failing in silence.
    expect(result.dropped.map((group) => group.why)).toEqual(["not in use: unknown-tag", "a tag already in another group"]);
    expect(parseSuggestions("I could not decide.", counts)).toMatchObject({ changes: [], dropped: [], readable: false });
  });

  test("a group of more than thirty tags, or one with nothing to merge into, is dropped whole and says why", () => {
    // Neither check was tested: deleting the thirty-tag cap let a model fold a vault's vocabulary into
    // one tag, with every test here green.
    const many = Array.from({ length: 30 }, (_, i) => `topic-${String.fromCharCode(97 + (i % 26))}${i}`);
    const counts = new Map([...many, "hub", "kept"].map((tag) => [tag, 3] as [string, number]));
    const answer = JSON.stringify({
      groups: [
        { from: many, into: "hub" },
        { from: ["kept"] },
        { from: many.slice(0, 29), into: "hub" },
      ],
    });
    const result = parseSuggestions(answer, counts);
    expect(result.dropped.map((group) => group.why)).toEqual(["more than 30 tags", "no tag to merge into"]);
    // Thirty in all — twenty-nine and the tag they fold into — is still a group.
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.from).toHaveLength(29);
  });
});

describe("routes", () => {
  function app(role: "viewer" | "operator") {
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role });
      await next();
    });
    registerMemoryTagRoutes(hono as never, { ctx: { config: h.config }, memory: h.memory, audit: { record: () => undefined } } as never);
    return hono;
  }

  test("operator only; the plan and a tidy over the API", async () => {
    await messy();
    expect((await app("viewer").request("/memory/tags/tidy")).status).toBe(403);
    const plan = (await (await app("operator").request("/memory/tags/tidy")).json()) as { changes: { id: string }[] };
    const response = await app("operator").request("/memory/tags/tidy", { method: "POST", body: JSON.stringify({ ids: plan.changes.map((c) => c.id) }), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changes: plan.changes.length });
  });

  test("the model's groups that did not pass the checks: their reasons for the CLI, what to do in the page's words (0.8.23)", async () => {
    await messy();
    const asking = (groups: unknown[]) => {
      const hono = new Hono<{ Variables: { principal: unknown } }>();
      hono.use("*", async (c, next) => {
        c.set("principal", { kind: "user", actor: "tester", role: "operator" });
        await next();
      });
      registerMemoryTagRoutes(hono as never, { ctx: { config: h.config }, memory: h.memory, memoryPass: { ask: async () => JSON.stringify({ groups }) }, audit: { record: () => undefined } } as never);
      return hono.request("/memory/tags/tidy/model", { method: "POST" });
    };
    const dropped = (await (await asking([{ from: ["no-such-tag"], into: "homelab" }])).json()) as { dropped: { why: string }[]; plain: string };
    expect(dropped.dropped.map((group) => group.why)).toEqual(["not in use: no-such-tag"]);
    expect(dropped.plain).toBe("Some of the groups it proposed named tags that are not in use or were already grouped. Try again, or set a stronger model for the pass.");
    // Nothing dropped, nothing to say.
    expect(((await (await asking([])).json()) as { plain: unknown }).plain).toBeNull();
  });
});
