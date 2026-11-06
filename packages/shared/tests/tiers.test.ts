/**
 * Three model tiers (0.8.0): which model `small`, `default` and `high` name for an agent, and what a helper key that
 * names one resolves to.
 */

import { describe, expect, test } from "bun:test";
import { helperModel, isModelTier, MODEL_TIERS, tierModel } from "../src/index.ts";

const install = { provider: "main", smallModel: "m-small", highModel: "m-high" };
const agent = { provider: "main", model: "m-default" };

describe("a tier's model for an agent", () => {
  test("default is always the agent's model, whatever the install says", () => {
    expect(tierModel(agent, install, "default")).toBe("m-default");
    expect(tierModel({ ...agent, smallModel: "own-small" }, install, "default")).toBe("m-default");
  });

  test("the pack's own beats the install's", () => {
    expect(tierModel({ ...agent, smallModel: "own-small", highModel: "own-high" }, install, "small")).toBe("own-small");
    expect(tierModel({ ...agent, smallModel: "own-small", highModel: "own-high" }, install, "high")).toBe("own-high");
  });

  test("unset in the pack, the install's — while the agent runs on the install's provider", () => {
    expect(tierModel(agent, install, "small")).toBe("m-small");
    expect(tierModel(agent, install, "high")).toBe("m-high");
  });

  test("on another provider the install's model means nothing, so an unset tier is the agent's model", () => {
    expect(tierModel({ provider: "other", model: "o-default" }, install, "small")).toBe("o-default");
    expect(tierModel({ provider: "other", model: "o-default" }, install, "high")).toBe("o-default");
  });

  test("unset everywhere, every tier is the agent's model — an install that never wrote one changes nothing", () => {
    for (const tier of MODEL_TIERS) expect(tierModel(agent, { provider: "main", smallModel: "", highModel: "" }, tier)).toBe("m-default");
  });
});

describe("a helper key", () => {
  test("a tier's name is that tier's model for the agent", () => {
    expect(helperModel("small", agent, install)).toBe("m-small");
    expect(helperModel("high", agent, install)).toBe("m-high");
    expect(helperModel("default", agent, install)).toBe("m-default");
  });

  test("a model id is itself, and empty stays empty — the helper's own default, as before tiers", () => {
    expect(helperModel("claude-haiku-4-5", agent, install)).toBe("claude-haiku-4-5");
    expect(helperModel("", agent, install)).toBe("");
    expect(helperModel(undefined, agent, install)).toBe("");
  });

  test("only the three names are tiers", () => {
    expect(MODEL_TIERS).toEqual(["small", "default", "high"]);
    expect(isModelTier("small")).toBe(true);
    expect(isModelTier("Small")).toBe(false);
    expect(isModelTier("medium")).toBe(false);
  });
});
