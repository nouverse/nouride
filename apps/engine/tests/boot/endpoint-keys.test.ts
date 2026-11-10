/**
 * A profile written before setup knew what OpenAI's own API needs is given it at the first start of this build
 * (`boot/endpoint-keys.ts`), so the update is all a person has to do: without `max_tokens_field`, every reply and every
 * compaction on a GPT-5-family model was refused for sending `max_tokens`. Each case is a `config.toml` as an older
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

[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic_api_key"
`;

/** An install's `config.toml`, and the running config the daemon loaded from it. */
function install(text: string) {
  const configPath = join(tempDir("endpoint-keys"), "config.toml");
  writeFileSync(configPath, text);
  return { configPath, config: readConfigText(text, configPath) };
}

describe("an older install with a profile on OpenAI's own API", () => {
  test("has max_tokens_field written under that profile alone, the rest of its file as it was, and live for this boot", async () => {
    const at = install(`# my box\n${OPENAI}${OTHERS}`);
    said.length = 0;
    expect(await bringEndpointKeysForward(at)).toEqual(["openai"]);

    const after = readFileSync(at.configPath, "utf8");
    // Byte for byte, with one line added under the profile's last value.
    expect(after).toBe(`# my box\n${OPENAI.replace("# the secret's name\n", '# the secret\'s name\nmax_tokens_field = "max_completion_tokens"\n')}${OTHERS}`);
    expect(at.config.providers.openai?.maxTokensField).toBe("max_completion_tokens");
    for (const other of ["openrouter", "nougate", "anthropic"]) expect(at.config.providers[other]?.maxTokensField).toBeUndefined();

    expect(said.map((entry) => [entry.level, entry.message, entry.data])).toEqual([
      [
        "info",
        "wrote what this provider profile's endpoint needs into config.toml",
        {
          profile: "openai",
          max_tokens_field: "max_completion_tokens",
          why: "OpenAI's own API takes a reply's output limit only as max_completion_tokens for its newer models",
        },
      ],
    ]);
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
    expect(await bringEndpointKeysForward(at)).toEqual([]);
    expect(readFileSync(at.configPath, "utf8")).toBe(text);
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
