/**
 * "How to get an API key" (`commons/lib/key-hints.ts`): the list under the key's field wherever a provider is added.
 * A wrong address in it makes a provider that answers nothing with no word why, and a wrong word about cost is a bill
 * somebody did not expect: so each line is held to what the form takes and to the kind of cost it says, and the
 * addresses are written out here a second time, as their services' own documentation gives them.
 */

import { describe, expect, test } from "bun:test";
import { KEY_HINTS } from "@/commons/lib/key-hints";

describe("the services under How to get an API key", () => {
  test("are the ones a person is likely to mean, in this order", () => {
    expect(KEY_HINTS.map((hint) => hint.name)).toEqual(["OpenAI", "Anthropic", "Google Gemini", "DeepSeek", "Z.ai", "OpenCode Zen", "OpenCode Go", "Command Code"]);
  });

  test("each has a page for its key and an address, both https, the address as the form stores it", () => {
    for (const hint of KEY_HINTS) {
      expect({ hint: hint.id, key: new URL(hint.keyUrl).protocol, at: new URL(hint.baseUrl).protocol }).toEqual({ hint: hint.id, key: "https:", at: "https:" });
      // No slash at its end: the address is joined to `/chat/completions`, `/messages` and `/models` as it is.
      expect(hint.baseUrl.endsWith("/")).toBe(false);
      expect(["openai", "anthropic"]).toContain(hint.kind);
      // What "Use it" names a provider: the form's own rule for a name.
      expect(hint.id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
    expect(new Set(KEY_HINTS.map((hint) => hint.id)).size).toBe(KEY_HINTS.length);
    expect(new Set(KEY_HINTS.map((hint) => hint.baseUrl)).size).toBe(KEY_HINTS.length);
  });

  test("the addresses and key pages, as each service's own documentation gives them", () => {
    expect(Object.fromEntries(KEY_HINTS.map((hint) => [hint.id, [hint.kind, hint.baseUrl, hint.keyUrl]]))).toEqual({
      openai: ["openai", "https://api.openai.com/v1", "https://platform.openai.com/api-keys"],
      anthropic: ["anthropic", "https://api.anthropic.com/v1", "https://platform.claude.com/settings/keys"],
      gemini: ["openai", "https://generativelanguage.googleapis.com/v1beta/openai", "https://aistudio.google.com/apikey"],
      deepseek: ["openai", "https://api.deepseek.com/v1", "https://platform.deepseek.com/api_keys"],
      zai: ["openai", "https://api.z.ai/api/paas/v4", "https://z.ai/manage-apikey/apikey-list"],
      "opencode-zen": ["openai", "https://opencode.ai/inference/openai/v1", "https://opencode.ai/console"],
      "opencode-go": ["openai", "https://opencode.ai/inference/go/openai/v1", "https://opencode.ai/console"],
      commandcode: ["openai", "https://api.commandcode.ai/provider/v1", "https://commandcode.ai/settings/keys"],
    });
  });

  test("each says what it costs in its first words, and the words agree with the kind of cost it is marked as", () => {
    for (const hint of KEY_HINTS) {
      const said = hint.cost === "included" ? /^Your .+ plan includes the key\b/.test(hint.words) : /^(Charged per (use|request)|Free within its limits, then charged per use)\b/.test(hint.words);
      expect({ hint: hint.id, cost: hint.cost, said }).toEqual({ hint: hint.id, cost: hint.cost, said: true });
      expect(hint.words.endsWith(".")).toBe(true);
    }
  });

  test("what is part of a plan says nothing is charged outside it; what is charged by use says a chat subscription does not cover it, where one exists", () => {
    const words = Object.fromEntries(KEY_HINTS.map((hint) => [hint.id, hint.words]));
    expect(KEY_HINTS.filter((hint) => hint.cost === "included").map((hint) => hint.id)).toEqual(["opencode-go", "commandcode"]);
    for (const plan of ["opencode-go", "commandcode"]) expect(words[plan]).toContain("nothing is charged outside it");
    // The one way a Go plan does charge outside it, and what OpenCode means the plan for.
    expect(words["opencode-go"]).toContain("unless you turn on Extra Usage there");
    expect(words["opencode-go"]).toContain("OpenCode means Go for coding agents");
    // OpenCode's two services share a console and differ in what they cost: each says its own.
    expect(words["opencode-zen"]).toStartWith("Charged per request");
    // The one plan of it that has no key.
    expect(words.commandcode).toContain("Every plan but Go");
    expect(words.openai).toContain("A ChatGPT subscription does not cover it");
    expect(words.anthropic).toContain("apart from a Claude subscription");
    // A subscription of Z.ai's that a person may hold, and that does not reach here.
    expect(words.zai).toContain("does not cover use from here");
  });

  test("OpenCode Go is listed at its address for the OpenAI format, which every text model of it answers on", () => {
    expect(KEY_HINTS.filter((hint) => hint.baseUrl.includes("/go/")).map((hint) => [hint.kind, hint.baseUrl])).toEqual([["openai", "https://opencode.ai/inference/go/openai/v1"]]);
  });

  test("a service that needs more than a key says what in its headers: the one here that asks for one", () => {
    // OpenCode Go answers 400 `MissingSessionID` to a request without this header, whose value the daemon writes for
    // each conversation where it says `{session}`. Without it the hint leads to a provider that refuses everything.
    expect(Object.fromEntries(KEY_HINTS.filter((hint) => hint.headers).map((hint) => [hint.id, hint.headers]))).toEqual({ "opencode-go": { "x-opencode-session": "{session}" } });
  });
});
