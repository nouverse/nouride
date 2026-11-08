/**
 * The update provider is reached only by dynamic import, and the gate in front of it is the
 * strongest one this daemon has.
 *
 * Three properties, and the third is the one that would go wrong silently:
 *
 * 1. **No static import.** `packages/update` is resolved by package name at boot. A static edge
 *    would make the engine's own build depend on a directory that is meant to be separable —
 *    the point of the plugin is that the engine can be published without it.
 * 2. **The ambient declaration must not drift** from the plugin's real exports. The engine
 *    typechecks against a promise about the plugin, not a reading of it, so a rename there is a
 *    runtime `undefined is not a function` at the first call.
 * 3. **`apply` always asks, and `check` never does.** That asymmetry is the whole safety
 *    argument, and both halves fail quietly: a gate that stopped asking would only be noticed
 *    after an unattended daemon replaced itself, and a gate that started asking about `check`
 *    would train somebody to click through the prompt that matters.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BALANCED_ASKS, autoApprovable, classifyHardline } from "@nouride/policy";
import type { ToolContext } from "@nouride/shared";
import { createUpdateTool } from "@/modules/tools/builtins/update.ts";

const ENGINE_SRC = join(import.meta.dir, "../../src");
const PLUGIN_SRC = join(import.meta.dir, "../../../../packages/update/src");

function source(rel: string): string {
  return readFileSync(join(ENGINE_SRC, rel), "utf8");
}

describe("the update plugin is reached only on demand", () => {
  test("no static import of the plugin anywhere in the engine", () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          // `import … from "nouride-update"` is the static form; `await import(…)` has no `from`.
          if (/^(?:import|export)\b[^"']*from\s+["'][^"']*nouride-update/.test(trimmed)) {
            offenders.push(`${path.slice(ENGINE_SRC.length + 1)}: ${trimmed}`);
          }
        }
      }
    };

    walk(ENGINE_SRC);
    expect(offenders).toEqual([]);
  });

  test("the resolver reaches it by package name, not by path", () => {
    const resolver = source("modules/update/index.ts");
    expect(resolver).toContain('import("nouride-update")');
    expect(resolver).not.toMatch(/import\(["']\.\.?[/\\]/);
  });
});

describe("the .d.ts declaration has not drifted from the plugin", () => {
  test("the plugin source is where this test thinks it is", () => {
    expect(existsSync(join(PLUGIN_SRC, "index.ts"))).toBe(true);
  });

  test("every name the engine calls is exported by the plugin", () => {
    /**
     * Read across the whole package, not just its barrel: a name declared in one file and
     * re-exported from `index.ts` is the shape a first version of this test missed and reported
     * as drift.
     */
    const plugin = readdirSync(PLUGIN_SRC)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(PLUGIN_SRC, name), "utf8"))
      .join("\n");
    const decl = source("modules/update/nouride-update.d.ts");
    const facade = source("modules/update/index.ts");

    for (const name of ["verifyUpdateProvider", "checkForUpdate", "installStaged"]) {
      expect(`${name} reached by the facade: ${facade.includes(`provider.${name}`) || facade.includes(`mod.${name}`)}`)
        .toBe(`${name} reached by the facade: true`);
      expect(`${name} in the .d.ts: ${decl.includes(name)}`).toBe(`${name} in the .d.ts: true`);
      expect(`${name} declared by the plugin: ${new RegExp(`export (?:async )?function ${name}\\b`).test(plugin)}`)
        .toBe(`${name} declared by the plugin: true`);
    }
  });

  test("the marker string in the plugin matches the build assertion", () => {
    // `assertEmbedded` searches a compiled binary for this exact sentence. If it changes here
    // the build stops proving the plugin was linked, and says nothing about it.
    const barrel = readFileSync(join(PLUGIN_SRC, "index.ts"), "utf8");
    expect(barrel).toContain("update provider active in this daemon process");
    expect(readFileSync(join(import.meta.dir, "../../../../scripts/build/edition.ts"), "utf8")).toContain(
      "update provider active in this daemon process",
    );
  });
});

