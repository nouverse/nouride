/**
 * The operator's side of memory: settings checked as the loader checks them, the routes and who may
 * call which, documents that refuse a stale edit, proposals decided by the text they name, and a CLI
 * that will not print every chat's memory into one chat.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextFileIfExists, serveHttp, writeTextFile, type HttpServer } from "@nouride/runtime";
import { memoryCommand } from "@/cli/commands/memory.ts";
import { setMemorySettings } from "@/modules/config/settings/memory.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { registerMemoryRoutes } from "@/modules/web/control/routes/memory.ts";
import { registerMemoryDocumentRoutes } from "@/modules/web/control/routes/memory-documents.ts";
import { GADING_DM, SAM_DM, at, household, scripted, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
  h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3", "Oke.", at(9));
  h.dm(SAM_DM, "nix", "Resep rendang", "Ini.", at(10));
  await h.memory.pass(
    scripted([
      { when: "MacBook", answer: { summary: "Gading pakai M3.", tags: ["hardware"], facts: [{ person: "gading", op: "add", section: "Work", text: "Pakai MacBook M3." }] } },
      { when: "rendang", answer: { summary: "Sam minta resep.", shared: [{ op: "add", section: "Kitchen", text: "The rendang recipe is in the cupboard." }] } },
    ]).ask,
  );
});

afterEach(() => h.close());

describe("[memory] settings", () => {
  /**
   * An Ollama as it behaves: it embeds with a chat model too, answering with a vector of the right
   * shape, and only `/api/show` says which of its models is made for embeddings.
   */
  const MODELS: Record<string, string[]> = { "bge-m3": ["embedding"], "llama3.2": ["completion", "tools"] };
  let ollama: HttpServer;
  beforeEach(() => {
    ollama = serveHttp({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const { model } = (await request.json()) as { model: string };
        return MODELS[model] ? Response.json({ capabilities: MODELS[model] }) : Response.json({ error: "not found" }, { status: 404 });
      },
    });
  });
  afterEach(() => ollama.stop(true));

  function deps() {
    const configPath = join(h.dir, "config.toml");
    const providers = {
      get: (name: string) => {
        if (name !== "ollama") throw new Error(`provider profile "${name}" is not defined`);
        return {
          embed: async ({ model }: { model: string }) => {
            if (!MODELS[model]) throw new Error(`model "${model}" not found`);
            return { vectors: [[0.1, 0.2]], inputTokens: 1 };
          },
        };
      },
      available: () => [{ name: "ollama", kind: "openai", baseUrl: `http://127.0.0.1:${ollama.port}/v1`, hasCredential: true }],
    };
    return { settings: { config: h.config, configPath, providers } as unknown as SettingsDeps, configPath };
  }
  /**
   * The file the running config came from: a save is checked against what the next boot would read, and a
   * `[memory.semantic]` naming a profile the file does not define is one boot refuses.
   */
  const BASE = () => `[providers.ollama]\nkind = "openai"\nbase_url = "http://127.0.0.1:${ollama.port}/v1"\napi_key = "ollama_api_key"\n`;

  test("a change is written and applied live", async () => {
    const { settings, configPath } = deps();
    await writeTextFile(configPath, "");
    expect(await setMemorySettings(settings, { patch: { promptRecent: 8, transcriptDays: 14 } })).toEqual({ ok: true, restartRequired: false });
    expect(h.config.memory).toMatchObject({ promptRecent: 8, transcriptDays: 14 });
    const file = (await readTextFileIfExists(configPath)) ?? "";
    expect(file).toContain("prompt_recent = 8");
    expect(file).toContain("transcript_days = 14");
  });

  test("semantic search is switched on only once it embeds", async () => {
    const { settings, configPath } = deps();
    await writeTextFile(configPath, BASE());
    expect((await setMemorySettings(settings, { patch: { semantic: { enabled: true } } })).ok).toBe(false);
    const refused = await setMemorySettings(settings, { patch: { semantic: { enabled: true, provider: "ollama", model: "bge-m4" } } });
    expect(refused.ok ? "" : refused.error).toContain('semantic search stays off for ollama/bge-m4, which did not embed: model "bge-m4" not found');
    // And what to do about it, not only what went wrong.
    expect(refused.ok ? "" : refused.error).toContain("add an OpenAI-compatible provider that makes embeddings on the Models page");
    expect(await readTextFileIfExists(configPath)).toBe(BASE());
    // It embeds, but it is a chat model: its vectors would find nothing.
    const chat = await setMemorySettings(settings, { patch: { semantic: { enabled: true, provider: "ollama", model: "llama3.2" } } });
    expect(chat.ok ? "" : chat.error).toContain("that is a chat model, not an embedding model");
    expect(await readTextFileIfExists(configPath)).toBe(BASE());
    expect((await setMemorySettings(settings, { patch: { semantic: { enabled: true, provider: "ollama", model: "bge-m3" } } })).ok).toBe(true);
    expect(await readTextFileIfExists(configPath)).toContain("[memory.semantic]");
  });

  test("refused by the same rules as the loader, and nothing is written", async () => {
    const { settings, configPath } = deps();
    await writeTextFile(configPath, "");
    // Each with the setting it refused, which the Memory page names (0.8.23).
    expect(await setMemorySettings(settings, { patch: { passAt: "25:00" } })).toMatchObject({ ok: false, field: "passAt" });
    expect(await setMemorySettings(settings, { patch: { facts: "sometimes" as never } })).toMatchObject({ ok: false, field: "facts" });
    // The loader's last net (every number against its bounds) is not run by a save: a value it would refuse at the next
    // boot has to be refused here by name, or the dashboard writes a config the daemon will not start with.
    expect(await setMemorySettings(settings, { patch: { passMaxTokens: -1 } })).toEqual({ ok: false, field: "passMaxTokens", error: expect.stringContaining("pass_max_tokens must be a whole number of tokens") });
    expect(await setMemorySettings(settings, { patch: { passMaxTokens: 2.5 } })).toMatchObject({ ok: false, field: "passMaxTokens" });
    expect(await readTextFileIfExists(configPath)).toBe("");
    expect(await setMemorySettings(settings, { patch: { passMaxTokens: 500_000 } })).toEqual({ ok: true, restartRequired: false });
    expect(await readTextFileIfExists(configPath)).toContain("pass_max_tokens = 500000");
  });
});

