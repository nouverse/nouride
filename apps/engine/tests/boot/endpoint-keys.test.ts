/**
 * A profile written before setup knew what OpenAI's own API needs is given it at the first start of this build
 * (`boot/endpoint-keys.ts`), so the update is all a person has to do: without `max_tokens_field`, every reply and every
 * compaction on a GPT-5-family model was refused for sending `max_tokens`. And `identify`, which the two vendors' own
 * APIs take: without it a conversation's requests carried no cache key. Each case is a `config.toml` as an older
 * install left it, loaded as the daemon loads it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { bringEndpointKeysForward } from "@/boot/endpoint-keys.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { tempDir } from "../temp-dirs.ts";

const said: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "config.providers" && said.push(entry)));
/** What the loader says about a key it does not know. */
const unknownKeys: LogEntry[] = [];
addLogSink((entry) => void (entry.message === "unknown config key ignored" && unknownKeys.push(entry)));

const OPENAI = `[providers.openai]
kind = "openai"
base_url = "https://api.openai.com/v1"
api_key = "openai_api_key"   # the secret's name
`;

const OTHERS = `
[providers.openrouter]
kind = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key = "openrouter"

[providers.nougate]
kind = "openai"
base_url = "http://127.0.0.1:18256/openai/v1"
api_key = "nougate_api_key"

[providers.nougate-anthropic]
kind = "anthropic"
base_url = "http://127.0.0.1:18256/anthropic/v1"
api_key = "nougate_api_key"

[providers.ollama]
kind = "openai"
base_url = "http://127.0.0.1:11434/v1"
api_key = "ollama_api_key"
`;

const ANTHROPIC = `
[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic_api_key"
`;

const MAX_TOKENS_WHY = "OpenAI's own API takes a reply's output limit only as max_completion_tokens for its newer models";
const OPENAI_IDENTIFY_WHY = "OpenAI's own API takes user and prompt_cache_key, which keeps a conversation's requests on the cache its prefix is in";
const ANTHROPIC_IDENTIFY_WHY = "Anthropic's own API takes metadata.user_id, which tells one conversation's requests from another's";

/** An install's `config.toml`, and the running config the daemon loaded from it. */
function install(text: string) {
  const configPath = join(tempDir("endpoint-keys"), "config.toml");
  writeFileSync(configPath, text);
  return { configPath, config: readConfigText(text, configPath) };
}

