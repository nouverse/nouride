/**
 * The install's `.env`, read by `nouride start` itself now that the binary reads nothing from where it runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEnvPort, loadInstallEnv, parseDotEnv } from "@/modules/config/global/dotenv.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a .env", () => {
  test("is read as one is written: export, comments, both quotes, a bare value cut at its comment", () => {
    const text = [
      "# provider keys",
      "export NOUGATE=sk-abc123",
      "TELEGRAM_TOKEN = 123:abc   # the bot",
      "QUOTED=\"two\\nlines\"",
      "LITERAL='keep $this \\n'",
      "EMPTY=",
      "not a line",
      "1BAD=x",
    ].join("\n");
    expect(parseDotEnv(text)).toEqual({ NOUGATE: "sk-abc123", TELEGRAM_TOKEN: "123:abc", QUOTED: "two\nlines", LITERAL: "keep $this \\n", EMPTY: "" });
  });

  test("never replaces what the environment already has — EnvironmentFile= and env_file still decide", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-dotenv-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), "NOUGATE=from-file\nNEW_ONE=from-file\n");
    const env: Record<string, string | undefined> = { NOUGATE: "from-environment" };
    expect(loadInstallEnv(dir, env)).toEqual(["NEW_ONE"]);
    expect(env).toEqual({ NOUGATE: "from-environment", NEW_ONE: "from-file" });
  });

  test("an install with none, or no install at all, sets nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-dotenv-"));
    dirs.push(dir);
    expect(loadInstallEnv(dir, {})).toEqual([]);
    expect(loadInstallEnv("", {})).toEqual([]);
  });
});

describe("the port a CLI connects to", () => {
  /** An install with `env` as its .env, and its data directory. */
  function install(env: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "nouride-dotenv-port-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".nouride", "data"), { recursive: true });
    if (env !== null) writeFileSync(join(dir, ".env"), env);
    return join(dir, ".nouride", "data");
  }

  test("is the one `install.sh --port` wrote into the install's .env, which the daemon takes over the config", () => {
    // `install.sh --port 18299` on a Mac: the daemon answered on 18299 and `nouride status` knocked on 18254.
    expect(installEnvPort(install("NOUGATE=sk-x\nPORT=18299\n"))).toBe(18299);
    expect(installEnvPort(`${install("PORT=18300\n")}/`)).toBe(18300);
  });

  test("is no answer where the .env sets none, sets nonsense, or the data directory is not an install's", () => {
    expect(installEnvPort(install(null))).toBeNull();
    expect(installEnvPort(install("HOST=0.0.0.0\n"))).toBeNull();
    expect(installEnvPort(install("PORT=http\n"))).toBeNull();
    expect(installEnvPort(install("PORT=70000\n"))).toBeNull();
    // A data_dir moved elsewhere names no install whose .env this could be.
    const moved = mkdtempSync(join(tmpdir(), "nouride-dotenv-moved-"));
    dirs.push(moved);
    writeFileSync(join(moved, ".env"), "PORT=18301\n");
    mkdirSync(join(moved, "data"));
    expect(installEnvPort(join(moved, "data"))).toBeNull();
  });
});
