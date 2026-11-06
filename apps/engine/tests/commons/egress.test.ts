/**
 * What leaves the daemon is masked of every credential it knows (`commons/egress.ts`): each request a model is sent —
 * the very first one too — each text it embeds, and each line a chat is sent; whole values only, and none too short or
 * too plain to be told from a word.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "@nouride/secrets";
import type { ChatParams, LLMProvider, OutboundMessage } from "@nouride/shared";
import { egressValues, maskOutbound, maskRequest, withEgressMask } from "@/commons/egress.ts";
import { ProviderRegistry } from "@/modules/llm/providers.ts";
import { FakeGateway, noSleep, scriptedOpenAI } from "../helpers.ts";

const KEY = "sk-nou-Zq9xW2vB7nM4kL8pR3sT6uY1aD5fG0hJ";
const known = { nougate: KEY };

describe("what is worth masking in a conversation", () => {
  test("a credential is; a value too short, or a plain word somebody stored, is not", () => {
    expect(egressValues({ nougate: KEY, pin: "1234567", wifi: "postgres", phrase: "correct-horse-battery" })).toEqual({ nougate: KEY, phrase: "correct-horse-battery" });
  });
});

describe("a model's request", () => {
  test("is masked everywhere text is: the system prompt, every message, and the arguments of the calls in them", () => {
    const params: ChatParams = {
      model: "m",
      system: [{ text: `memory says the key is ${KEY}` }, { text: "nothing here" }],
      messages: [
        { role: "user", content: `pasted before 0.7.17: ${KEY}` },
        { role: "user", content: [{ type: "text", text: `and again ${KEY}` }, { type: "image", mediaType: "image/png", data: "AAAA" } as never] },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "exec", arguments: { command: `curl -H "x-key: ${KEY}"`, env: [KEY] } }] },
        { role: "tool", content: `echoed ${KEY}`, toolCallId: "c1" },
      ],
    };
    const masked = JSON.stringify(maskRequest(params, egressValues(known)));
    expect(masked).not.toContain(KEY);
    expect(masked.match(/\[REDACTED:nougate\]/g)?.length).toBe(6);
    expect(masked).toContain('"data":"AAAA"');
    expect(maskRequest({ model: "m", system: `the key ${KEY}`, messages: [] }, egressValues(known)).system).toBe("the key [REDACTED:nougate]");
  });

  test("keeps the start of a value: a conversation is not a command's output", () => {
    const masked = maskRequest({ model: "m", messages: [{ role: "user", content: `keys look like ${KEY.slice(0, 12)}…` }] }, egressValues(known));
    expect(masked.messages[0]!.content).toBe(`keys look like ${KEY.slice(0, 12)}…`);
  });

  test("goes out masked from a provider the registry hands over — the first request as much as the next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-egress-"));
    try {
      const secrets = await SecretStore.open(dir, { TESTKEY: "sk-test-key-0000000000" });
      await secrets.set("deploy_token", "dpl-0123456789abcdef");
      const { fetchImpl, requests } = scriptedOpenAI([{ text: "ok" }, { text: "ok" }]);
      const providers = new ProviderRegistry(
        { test: { kind: "openai", baseUrl: "https://fake.test/v1", apiKeySecret: "testkey" } } as never,
        secrets,
        { fetchImpl, sleep: noSleep },
        () => secrets.knownValues(),
      );
      const ask = (text: string) => providers.get("test").chat({ model: "m", messages: [{ role: "user", content: text }] });
      await ask("the deploy token is dpl-0123456789abcdef, and the key sk-test-key-0000000000");
      await ask("again: dpl-0123456789abcdef");
      const sent = JSON.stringify(requests);
      expect(sent).not.toContain("dpl-0123456789abcdef");
      // Resolved from the environment for this very provider, so known — and masked like a stored one.
      expect(sent).not.toContain("sk-test-key-0000000000");
      expect(sent.match(/\[REDACTED:deploy_token\]/g)?.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("embedding is masked too, and the provider is otherwise the one it wraps", async () => {
    const seen: string[][] = [];
    const inner = { kind: "openai", baseUrl: "https://x", chat: async () => ({}) as never, stream: async function* () {}, embed: async (p: { input: string[] }) => (seen.push(p.input), { vectors: [], model: "e" }) } as unknown as LLMProvider;
    const wrapped = withEgressMask(inner, () => known);
    await wrapped.embed!({ model: "e", input: [`a memory with ${KEY}`] });
    expect(seen).toEqual([["a memory with [REDACTED:nougate]"]]);
    expect([wrapped.kind, wrapped.baseUrl]).toEqual(["openai", "https://x"]);
  });
});

describe("a line a chat is sent", () => {
  test("is masked, sent or edited — on the adapter itself, which stays the instance it was", async () => {
    const gateway = new FakeGateway("telegram:nouva");
    const edits: string[] = [];
    gateway.editMessage = async (_chat: string, _id: string, text: string) => (edits.push(text), true);
    maskOutbound(gateway, () => known);
    await gateway.send({ gatewayId: "telegram:nouva", chatId: "1", text: `here: ${KEY}` } as OutboundMessage);
    await gateway.editMessage!("1", "m1", `edited: ${KEY}`);
    expect(gateway.sent.map((message) => message.text)).toEqual(["here: [REDACTED:nougate]"]);
    expect(edits).toEqual(["edited: [REDACTED:nougate]"]);
    expect(gateway).toBeInstanceOf(FakeGateway);
  });
});

describe("the store", () => {
  test("knows what it holds and what the environment answered for — not a name nobody asked about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-known-"));
    try {
      const key = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";
      const store = await SecretStore.open(dir, { NOUGATE: "from-the-environment-1", UNASKED: "never-resolved-2", NOURIDE_ENCRYPTION_KEY: key });
      await store.set("stored", "stored-value-3");
      // And the store's own key, once (0.8.19): a value that must never leave the daemon either.
      expect(store.knownValues()).toEqual({ stored: "stored-value-3", "the secret store's key": key });
      store.resolve("nougate");
      expect(store.knownValues()).toEqual({ stored: "stored-value-3", nougate: "from-the-environment-1", "the secret store's key": key });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