describe("an older install with a profile on OpenAI's own API", () => {
  test("has max_tokens_field and identify written under that profile alone, the rest of its file as it was, and live for this boot", async () => {
    const at = install(`# my box\n${OPENAI}${OTHERS}`);
    said.length = 0;
    expect(await bringEndpointKeysForward(at)).toEqual(["openai"]);

    const after = readFileSync(at.configPath, "utf8");
    // Byte for byte, with two lines added under the profile's last value.
    expect(after).toBe(`# my box\n${OPENAI.replace("# the secret's name\n", '# the secret\'s name\nmax_tokens_field = "max_completion_tokens"\nidentify = true\n')}${OTHERS}`);
    expect(at.config.providers.openai?.maxTokensField).toBe("max_completion_tokens");
    expect(at.config.providers.openai?.identify).toBe(true);
    // OpenRouter, Nougate on either wire, a local server: none is known to take the fields, so none is given them.
    for (const other of ["openrouter", "nougate", "nougate-anthropic", "ollama"]) {
      expect(at.config.providers[other]?.maxTokensField).toBeUndefined();
      expect(at.config.providers[other]?.identify).toBeUndefined();
    }

    expect(said.map((entry) => [entry.level, entry.message, entry.data])).toEqual([
      [
        "info",
        "wrote what this provider profile's endpoint needs into config.toml",
        { profile: "openai", max_tokens_field: "max_completion_tokens", identify: true, why: `${MAX_TOKENS_WHY}; ${OPENAI_IDENTIFY_WHY}` },
      ],
    ]);
  });

  test("one that already has max_tokens_field, as the release before wrote it, is given identify alone, with its own reason", async () => {
    const at = install(`${OPENAI}max_tokens_field = "max_completion_tokens"\n`);
    said.length = 0;
    expect(await bringEndpointKeysForward(at)).toEqual(["openai"]);
    expect(readFileSync(at.configPath, "utf8")).toBe(`${OPENAI}max_tokens_field = "max_completion_tokens"\nidentify = true\n`);
    expect(said.map((entry) => entry.data)).toEqual([{ profile: "openai", identify: true, why: OPENAI_IDENTIFY_WHY }]);
  });

  test("written once: the next start finds the key and leaves the file alone", async () => {
    const at = install(OPENAI);
    await bringEndpointKeysForward(at);
    const first = readFileSync(at.configPath, "utf8");
    expect(await bringEndpointKeysForward(at)).toEqual([]);
    expect(readFileSync(at.configPath, "utf8")).toBe(first);
  });

  test("an explicit max_tokens is the operator's answer, and is kept", async () => {
    const text = `${OPENAI}max_tokens_field = "max_tokens"\n`;
    const at = install(text);
    expect(await bringEndpointKeysForward(at)).toEqual(["openai"]);
    // The other key it lacked is written; the one it answered is as it was.
    expect(readFileSync(at.configPath, "utf8")).toBe(`${text}identify = true\n`);
    expect(at.config.providers.openai?.maxTokensField).toBeUndefined();
  });

  test("an explicit identify = false is the operator's answer, and is kept, on either vendor's API", async () => {
    const text = `${OPENAI}max_tokens_field = "max_completion_tokens"\nidentify = false\n${ANTHROPIC}identify = false\n`;
    const at = install(text);
    expect(await bringEndpointKeysForward(at)).toEqual([]);
    expect(readFileSync(at.configPath, "utf8")).toBe(text);
    expect(at.config.providers.openai?.identify).toBeUndefined();
    expect(at.config.providers.anthropic?.identify).toBeUndefined();
  });

  test("the address as a person may have typed it: a trailing slash, a host in capitals", async () => {
    const at = install(OPENAI.replace("https://api.openai.com/v1", "https://API.OpenAI.com/v1/"));
    expect(await bringEndpointKeysForward(at)).toEqual(["openai"]);
    expect(at.config.providers.openai?.maxTokensField).toBe("max_completion_tokens");
  });

  test("an install with no profile on it is never touched", async () => {
    const at = install(OTHERS);
    expect(await bringEndpointKeysForward(at)).toEqual([]);
    expect(readFileSync(at.configPath, "utf8")).toBe(OTHERS);
  });
});

describe("an older install with a profile on Anthropic's own API", () => {
  test("has identify written under that profile alone, once, and live for this boot", async () => {
    const at = install(`${OTHERS}${ANTHROPIC}`);
    said.length = 0;
    expect(await bringEndpointKeysForward(at)).toEqual(["anthropic"]);
    expect(readFileSync(at.configPath, "utf8")).toBe(`${OTHERS}${ANTHROPIC}identify = true\n`);
    expect(at.config.providers.anthropic?.identify).toBe(true);
    expect(at.config.providers["nougate-anthropic"]?.identify).toBeUndefined();
    expect(said.map((entry) => entry.data)).toEqual([{ profile: "anthropic", identify: true, why: ANTHROPIC_IDENTIFY_WHY }]);

    const first = readFileSync(at.configPath, "utf8");
    expect(await bringEndpointKeysForward(at)).toEqual([]);
    expect(readFileSync(at.configPath, "utf8")).toBe(first);
  });

  test("the config it leaves is one the loader takes with no word about an unknown key: identify is a key every release knows", async () => {
    const at = install(`${OPENAI}${ANTHROPIC}`);
    await bringEndpointKeysForward(at);
    unknownKeys.length = 0;
    const again = readConfigText(readFileSync(at.configPath, "utf8"), at.configPath);
    expect(again.providers.openai?.identify).toBe(true);
    expect(again.providers.anthropic?.identify).toBe(true);
    expect(unknownKeys).toEqual([]);
  });
});