describe("the gate in front of replacing this binary", () => {
  const tool = createUpdateTool({
    check: async () => {
      throw new Error("not called");
    },
    apply: async () => {
      throw new Error("not called");
    },
  });
  const ctx = {} as ToolContext;

  test("apply always asks, and can never become a standing grant", () => {
    const decision = tool.gate!({ action: "apply" }, ctx);
    expect(decision.action).toBe("ask");
    if (decision.action !== "ask") throw new Error("unreachable");
    expect(decision.grantable).toBe(false);
    expect(decision.hardline).toBe(true);
    expect(decision.hardlineClass).toBe("replace");
  });

  test("careful asks it every time; balanced answers it itself, as the RFC draws the line", () => {
    /**
     * Stopping the daemon asks at `balanced`; replacing it — an update, a downgrade — is
     * `careful`'s. Asserted through the policy package's own set, so a change that moved it fails here.
     */
    expect(BALANCED_ASKS.has("replace")).toBe(false);
    expect(autoApprovable("replace")).toBe(true);
  });

  test("check is not gated at all", () => {
    // A gate on a read is one an operator learns to click through.
    expect(tool.gate!({ action: "check" }, ctx).action).toBe("run");
  });

  test("the CLI path is classified the same way", () => {
    // An agent with `exec` and no `update` tool reaches the same capability through the CLI — but
    // only with `--start`, which is the word that acts. The bare command reports, like `--check`.
    expect(classifyHardline(["nouride", "update", "--start"])?.class).toBe("replace");
    expect(classifyHardline(["nouride", "update"])).toBeNull();
    expect(classifyHardline(["nouride", "update", "--check"])).toBeNull();
  });
});

describe("applying refuses to leave the conversation without a way back", () => {
  test("`then` is required, and the refusal says why", async () => {
    let applied = false;
    const tool = createUpdateTool({
      check: async () => {
        throw new Error("not called");
      },
      apply: async () => {
        applied = true;
        return { note: "", to: "" };
      },
    });

    const result = await tool.execute({ action: "apply" }, {} as ToolContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ends this conversation");
    // The point of the refusal: nothing was replaced.
    expect(applied).toBe(false);
  });

  test("the wake-up is aimed at the conversation the call came from", async () => {
    let aimed: Record<string, unknown> = {};
    const tool = createUpdateTool({
      check: async () => {
        throw new Error("not called");
      },
      apply: async (wake) => {
        aimed = { ...wake };
        return { note: "swapped", to: "v0.4.0" };
      },
    });

    await tool.execute(
      { action: "apply", then: "check the version changed" },
      { agentId: "a1", gatewayId: "telegram:main", chatId: "c9" } as ToolContext,
    );
    expect(aimed).toMatchObject({
      agentId: "a1",
      gatewayId: "telegram:main",
      chatId: "c9",
      message: "check the version changed",
    });
  });

  test("the delay is clamped rather than trusted", async () => {
    /**
     * A model asking for 0 gets a turn that fires before the daemon is listening; one asking
     * for a day gets a follow-up nobody connects to what it followed. The floor is ten rather
     * than five because the shutdown, `RestartSec=5` and the new process's boot all have to
     * fit inside it — eight seconds on a Raspberry Pi, measured.
     */
    const seen: number[] = [];
    const tool = createUpdateTool({
      check: async () => {
        throw new Error("not called");
      },
      apply: async (wake) => {
        seen.push(wake.delaySeconds);
        return { note: "swapped", to: "v0.4.0" };
      },
    });

    for (const asked of [0, -5, 99999]) {
      await tool.execute({ action: "apply", then: "x", in_seconds: asked }, {} as ToolContext);
    }
    expect(seen).toEqual([10, 10, 600]);
  });
});
