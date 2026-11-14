/**
 * `{session}` in a profile's `headers`, from config to the wire, and who every request says is asking.
 *
 * OpenCode Go, a subscription with its own key, refuses a request that has no `x-opencode-session` on it and asks its
 * clients to say who they are with a user agent of their own. A profile on it sent neither, so "Use it" for Go would
 * have made a provider that answers nothing. The header is one of the profile's own, filled by the form when Go is
 * picked and the person's to change; the client writes the conversation's id where its value says `{session}`.
 */

import { describe, expect, test } from "bun:test";
import { SecretStore } from "@nouride/secrets";
import { VERSION } from "@/commons/version.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { endpointKeys } from "@/modules/config/known-endpoints.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { tempDir } from "../helpers.ts";

const HEX = /^[0-9a-f]{32}$/;
const GO = { headers: { "x-opencode-session": "{session}" } };
const profile = (extra: Record<string, unknown>) => ({ providers: { go: { kind: "openai", base_url: "https://opencode.ai/inference/go/openai/v1", api_key: "go_key", ...extra } } });
const registry = async (extra: Record<string, unknown>, fetchImpl?: typeof fetch) =>
  new ProviderRegistry(parseConfig(profile(extra)).providers, await SecretStore.open(tempDir("secrets"), { GO_KEY: "k" }), fetchImpl ? { fetchImpl } : undefined);

/** What a client the registry built for `go` sends, for one request. */
async function sent(extra: Record<string, unknown>, identity?: { agentId: string; conversation: string }): Promise<Record<string, string>> {
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>);
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  }) as unknown as typeof fetch;
  await (await registry(extra, fetchImpl)).get("go").chat({ model: "m", messages: [{ role: "user", content: "hi" }], ...(identity ? { identity } : {}) });
  return headers[0]!;
}

describe("[providers.<name>] headers with {session}", () => {
  test("kept in the config as written: the id is a request's, never the file's", () => {
    expect(parseConfig(profile(GO)).providers.go?.headers).toEqual({ "x-opencode-session": "{session}" });
  });

  test("on the wire, the conversation in that header; an id where there is none; nothing where no header asks", async () => {
    expect((await sent(GO, { agentId: "nouva", conversation: "5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f" }))["x-opencode-session"]).toBe("5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f");
    expect((await sent(GO))["x-opencode-session"]).toMatch(HEX);
    expect(await sent({}, { agentId: "nouva", conversation: "c" })).not.toHaveProperty("x-opencode-session");
  });

  test("on what reaches the endpoint outside a client (the model list, a picture, a voice note): an id of that call, never the bare placeholder", async () => {
    const providers = await registry({ headers: { "x-opencode-session": "{session}", "x-team": "ops" } });
    const first = providers.endpointFor("go").headers!;
    const second = providers.endpointFor("go").headers!;
    expect(first).toEqual({ "user-agent": `nouride/${VERSION}`, "x-opencode-session": first["x-opencode-session"]!, "x-team": "ops" });
    expect(first["x-opencode-session"]).toMatch(HEX);
    expect(second["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
  });
});

describe("who is asking, on every request to a model's endpoint", () => {
  test("Nouride and its version, not the HTTP library's name; a profile's own header says another", async () => {
    expect((await sent({}))["user-agent"]).toBe(`nouride/${VERSION}`);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect((await sent({ headers: { "user-agent": "mine/1" } }))["user-agent"]).toBe("mine/1");
  });

  test("the same outside a client, and there too the profile's own wins", async () => {
    expect((await registry({ headers: { "x-team": "ops" } })).endpointFor("go").headers).toEqual({ "user-agent": `nouride/${VERSION}`, "x-team": "ops" });
    expect((await registry({ headers: { "user-agent": "mine/1" } })).endpointFor("go").headers).toEqual({ "user-agent": "mine/1" });
  });
});

describe("a profile on a plan that includes its key, by its address", () => {
  const text = (kind: string, baseUrl: string, extra = "") => `[providers.go]\nkind = "${kind}"\nbase_url = "${baseUrl}"\napi_key = "go_api_key"\n${extra}`;
  const GO_WHY = "OpenCode Go is a subscription: use counts against the plan's limits, and nothing is charged per token";

  test("OpenCode Go is written as included, on either format, and with no header: its headers are the form's and the person's", () => {
    for (const [kind, baseUrl] of [["openai", "https://opencode.ai/inference/go/openai/v1"], ["anthropic", "https://opencode.ai/inference/go/anthropic/v1"]] as const) {
      expect(endpointKeys(text(kind, baseUrl), "go")).toEqual({ set: { billing: "included" }, remove: [], why: [GO_WHY] });
    }
    // Its format and its address go together: Go's OpenAI address spoken to as Anthropic is nothing known.
    expect(endpointKeys(text("anthropic", "https://opencode.ai/inference/go/openai/v1"), "go").set).toEqual({});
  });

  test("OpenCode Zen, charged per request, is written with nothing", () => {
    expect(endpointKeys(text("openai", "https://opencode.ai/inference/openai/v1"), "go").set).toEqual({});
  });

  test("Command Code is written as included", () => {
    expect(endpointKeys(text("openai", "https://api.commandcode.ai/provider/v1"), "go")).toEqual({
      set: { billing: "included" },
      remove: [],
      why: ["a Command Code plan includes the key: use draws on the plan's credits, and nothing is charged per token"],
    });
  });

  test("a billing the operator wrote is kept; the one the entry wrote goes when the profile moves to a server charged by use, and stays between two plans", () => {
    expect(endpointKeys(text("openai", "https://opencode.ai/inference/go/openai/v1", 'billing = "metered"\n'), "go").set).toEqual({});
    const written = text("openai", "https://opencode.ai/inference/go/openai/v1", 'billing = "included"\n');
    expect(endpointKeys(written, "go", { kind: "openai", baseUrl: "https://openrouter.ai/api/v1" })).toEqual({ set: {}, remove: ["billing"], why: [] });
    expect(endpointKeys(written, "go", { kind: "openai", baseUrl: "https://api.commandcode.ai/provider/v1" })).toEqual({ set: {}, remove: [], why: [] });
  });
});
