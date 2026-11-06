/**
 * `[memory]` and `[[people]] key` — each key in `config.example.toml`.
 *
 * Every refusal here is a memory that would otherwise be silently wrong at runtime: an owner key that
 * matches nobody makes the owner a stranger to their own assistant, two people sharing a key merge two
 * people's memory into one profile, and a key that is not a plain slug becomes a path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, removePath, writeTextFile } from "@nouride/runtime";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-memory-config-"));
});

afterEach(() => {
  removePath(dir);
});

async function load(toml: string) {
  // Beside an install, which is where a bare config.toml in the working directory is read (`loadGlobalConfig`).
  ensureDir(join(dir, ".nouride"));
  await writeTextFile(join(dir, "config.toml"), toml);
  return await loadGlobalConfig(dir);
}

const GADING = '[[people]]\nids = ["telegram:1"]\nname = "Gading"\nkey = "gading"\n';

describe("[memory]", () => {
  test("defaults: no owner yet, the pass off until the wizard asks, at one in the morning, a week of transcripts, inside the install", async () => {
    const { config } = await load("");
    expect(config.memory).toMatchObject({
      pass: false,
      passAt: "01:00",
      passPerNight: 20,
      // No budget of the pass's own: what bounded a night before it existed still does, and nobody's spend moves.
      passMaxTokens: 0,
      passProvider: "",
      passModel: "",
      maxAttempts: 3,
      facts: "off",
      proposeShared: false,
      promptRecent: 3,
      transcriptDays: 180,
      archive: true,
    });
    // Resolved against the install — and never inside a pack.
    expect(config.memory.dir).toBe(join(dir, ".nouride", "memory"));
    expect(config.memory.dir.startsWith(config.daemon.agentsDir)).toBe(false);
  });

  test("a pass time that is not HH:MM is refused", async () => {
    for (const bad of ["1:00", "25:00", "01:60", "01.00", "night"]) {
      await expect(load(`[memory]\npass_at = "${bad}"\n`)).rejects.toThrow(/pass_at/);
    }
    const { config } = await load(`[memory]\npass_at = "23:30"\n`);
    expect(config.memory.passAt).toBe("23:30");
  });

  test("facts must be auto, ask or off — a person's own too", async () => {
    await expect(load(`[memory]\nfacts = "always"\n`)).rejects.toThrow(/facts/);
    await expect(load(`${GADING}facts = "sometimes"\n`)).rejects.toThrow(/Gading.*facts/);
    expect((await load(`${GADING}facts = "ask"\n`)).config.people[0]?.facts).toBe("ask");
  });

  test("counts outside their ranges are refused", async () => {
    await expect(load("[memory]\npass_per_night = 0\n")).rejects.toThrow(/pass_per_night/);
    await expect(load("[memory]\nmax_attempts = 0\n")).rejects.toThrow(/max_attempts/);
    await expect(load("[memory]\nprompt_recent = 50\n")).rejects.toThrow(/prompt_recent/);
    await expect(load("[memory]\ntranscript_days = -1\n")).rejects.toThrow(/transcript_days/);
    await expect(load("[memory]\ntranscript_days = 3651\n")).rejects.toThrow(/transcript_days/);
    await expect(load("[memory]\npass_max_tokens = -1\n")).rejects.toThrow(/pass_max_tokens/);
    await expect(load("[memory]\npass_max_tokens = 2.5\n")).rejects.toThrow(/pass_max_tokens/);
    expect((await load("[memory]\npass_max_tokens = 500000\n")).config.memory.passMaxTokens).toBe(500_000);
  });

  test("transcript_days = 0 keeps transcripts forever", async () => {
    expect((await load("[memory]\ntranscript_days = 0\n")).config.memory.transcriptDays).toBe(0);
  });

  test("a pass provider that is not a profile is refused", async () => {
    await expect(load(`[memory]\npass_provider = "nope"\npass_model = "m"\n`)).rejects.toThrow(/pass_provider "nope"/);
    // One without the other is refused: a bare model would go to each agent's own provider.
    await expect(load(`[memory]\npass_model = "m"\n`)).rejects.toThrow(/go together/);
  });

  test("the keys retired with the timeline are reported as unknown, not honoured", async () => {
    const { config } = await load(`${GADING}[memory]\nremember = ["gading"]\nowners_see_all = false\nconsolidate = true\n`);
    const memory = config.memory as unknown as Record<string, unknown>;
    expect(memory.remember).toBeUndefined();
    expect(memory.ownersSeeAll).toBeUndefined();
    expect(memory.consolidate).toBeUndefined();
    // Not read as `pass`, which stays at its default.
    expect(config.memory.pass).toBe(false);
  });

  test("the MCP server is its own [mcp_server], off by default; the old [memory.mcp] is not honoured", async () => {
    expect((await load(GADING)).config.mcpServer).toEqual({ enabled: false });
    expect((await load(`${GADING}[mcp_server]\nenabled = true\n`)).config.mcpServer).toEqual({ enabled: true });
    const old = await load(`${GADING}[memory.mcp]\nenabled = true\n`);
    expect(old.config.mcpServer.enabled).toBe(false);
    expect((old.config.memory as unknown as Record<string, unknown>).mcp).toBeUndefined();
  });
});

describe("[[people]] key", () => {
  test("is the person: an entry written without one gets one from its name, an empty one too", async () => {
    const { config } = await load('[[people]]\nids = ["telegram:1"]\nname = "Kak Gading"\n\n[[people]]\nkey = ""\nname = "Sam"\n');
    expect(config.people).toEqual([
      { key: "gading", name: "Kak Gading", ids: ["telegram:1"] },
      { key: "sam", name: "Sam" },
    ]);
  });

  test("a person with no account at all loads: added by name, attached to one when they pair", async () => {
    const { config } = await load('[[people]]\nkey = "kid"\nname = "Kid"\n');
    expect(config.people).toEqual([{ key: "kid", name: "Kid" }]);
  });

  test("must be a plain slug, because it becomes a file name", async () => {
    for (const bad of ["../etc", "Gading", "a b", "a/b", "-x"]) {
      await expect(load(`[[people]]\nids = ["telegram:1"]\nname = "Gading"\nkey = "${bad}"\n`)).rejects.toThrow(/key/);
    }
  });

  test("two people may not share a key", async () => {
    await expect(load(`${GADING}[[people]]\nids = ["whatsapp:2"]\nname = "Other"\nkey = "gading"\n`)).rejects.toThrow(/key "gading".*already/);
  });

  test("nobody may be keyed shared: that is the household's file", async () => {
    await expect(load('[[people]]\nids = ["telegram:1"]\nname = "Shared"\nkey = "shared"\n')).rejects.toThrow(/shared/);
  });
});

describe("[gateways.whatsapp] session_dir", () => {
  const WA = '[gateways.whatsapp.main]\nenabled = false\nencryption_key = "wa_key"\n';
  test("unset, the login lives under data_dir — with the rest of the state, in the volume a container mounts", async () => {
    const { config } = await load(WA);
    expect(config.gateways.find((g) => g.id === "whatsapp:main")?.sessionDir).toBe(join(config.daemon.dataDir, "whatsapp"));
  });

  test("set, it is used as written, resolved against the install", async () => {
    const { config } = await load(`${WA}session_dir = "./data/whatsapp"\n`);
    expect(config.gateways.find((g) => g.id === "whatsapp:main")?.sessionDir).toBe(join(dir, "data", "whatsapp"));
  });
});
