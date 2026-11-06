/**
 * The model tiers in the files (0.8.0): `[llm.defaults] small_model` / `high_model` and a pack's `[llm]` pair name
 * models, refused at load when they name a tier or nothing; a helper key may name a tier, and `pass_model` naming one
 * stands without `pass_provider` — it is each agent's own model of it.
 */

import { describe, expect, test } from "bun:test";
import { parseAgentConfig } from "@nouride/persona";
import { parseConfig } from "@/modules/config/global/index.ts";
import { validate } from "@/modules/config/global/validate.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const PROVIDERS = { main: { kind: "openai", base_url: "https://main.test/v1", api_key: "main_key" } };

describe("[llm.defaults] small_model and high_model", () => {
  test("load, and are what the install's tiers are", () => {
    const config = parseConfig({ providers: PROVIDERS, llm: { defaults: { provider: "main", model: "m", small_model: "m-small", high_model: "m-high" } } });
    expect(config.llm.defaults).toMatchObject({ provider: "main", model: "m", smallModel: "m-small", highModel: "m-high" });
  });

  test("unset, they are empty — every tier is `model`, and nothing changes for an install that never writes them", () => {
    expect(parseConfig({}).llm.defaults).toMatchObject({ smallModel: "", highModel: "" });
  });

  test.each(["small", "default", "high"])("naming the tier %p instead of a model is refused at load, with the key", (tier) => {
    expect(() => parseConfig({ llm: { defaults: { small_model: tier } } })).toThrow(`[llm.defaults] small_model = "${tier}" names a tier, but this key names a model`);
    expect(() => parseConfig({ llm: { defaults: { high_model: tier } } })).toThrow(`[llm.defaults] high_model = "${tier}" names a tier, but this key names a model`);
  });
});

describe("a helper key naming a tier", () => {
  test("each loads as written — summary_model, steer_reply_model, image_model, [skills.learning] model", () => {
    const config = parseConfig({
      llm: { context: { summary_model: "small" } },
      queue: { steer_reply_model: "small" },
      media: { image_model: "high" },
      skills: { learning: { model: "small" } },
    });
    expect([config.llm.context.summaryModel, config.queue.steerReplyModel, config.media.imageModel, config.skills.learning.model]).toEqual(["small", "small", "high", "small"]);
  });

  test("pass_model naming a tier stands alone: it is each agent's own model of it, on its own provider", () => {
    const config = parseConfig({ memory: { pass_model: "small" } });
    expect(() => validate(config)).not.toThrow();
  });

  test("…and beside a pass_provider it is refused, naming what to do", () => {
    const config = parseConfig({ providers: PROVIDERS, memory: { pass_provider: "main", pass_model: "small" } });
    expect(() => validate(config)).toThrow('[memory] pass_model = "small" is a tier (each agent\'s own model of it, on its own provider), so pass_provider goes');
  });

  test("a model id without its provider is still refused, as before", () => {
    const config = parseConfig({ memory: { pass_model: "gemini-flash" } });
    expect(() => validate(config)).toThrow("[memory] pass_provider and pass_model go together");
  });
});

describe("a pack's [llm] small_model and high_model", () => {
  const parse = (llm: Record<string, unknown>) => parseAgentConfig("nox", { llm }, { defaults: DEFAULT_CONFIG.llm.defaults });

  test("are the pack's own, and absent stays absent — the install's is resolved where it is used", () => {
    expect(parse({ small_model: "nox-small", high_model: "nox-high" }).llm).toMatchObject({ smallModel: "nox-small", highModel: "nox-high" });
    const unset = parse({}).llm;
    expect("smallModel" in unset || "highModel" in unset).toBe(false);
  });

  test("empty, or naming a tier, is refused for that agent with the file and the key", () => {
    expect(() => parse({ small_model: "" })).toThrow("agents/nox/config.toml [llm] small_model is empty: name a model, or leave the key out to inherit the install's");
    expect(() => parse({ high_model: "small" })).toThrow('agents/nox/config.toml [llm] high_model = "small" names a tier, where a model belongs');
  });
});
