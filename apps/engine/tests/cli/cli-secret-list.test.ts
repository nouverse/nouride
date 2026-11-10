/**
 * `nouride secret list` says a credential the configuration needs and nobody set is not set (0.8.15).
 *
 * The daemon answers `missing` for a name its config references that neither the store nor the environment has, and
 * the CLI printed every origin that was not `env` as `store`. Under Nix's benchmark (2026-11-02) the provider key
 * `nouride setup` had stored was lost, and `secret list` still showed `default_api_key store`, so the install looked
 * fine while its bot answered nothing.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { secret } from "../../../cli/src/commands/secret.ts";
import type { SecretEntry } from "@/modules/config/settings/secrets.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

async function list(rows: SecretEntry[]): Promise<string[]> {
  const client = { get: async <T>(_path: string) => ({ secrets: rows }) as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await secret(client, ["list"]);
  } finally {
    log.mockRestore();
  }
  return lines;
}

const row = (name: string, origin: SecretEntry["origin"], usedBy: string[] = []): SecretEntry => ({ name, origin, usedBy, shadowed: false, fields: {} });

test("a name the config needs and nobody set reads as not set, with what needs it and how to set it", async () => {
  const lines = await list([row("default_api_key", "missing", ["provider default"]), row("telegram_bot_token", "store", ["gateway telegram:main"])]);
  const missing = lines.find((line) => line.startsWith("default_api_key"));
  expect(missing).toContain("not set");
  expect(missing).not.toContain("store");
  expect(missing).toContain("provider default");
  expect(lines.find((line) => line.startsWith("telegram_bot_token"))).toContain("store");
  expect(lines.join("\n")).toContain("nouride secret set default_api_key --stdin");
});

test("with nothing missing there is no line about setting one", async () => {
  const lines = await list([row("telegram_bot_token", "store"), row("brave_search_api_key", "env")]);
  expect(lines.find((line) => line.startsWith("brave_search_api_key"))).toContain("env");
  expect(lines.join("\n")).not.toContain("not set");
});