describe("routes", () => {
  function app(role: "viewer" | "operator" | "admin", extra: Record<string, unknown> = {}) {
    const audited: string[] = [];
    const hono = new Hono<{ Variables: { principal: unknown } }>();
    hono.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "tester", role });
      await next();
    });
    const deps = {
      ctx: { config: { ...h.config, llm: { context: {} } } },
      memory: h.memory,
      registry: { get: (id: string) => ({ config: { id, displayName: id }, dir: join(h.dir, "agents", id) }), all: () => [{ config: { id: "nouva", displayName: "Nouva" }, dir: join(h.dir, "agents", "nouva") }] },
      audit: { record: (row: { action: string }) => void audited.push(row.action) },
      settings: { memorySettings: () => h.config.memory, setMemorySettings: async () => ({ ok: true, restartRequired: false }), setPersonRecall: async () => ({ ok: true, restartRequired: false }) },
      ...extra,
    } as never;
    registerMemoryRoutes(hono as never, deps);
    registerMemoryDocumentRoutes(hono as never, deps);
    return { hono, audited };
  }
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("the routes that work before answering keep their connection past the idle timeout; quick ones do not", async () => {
    // On a Pi the pass took ninety seconds, and the 60-second idle timeout closed the socket under it.
    const { hono } = app("operator", { memoryPass: { run: async () => ({ report: { cut: 0, filed: 0, failed: [] } }), status: () => null } });
    const kept: string[] = [];
    const env = (path: string) => ({ clientAddress: null, keepOpen: (seconds: number) => void kept.push(`${path} ${seconds}`) });
    await hono.request("/memory/pass", { method: "POST" }, env("/memory/pass"));
    await hono.request("/memory/reindex", { method: "POST" }, env("/memory/reindex"));
    await hono.request("/memory/status", {}, env("/memory/status"));
    expect(kept).toEqual(["/memory/pass 0", "/memory/reindex 0"]);
  });

  test("conversations are an operator's to read, filter and delete — and a delete takes the facts it taught", async () => {
    expect((await app("viewer").hono.request("/memory/episodes")).status).toBe(403);
    const listed = (await (await app("operator").hono.request("/memory/episodes?q=macbook")).json()) as { episodes: { id: string }[] };
    expect(listed.episodes.map((episode) => episode.id)).toEqual(["2026-09-25-0900-nouva"]);
    expect((await app("operator").hono.request("/memory/episodes?since=yesterday")).status).toBe(400);
    expect(((await (await app("operator").hono.request("/memory/episodes/2026-09-25-0900-nouva")).json()) as { episode: { summary: string } }).episode.summary).toBe("Gading pakai M3.");

    const { hono, audited } = app("operator");
    const deleted = (await (await hono.request("/memory/episodes/2026-09-25-0900-nouva", { method: "DELETE" })).json()) as { facts: number };
    expect(deleted.facts).toBe(1);
    expect(audited).toContain("memory_episode_deleted");
    expect(await readTextFileIfExists(h.vault.person("gading"))).not.toContain("MacBook");
    expect((await hono.request("/memory/episodes/2026-09-25-0900-nouva", { method: "DELETE" })).status).toBe(404);
    // Not an episode id at all: no such conversation either, not a path built from it that throws.
    expect((await hono.request("/memory/episodes/not-an-id", { method: "DELETE" })).status).toBe(404);
  });

  test("a document by subject, edited with the text it opened, stepped back with undo", async () => {
    const { hono } = app("operator");
    const opened = (await (await hono.request("/memory/documents/gading")).json()) as { content: string };
    expect(opened.content).toContain("Pakai MacBook M3.");
    const edited = opened.content.replace("M3", "M4");
    expect((await hono.request("/memory/documents/gading", json("PUT", { content: edited, expected: opened.content }))).status).toBe(200);
    expect((await hono.request("/memory/documents/gading", json("PUT", { content: "x", expected: opened.content }))).status).toBe(409);
    expect((await (await hono.request("/memory/documents/gading/undo", { method: "POST" })).json()) as { restored: boolean }).toMatchObject({ restored: true });
    expect(await readTextFileIfExists(h.vault.person("gading"))).toContain("MacBook M3");
    expect((await hono.request("/memory/documents/..%2Fconfig")).status).toBe(404);
  });

  test("proposals: an operator's; approving applies by the text named, even after the numbers moved", async () => {
    expect((await app("viewer").hono.request("/memory/proposals")).status).toBe(403);
    const { hono } = app("operator");
    const [proposal] = ((await (await hono.request("/memory/proposals")).json()) as { proposals: { id: string; subject: string }[] }).proposals;
    expect(proposal).toMatchObject({ subject: "shared" });
    expect((await hono.request(`/memory/proposals/${proposal!.id}/approve`, { method: "POST" })).status).toBe(200);
    expect(await readTextFileIfExists(h.vault.shared)).toContain("## Kitchen\n- The rendang recipe is in the cupboard.");
    expect((await hono.request(`/memory/proposals/${proposal!.id}/approve`, { method: "POST" })).status).toBe(409);

    // A rewrite proposed on fact 1 (every change waits, with `ask`); then a person adds a line above
    // it, so fact 1 is another line.
    h.config.memory.facts = "ask";
    h.dm(GADING_DM, "nouva", "Sekarang pakai M4", "Oke.", at(23, 10));
    h.clock.now = at(23, 30);
    await h.memory.pass(scripted([{ when: "M4", answer: { summary: "Ganti M4.", facts: [{ person: "gading", op: "update", n: 1, text: "Pakai MacBook M4." }] } }]).ask);
    const doc = (await (await hono.request("/memory/documents/gading")).json()) as { content: string };
    await hono.request("/memory/documents/gading", json("PUT", { content: doc.content.replace("## Work\n", "## Work\n- Kerja di Tridorian.\n"), expected: doc.content }));
    const [update] = ((await (await hono.request("/memory/proposals")).json()) as { proposals: { id: string; why: string }[] }).proposals;
    expect(update).toMatchObject({ why: "review" });
    expect((await hono.request(`/memory/proposals/${update!.id}/approve`, { method: "POST" })).status).toBe(200);
    const after = (await readTextFileIfExists(h.vault.person("gading"))) ?? "";
    expect(after).toContain("- Kerja di Tridorian.\n- Pakai MacBook M4.");
    expect(after).not.toContain("M3");
  });

  test("refusals the dashboard shows carry its own words beside the CLI's (0.8.20)", async () => {
    const { hono } = app("operator");
    // Semantic search is off in the fixture: the embed button's refusal named a section of the config file.
    const embed = await hono.request("/memory/embed", { method: "POST" });
    expect(embed.status).toBe(409);
    expect(await embed.json()).toEqual({
      error: "semantic search is off: it needs [memory.semantic] enabled, provider and model",
      plain: "Search by meaning is off. Turn it on under Semantic search with an embedding model, then embed again.",
    });
    const off = { run: async () => ({ refused: "the nightly pass is off ([memory] pass is false)", why: "off" as const }), status: () => null, ask: async () => null };
    const pass = await app("operator", { memoryPass: off }).hono.request("/memory/pass", { method: "POST" });
    expect(await pass.json()).toEqual({ error: "the nightly pass is off ([memory] pass is false)", plain: "The nightly pass is turned off. Turn it on in Memory's settings, then run it." });
  });

  test("the pass is an operator's, 503 where it is not scheduled; forget is an admin's", async () => {
    expect((await app("operator").hono.request("/memory/pass", { method: "POST" })).status).toBe(503);
    const run = async () => ({ report: { cut: 0, filed: 0, failed: [], applied: 0, proposed: 0, dropped: 0, compacted: 0, waiting: 0 } });
    expect((await app("operator", { memoryPass: { run, status: () => null, ask: async () => null } }).hono.request("/memory/pass", { method: "POST" })).status).toBe(200);
    expect((await app("operator").hono.request("/memory/forget", json("POST", { person: "sam", mode: "anonymize" }))).status).toBe(403);
    expect((await app("admin").hono.request("/memory/forget", json("POST", { person: "sam" }))).status).toBe(400);
    const { hono, audited } = app("admin");
    expect((await hono.request("/memory/forget", json("POST", { person: "sam", mode: "anonymize" }))).status).toBe(200);
    expect(audited).toContain("memory_forgotten");
  });

  test("the import of 0.5 and 0.6 captures is gone with 0.8.0: its route is not one, even to an admin", async () => {
    // A folder that does hold a capture, so a route still mounted would have found something to import.
    const captures = join(h.dir, "memories");
    mkdirSync(captures, { recursive: true });
    writeFileSync(join(captures, "2026-01-02-0900.md"), "# Session: 2026-01-02 09:00:00\n- **Session Key**: nouva:telegram:nouva:814\n\nuser: halo\n");
    const { hono, audited } = app("admin");
    expect((await hono.request("/memory/backfill", json("POST", { dir: captures }))).status).toBe(404);
    expect(audited).toEqual([]);
    expect(h.memory.episodes({}, 100).filter((episode) => episode.day === "2026-01-02")).toEqual([]);
  });

  test("settings are an operator's; a wrong type or unknown key is a 400, the retired owners included", async () => {
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { owners: ["sam"] }))).status).toBe(400);
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { promptRecent: 3 }))).status).toBe(200);
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { promptRecent: "3" }))).status).toBe(400);
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { remember: [] }))).status).toBe(400);
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { recall: false }))).status).toBe(200);
    expect((await app("operator").hono.request("/memory/settings", json("PUT", { recall: "off" }))).status).toBe(400);
  });

  test("one person's recall: true, false, or null to follow the memory setting", async () => {
    expect((await app("operator").hono.request("/memory/people/gading/recall", json("PUT", { recall: "no" }))).status).toBe(400);
    expect((await app("operator").hono.request("/memory/people/gading/recall", json("PUT", {}))).status).toBe(400);
    expect((await app("operator").hono.request("/memory/people/gading/recall", json("PUT", { recall: false }))).status).toBe(200);
    expect((await app("operator").hono.request("/memory/people/gading/recall", json("PUT", { recall: null }))).status).toBe(200);
  });

  test("they say which model summarizes long conversations when `summary_model` names one — read, never set, here", async () => {
    // The pass's model compacts long conversations too unless `[llm.context] summary_model` is set; the card says which.
    const naming = (summaryModel?: string) => ({ ctx: { config: { ...h.config, llm: { context: summaryModel ? { summaryModel } : {} } } } });
    const read = async (extra: Record<string, unknown>) => (await (await app("operator", extra).hono.request("/memory/settings")).json()) as Record<string, unknown>;
    expect(await read(naming("claude-haiku-4-5"))).toMatchObject({ summaryModel: "claude-haiku-4-5", passModel: "" });
    expect((await read(naming())).summaryModel).toBe("");
    // A save answers with it too, and one naming it is refused: it is `[llm.context]`'s, not a memory setting.
    const saved = await app("operator", naming("claude-haiku-4-5")).hono.request("/memory/settings", json("PUT", { promptRecent: 3 }));
    expect(await saved.json()).toMatchObject({ summaryModel: "claude-haiku-4-5" });
    expect((await app("operator", naming("claude-haiku-4-5")).hono.request("/memory/settings", json("PUT", { summaryModel: "x" }))).status).toBe(400);
  });

  test("the people, and each agent's own notes, read-only", async () => {
    await writeTextFile(join(h.dir, "agents", "nouva", "MEMORY.md"), "## Cara kerja\nJawab singkat.\n");
    const { hono } = app("operator");
    const people = (await (await hono.request("/memory/people")).json()) as { people: Record<string, unknown>[] };
    const gading = people.people.find((person) => person.name === "Gading");
    expect(gading).toMatchObject({ key: "gading", facts: 1 });
    expect(gading).not.toHaveProperty("owner");
    expect(((await (await hono.request("/memory/agents/nouva")).json()) as { content: string }).content).toContain("Jawab singkat.");
  });
});

describe("the CLI inside a chat", () => {
  test("the operator's views refuse, and point at memory_search", async () => {
    const said: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void said.push(parts.join(" "));
    process.env.NOURIDE_CHAT_ID = "1203@g.us";
    let called = false;
    const client = { get: async () => ((called = true), { episodes: [] }) } as never;
    try {
      await memoryCommand(client, ["episodes", "gaji"]);
      await memoryCommand(client, ["show", "2026-09-25-0900-nouva"]);
    } finally {
      delete process.env.NOURIDE_CHAT_ID;
      console.log = original;
    }
    expect(called).toBe(false);
    expect(said.join("\n")).toContain("memory_search");
  });
});

describe("nouride memory set", () => {
  test("a switch takes on and off as readily as true and false", async () => {
    const sent: unknown[] = [];
    const client = { put: async (_path: string, body: unknown) => (sent.push(body), { restartRequired: false }) } as never;
    const original = console.log;
    console.log = () => {};
    try {
      for (const word of ["on", "OFF", "yes", "true"]) await memoryCommand(client, ["set", "pass", word]);
    } finally {
      console.log = original;
    }
    expect(sent).toEqual([{ pass: true }, { pass: false }, { pass: true }, { pass: true }]);
  });
});
