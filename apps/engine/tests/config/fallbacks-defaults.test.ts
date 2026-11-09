/**
 * `[llm.defaults] fallbacks`: the install's list, for an agent whose pack names none — each a
 * provider and a model, every provider a profile, refused at load as a pack's are.
 */

import { describe, expect, test } from "bun:test";
import { readConfigText } from "@/modules/config/global/index.ts";

const BASE = `[providers.nougate]
kind = "openai"
base_url = "https://nougate.test/v1"
api_key = "nougate_key"

[providers.openrouter]
kind = "openai"
base_url = "https://openrouter.test/v1"
api_key = "openrouter_key"

[llm.defaults]
provider = "nougate"
model = "pro"
`;

describe("the install's fallbacks", () => {
  test("are read as pairs, in order; none is an empty list", () => {
    expect(readConfigText(BASE, "config.toml").llm.defaults.fallbacks).toEqual([]);
    const config = readConfigText(`${BASE}fallbacks = [{ provider = "openrouter", model = " anthropic/claude " }, { provider = "nougate", model = "flash" }]\n`, "config.toml");
    expect(config.llm.defaults.fallbacks).toEqual([
      { provider: "openrouter", model: "anthropic/claude" },
      { provider: "nougate", model: "flash" },
    ]);
  });

  test("name a configured profile and a model, or the daemon does not start", () => {
    expect(() => readConfigText(`${BASE}fallbacks = [{ provider = "ollama", model = "qwen3:8b" }]\n`, "config.toml")).toThrow(/\[llm.defaults\] fallbacks\[0\] provider "ollama" is not a configured profile/);
    expect(() => readConfigText(`${BASE}fallbacks = [{ model = "qwen3:8b" }]\n`, "config.toml")).toThrow(/fallbacks\[0\] needs provider/);
  });
});
