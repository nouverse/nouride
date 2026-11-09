/**
 * `[look]` in a pack (0.8.1): the parts of the agent's cat in Nouride Office a person picked, each one of its part's
 * words, read at load and refused there naming the key — and a pack that picks none has no look of its own.
 */

import { describe, expect, test } from "bun:test";
import type { LLMDefaultsSection } from "@nouride/shared";
import { parseAgentConfig } from "../src/config.ts";
import { unknownPackKeys } from "../src/pack-keys.ts";

const DEFAULTS: LLMDefaultsSection = { provider: "anthropic", model: "m", maxTokens: 4096, temperature: 0.7 } as LLMDefaultsSection;
const parse = (look: unknown) => parseAgentConfig("nouva", { look } as never, { defaults: DEFAULTS });

describe("[look]", () => {
  test("carries the parts it picks, by their pack keys, and nothing it does not", () => {
    expect(parse({ fur: "ginger", pattern: "tabby", outfit: "hoodie", outfit_color: "blue", hat: "beanie", accessory: "glasses", eyes: "sparkly" }).look).toEqual({
      fur: "ginger",
      pattern: "tabby",
      outfit: "hoodie",
      outfitColor: "blue",
      hat: "beanie",
      accessory: "glasses",
      eyes: "sparkly",
    });
    expect(parse({ hat: "cap" }).look).toEqual({ hat: "cap" });
    expect(parse({}).look).toBeUndefined();
    expect(parseAgentConfig("plain", null, { defaults: DEFAULTS }).look).toBeUndefined();
  });

  test("takes headphones for a hat, and no longer for an accessory (0.8.1)", () => {
    expect(parse({ hat: "headphones" }).look).toEqual({ hat: "headphones" });
    expect(() => parse({ accessory: "headphones" })).toThrow("[look] accessory must be one of none, glasses, sunglasses, scarf, photochromic");
  });

  test("takes white for an outfit's colour (0.8.1)", () => {
    expect(parse({ outfit_color: "white" }).look).toEqual({ outfitColor: "white" });
  });

  test("a word that is not one of its part's is refused at load, naming the key and the words", () => {
    expect(() => parse({ fur: "purple" })).toThrow("[look] fur must be one of ginger, grey, black, white, brown, cream");
    expect(() => parse({ outfit_color: 3 })).toThrow("[look] outfit_color must be one of blue, lime, peach, charcoal, sage, lilac, white");
    expect(() => parse("cute")).toThrow("[look] must be a table");
  });

  test("its keys are the pack's own — none is warned about as a typo", () => {
    expect(unknownPackKeys({ look: { fur: "grey", outfit_color: "sage" } })).toEqual([]);
    expect(unknownPackKeys({ look: { colour: "sage" } })).toEqual(["[look] colour"]);
  });
});
