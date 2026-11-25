/**
 * `nouride config check` over where each WhatsApp number keeps its login.
 *
 * The check is where a person looks before an upgrade, with no daemon to ask. An install linked while a daemon held
 * one number has its login in a folder named for no connection: the check says which connection it is and what the
 * next start writes, and writes nothing itself. Two connections on one folder are refused, as the daemon refuses
 * them. Spawned, as it is run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

let root: string;
let configPath: string;
let data: string;

const number = (name: string, more = "") => `\n[gateways.whatsapp.${name}]\nenabled = false\nencryption_key = "whatsapp-${name}-key"\n${more}`;

function install(connections: string): void {
  writeFileSync(
    configPath,
    `[daemon]\ndata_dir = "${data}"\nagents_dir = "${join(root, "agents")}"\norchestrator = "nouva"\n\n[dashboard]\nport = 9\n\n` +
      '[providers.nougate]\nkind = "openai"\nbase_url = "https://example.invalid/v1"\napi_key = "nougate"\n' +
      connections,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-check-whatsapp-"));
  configPath = join(root, "config.toml");
  data = join(root, "data");
  mkdirSync(join(root, "agents", "nouva"), { recursive: true });
  writeFileSync(join(root, "agents", "nouva", "IDENTITY.md"), "nouva\n");
  writeFileSync(join(root, "agents", "nouva", "config.toml"), '[llm]\nprovider = "nougate"\nmodel = "m"\n');
  // The login of an install linked before each connection kept its own folder.
  mkdirSync(join(data, "whatsapp"), { recursive: true });
  writeFileSync(join(data, "whatsapp", "creds.enc"), "encrypted-login-bytes");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = () => runCli(["config", "check"], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });

describe("an install's one login, from before each connection kept its own folder", () => {
  test("is said with the connection it is and what the next start writes, and the check writes nothing", async () => {
    install(number("main") + number("shop"));
    const before = readFileSync(configPath, "utf8");
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("✓ this configuration would start");
    expect(run.out).toContain(`[gateways.whatsapp.main] names no session_dir, and its login is in ${join(data, "whatsapp")}: the next start writes that folder into its table, so the number stays linked`);
    expect(run.out).toContain("Nothing is moved, and no scan is needed.");
    expect(run.out).not.toContain("[gateways.whatsapp.shop] names no session_dir");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("once its table names the folder, nothing more is said", async () => {
    install(number("main", `session_dir = "${join(data, "whatsapp")}"\n`) + number("shop"));
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("names no session_dir");
  });
});

describe("two connections on one folder", () => {
  test("would not start, and the check says which two", async () => {
    install(number("main", 'session_dir = "/var/lib/wa"\n') + number("shop", 'session_dir = "/var/lib/wa"\n'));
    const run = await check();
    expect(run.code).not.toBe(0);
    expect(run.out + run.err).toContain("[gateways.whatsapp.main] and [gateways.whatsapp.shop] keep their login in one folder (/var/lib/wa). Each WhatsApp number needs its own");
  });
});
