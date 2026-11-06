/**
 * Each helper key may name a tier instead of a model (0.8.0, SIMPLIFY §3) — `summary_model = "small"` — and is then the
 * agent's own model of that tier, on the agent's own provider. Unset, every helper is the agent's own model, as before.
 * Held here through each helper's own path: the compaction summary, the nightly pass, an image read, and skill
 * learning's weekly review. (`steer_reply_model` is held beside its own tests, `pipeline/steering.test.ts`.)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import type { LLMProvider } from "@nouride/shared";
import { writeNewSkill, type AgentRegistry } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import { summarizerRoute } from "@/modules/llm/summarizer.ts";
import { readImage } from "@/modules/attachments/vision.ts";
import { startMemoryPass } from "@/boot/memory-pass.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { DraftStore, ReflectionEngine, ReviewStore, ToolMemory } from "@/modules/reflection/index.ts";
import { fakeAgent } from "../helpers.ts";
import { GADING_DM, at, household } from "../memory/fixture.ts";

/** An agent on `main`, the install's provider, naming its own high model and leaving small to the install. */
const AGENT = { provider: "main", model: "m-default", highModel: "own-high" };
const INSTALL = { provider: "main", smallModel: "m-small", highModel: "m-high" };

describe("the compaction summary's route", () => {
  const TURN = { profile: "main", model: "m-default" };
  const tiers = { agent: AGENT, install: INSTALL };

  test("summary_model naming a tier is the agent's model of it, on the turn's profile", () => {
    expect(summarizerRoute({ summaryModel: "small" }, TURN, tiers)).toEqual({ profile: "main", model: "m-small" });
    expect(summarizerRoute({ summaryModel: "high" }, TURN, tiers)).toEqual({ profile: "main", model: "own-high" });
    expect(summarizerRoute({ summaryModel: "default" }, TURN, tiers)).toEqual({ profile: "main", model: "m-default" });
  });

  test("a pass_model naming a tier — with no pass_provider beside it — is the same, when summary_model is unset", () => {
    expect(summarizerRoute({ passProvider: "", passModel: "small" }, TURN, tiers)).toEqual({ profile: "main", model: "m-small" });
    // summary_model still goes first.
    expect(summarizerRoute({ summaryModel: "high", passModel: "small" }, TURN, tiers)).toEqual({ profile: "main", model: "own-high" });
  });

  test("a model id is itself, and nothing set is the turn's own — as before tiers", () => {
    expect(summarizerRoute({ summaryModel: "claude-haiku-4-5" }, TURN, tiers)).toEqual({ profile: "main", model: "claude-haiku-4-5" });
    expect(summarizerRoute({}, TURN, tiers)).toEqual(TURN);
  });
});

describe("an image read with image_model naming a tier", () => {
  test("is described by the agent's model of it", async () => {
    const asked: string[] = [];
    const provider = { chat: async ({ model }: { model: string }) => (asked.push(model), { text: "A chart.", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const agent = fakeAgent({ config: { ...fakeAgent().config, llm: { ...fakeAgent().config.llm, provider: "main", model: "m-default" } } });
    const deps = {
      config: { media: { readImages: true, maxImageBytes: 5_000_000, imageModel: "small" }, llm: { defaults: INSTALL } },
      registry: { get: () => agent },
      providers: { get: () => provider },
    } as never;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(await readImage(deps, { agentId: "nouva", bytes: png, mimeType: "image/png" })).toEqual({ description: "A chart." });
    expect(asked).toEqual(["m-small"]);
  });
});

describe("the nightly pass with pass_model naming a tier", () => {
  test("files each conversation with its own agent's model of it, on that agent's provider", async () => {
    const h = await household();
    try {
      const calls: { model: string; profile: string }[] = [];
      const config = { ...structuredClone(DEFAULT_CONFIG), memory: { ...h.config.memory, passProvider: "", passModel: "small" }, daemon: h.config.daemon };
      config.llm.defaults = { ...config.llm.defaults, ...INSTALL };
      h.dm(GADING_DM, "nouva", "halo", "halo", at(9));
      const pass = startMemoryPass({
        config,
        registry: { enabled: () => [{ config: { id: "nouva", llm: { provider: "main", model: "m-default" } } }] as never },
        providers: {
          get: (profile: string) =>
            ({
              chat: async ({ model }: { model: string }) => {
                calls.push({ model, profile });
                return { text: JSON.stringify({ summary: "Filed." }), model, usage: { inputTokens: 1, outputTokens: 1 } };
              },
            }) as never,
        },
        memory: h.memory,
        now: () => h.clock.now,
      });
      try {
        await pass.run();
      } finally {
        clearInterval(pass.timer);
      }
      expect(calls).toEqual([{ model: "m-small", profile: "main" }]);
    } finally {
      h.close();
    }
  });
});

describe("skill learning with [skills.learning] model naming a tier", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the weekly review asks the agent's model of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-tiers-review-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "nouride.db"));
    migrate(db);
    const asked: string[] = [];
    const provider = {
      async chat(request: { model: string }) {
        asked.push(request.model);
        return { text: JSON.stringify({ merge: [] }), toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent({ config: { ...fakeAgent().config, llm: { ...fakeAgent().config.llm, ...AGENT } } });
    const agentsDir = join(dir, "agents");
    const engine = new ReflectionEngine({
      config: { mode: "ask", model: "high", notifyChat: false },
      llmDefaults: INSTALL,
      drafts: new DraftStore(db, () => Date.UTC(2026, 9, 23)),
      toolMemory: new ToolMemory(db),
      reviews: new ReviewStore(db, () => Date.UTC(2026, 9, 23)),
      registry: { get: (id: string) => (id === agent.config.id ? agent : undefined), enabled: () => [agent], reloadAll: async () => {} } as unknown as AgentRegistry,
      providers: { get: () => provider } as unknown as ProviderRegistry,
      agentsDir,
      now: () => Date.UTC(2026, 9, 23),
    });
    for (const name of ["deploy-docker", "deploy-k8s"]) {
      await writeNewSkill(agentsDir, { name, description: `Use when ${name} is needed.`, body: "1. Check the service.", author: "nouva", created: "2026-10-20" });
    }
    await engine.library.run();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["own-high"]));
    db.close();
  });
});
