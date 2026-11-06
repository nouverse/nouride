/**
 * A secret kept from an agent's chat is handed to every command of that agent (`bindPackSecret`): the pack gains
 * `[security.exec_secrets] <name> = ["*"]`, and a name it already binds — narrowed by hand — stays as it is.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@nouride/runtime";
import { bindPackSecret } from "@/modules/config/settings/agents.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-bind-secret-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let reloads = 0;
function pack(name: string, text: string): { agentConfigPath: string; reload: () => Promise<void> } {
  const agentConfigPath = join(dir, `${name}.toml`);
  writeFileSync(agentConfigPath, text);
  return { agentConfigPath, reload: async () => void reloads++ };
}
const secrets = (path: string) => parseToml<{ security?: { exec_secrets?: Record<string, string[]> } }>(readFileSync(path, "utf8")).security?.exec_secrets;

describe("bindPackSecret", () => {
  test("a pack with no exec_secrets gains the table, the name bound to every command, and its agent reloads", async () => {
    const p = pack("bare", '[agent]\nname = "Nix"\n');
    const before = reloads;
    expect(await bindPackSecret({ ...p, name: "stirling_api_key" })).toEqual({ ok: true, changed: true });
    expect(secrets(p.agentConfigPath)).toEqual({ stirling_api_key: ["*"] });
    expect(reloads).toBe(before + 1);
  });

  test("a new name joins the bindings already there, which are left as they were", async () => {
    const p = pack("some", '[security.exec_secrets]\ngithub_token = ["gh", "git"]\n');
    expect(await bindPackSecret({ ...p, name: "pypi_token" })).toEqual({ ok: true, changed: true });
    expect(secrets(p.agentConfigPath)).toEqual({ github_token: ["gh", "git"], pypi_token: ["*"] });
  });

  test("a name already bound — narrowed to some commands — is not widened, and nothing is written", async () => {
    const text = '[security.exec_secrets]\ngithub_token = ["gh"]\n';
    const p = pack("narrow", text);
    const before = reloads;
    expect(await bindPackSecret({ ...p, name: "github_token" })).toEqual({ ok: true, changed: false });
    expect(readFileSync(p.agentConfigPath, "utf8")).toBe(text);
    expect(reloads).toBe(before);
  });
});
