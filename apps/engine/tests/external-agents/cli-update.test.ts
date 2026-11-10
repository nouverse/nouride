/**
 * A coding CLI updated, and the way back (0.8.24, v0.8.24 item 3): `nouride agents update <cli>` holds the CLI, waits
 * until no turn runs in it, installs through the shared tools folder, then has the daemon start it again and check the
 * new version's handshake — in that order. A failed check leaves only that CLI's agents unavailable, naming the version
 * before, which is offered back; a version is held to the same handshake whenever it first starts, with no prompt spent.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BUILT_IN_CLIS, handshakeProblem } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import type { Client } from "@nouride/cli-kit";
import { updateCli, type UpdateSteps } from "@/cli/commands/agents-update.ts";
import { CliUpdates, type UpdateHost } from "@/modules/external-agents/cli-update.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { Hono } from "hono";
import type { CliConnection } from "@/modules/external-agents/connection.ts";
import { plain } from "../cli-harness.ts";

const CLAUDE = BUILT_IN_CLIS.find((row) => row.id === "claude-code")!;
const STEERS = { _meta: { steering: { supported: true } } };
const MODES = ["default", "acceptEdits", "bypassPermissions", "plan"];

describe("a new version's handshake, read for what Nouride uses", () => {
  test("steering and the presets' modes there: nothing lacking", () => {
    expect(handshakeProblem(CLAUDE, STEERS, MODES)).toBeNull();
  });

  test("steering gone, or a preset's mode gone: said by what is gone", () => {
    expect(handshakeProblem(CLAUDE, {}, MODES)).toBe("it no longer offers steering, which a message sent while it works goes through");
    expect(handshakeProblem(CLAUDE, STEERS, ["default", "plan"])).toBe("its sessions no longer offer the modes Nouride's presets set (bypassPermissions, acceptEdits)");
  });

  test("signed out its modes are no verdict, and a person's own CLI is held only to what its row says", () => {
    expect(handshakeProblem(CLAUDE, STEERS, null)).toBeNull();
    expect(handshakeProblem({}, {}, [])).toBeNull();
  });

  test("the built-in CLIs rely on steering, and their own updaters stay off", () => {
    for (const row of BUILT_IN_CLIS) expect({ id: row.id, steering: row.steering }).toEqual({ id: row.id, steering: true });
    expect(CLAUDE.env?.DISABLE_AUTOUPDATER).toBe("1");
    expect(BUILT_IN_CLIS.find((row) => row.id === "codex")!.profileFiles?.["config.toml"]).toContain("check_for_update_on_startup = false");
  });
});

/** A CLI running for an agent, as the update sees it. */
const running = (cli: string, busy = false) => ({ row: { id: cli }, busy, held: false }) as unknown as CliConnection;
const agent = (id: string, cli: string) => ({ config: { id, external: { cli } } }) as unknown as LoadedAgent;

function host(entries: [string, CliConnection][], connect: (agent: LoadedAgent) => Promise<CliConnection>) {
  const stopped: string[] = [];
  const reasons = new Map<string, string>();
  const live = new Map(entries);
  const h: UpdateHost = {
    forgetScan: () => void stopped.push("scan forgotten"),
    runningEntries: () => [...live],
    occupied: (cli) => cli.busy,
    stopAgent: async (id) => void (stopped.push(id), live.delete(id)),
    connection: connect,
    setUnavailable: (id, reason) => void (reason ? reasons.set(id, reason) : reasons.delete(id)),
    versions: { load: () => ({ "claude-code": "0.95.0" }), save: () => {} },
  };
  return { h, stopped, reasons, live };
}

describe("the update, held, installed, checked", () => {
  test("held while a turn runs: no new turn starts in it, and nothing is stopped until none runs", async () => {
    const busy = running("claude-code", true);
    const box = host([["nix", busy], ["kuro", running("codex")]], async () => busy);
    const updates = new CliUpdates(box.h);
    expect(await updates.hold("claude-code")).toBe(1);
    expect(updates.heldFor(CLAUDE)).toBe("Claude Code is being updated: its agents answer again once that is done, in a minute or two");
    expect(updates.heldFor(BUILT_IN_CLIS.find((row) => row.id === "codex")!)).toBeNull();
    expect(box.stopped).toEqual([]);
    (busy as { busy: boolean }).busy = false;
    expect(await updates.hold("claude-code")).toBe(0);
    // Only that CLI's: Codex's agent goes on.
    expect(box.stopped).toEqual(["nix"]);
    updates.release("claude-code");
    expect(updates.heldFor(CLAUDE)).toBeNull();
  });

  test("a hold whose command never came back expires: its agents answer again, and a live one does not (live box, 2026-11-08)", async () => {
    let now = 0;
    const box = host([], async () => running("claude-code"));
    const updates = new CliUpdates(box.h, () => now);
    await updates.hold("claude-code");
    // Asked again every two seconds while a turn runs: the first hold's time counts.
    now = 20 * 60_000;
    await updates.hold("claude-code");
    expect(updates.heldFor(CLAUDE)).not.toBeNull();
    now = 30 * 60_000 + 1;
    expect(updates.heldFor(CLAUDE)).toBeNull();
    // And it stays let go.
    now = 0;
    expect(updates.heldFor(CLAUDE)).toBeNull();
  });

  test("checked: released, started again for its first agent, and a reason the version before left goes", async () => {
    const started: string[] = [];
    const box = host([], async (one) => (started.push(one.config.id), { info: { agentInfo: { version: "0.100.0" } } }) as unknown as CliConnection);
    box.reasons.set("nix", "an old reason");
    const updates = new CliUpdates(box.h);
    await updates.hold("claude-code");
    const checked = await updates.check("claude-code", [agent("nix", "claude-code"), agent("nox", "claude-code"), agent("kuro", "codex")]);
    expect(checked).toEqual({ cli: "claude-code", passed: true, version: "0.100.0", before: "0.95.0" });
    expect(started).toEqual(["nix"]);
    // The scan kept for a minute said the version before: the Models page read it after an update.
    expect(box.stopped).toEqual(["scan forgotten"]);
    expect(updates.heldFor(CLAUDE)).toBeNull();
    expect([...box.reasons]).toEqual([]);
  });

  test("a failed check leaves that CLI's agents unavailable, and only those", async () => {
    const box = host([], async () => {
      throw new Error("Claude Code 0.101.0 did not pass Nouride's check: it no longer offers steering");
    });
    box.reasons.set("kuro", "Codex is not signed in");
    const checked = await new CliUpdates(box.h).check("claude-code", [agent("nix", "claude-code"), agent("nox", "claude-code"), agent("kuro", "codex")]);
    expect(checked).toMatchObject({ cli: "claude-code", passed: false, before: "0.95.0" });
    expect([...box.reasons.keys()].sort()).toEqual(["kuro", "nix", "nox"]);
    expect(box.reasons.get("nix")).toContain("did not pass Nouride's check");
    expect(box.reasons.get("kuro")).toBe("Codex is not signed in");
  });

  test("a version that fails its handshake when it first starts names the version to go back to, and offers it", async () => {
    const box = host([], async () => running("claude-code"));
    const updates = new CliUpdates(box.h);
    const connection = {
      info: { agentInfo: { version: "0.101.0" }, _meta: {} },
      launch: { cwd: "/srv/agents/nix" },
      probe: async () => ({ sessionId: "s1", modes: { currentModeId: "default", availableModes: MODES.map((id) => ({ id, name: id })) } }),
    } as unknown as CliConnection;
    expect(await updates.checkVersion(CLAUDE, connection)).toBe(
      "Claude Code 0.101.0 did not pass Nouride's check: it no longer offers steering, which a message sent while it works goes through. Go back to 0.95.0 (`nouride agents update claude-code 0.95.0`), or update Nouride",
    );
    expect(updates.wayBack("claude-code")).toBe("0.95.0");
    expect(updates.wayBack("codex")).toBeNull();
  });
});

describe("`nouride agents update`", () => {
  let lines: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];
  class Exit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }
  beforeEach(() => {
    lines = [];
    spies = [
      spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? "")))),
      spyOn(console, "error").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? "")))),
      spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Exit(code);
      }) as never),
    ];
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  const SCANNED = { id: "claude-code", name: "Claude Code", command: "claude-agent-acp", install: "", login: true, installed: true, version: "0.95.0", package: "@agentclientprotocol/claude-agent-acp", tested: { lowest: "0.95.0", highest: "0.100.0" }, standing: { standing: "update", offer: "0.100.0" } };

  /** A daemon that is busy for `busyFor` holds, and checks as `checked` says; every step written down in order. */
  function daemon(busyFor: number, checked: Record<string, unknown> = { cli: "claude-code", passed: true, version: "0.100.0", before: "0.95.0" }) {
    const order: string[] = [];
    let holds = 0;
    const client = {
      get: async (path: string) => (order.push(`get ${path}`), { room: { enough: true, bytes: 0, needs: 0 }, clis: [SCANNED] }),
      post: async (path: string) => {
        order.push(`post ${path}`);
        if (path.endsWith("/hold")) return { busy: holds++ < busyFor ? 1 : 0 };
        if (path.endsWith("/check")) return checked;
        return { ok: true };
      },
    } as unknown as Client;
    return { client, order };
  }

  function steps(order: string[], exitCode: number | null = 0): UpdateSteps {
    let now = 0;
    return {
      install: async (command) => (order.push(`install ${command.join(" ")}`), exitCode === 0 ? { exitCode, shared: { ok: true } } : { exitCode, shared: null }),
      pause: async (ms) => void (order.push(`wait ${ms}`), (now += ms)),
      now: () => now,
    };
  }

  test("waits until no turn runs, installs the newest tested, then has the daemon check it: in that order", async () => {
    const { client, order } = daemon(2);
    await updateCli(client, ["claude-code"], steps(order));
    expect(order).toEqual([
      "get /external-clis?fresh=1",
      "post /external-clis/claude-code/hold",
      "wait 2000",
      "post /external-clis/claude-code/hold",
      "wait 2000",
      "post /external-clis/claude-code/hold",
      "install npm install -g @agentclientprotocol/claude-agent-acp@0.100.0",
      "post /external-clis/claude-code/check",
    ]);
    expect(lines.join("\n")).toContain("Claude Code is at 0.100.0, from 0.95.0: its handshake has what Nouride uses");
  });

  test("at the version already: nothing installed, and a hold a cut-off run left is let go (live box, 2026-11-08)", async () => {
    const { client, order } = daemon(0);
    SCANNED.version = "0.100.0";
    try {
      await updateCli(client, ["claude-code"], steps(order));
    } finally {
      SCANNED.version = "0.95.0";
    }
    expect(order).toEqual(["get /external-clis?fresh=1", "post /external-clis/claude-code/release"]);
    expect(lines.join("\n")).toContain("Claude Code is at 0.100.0 already");
  });

  test("the way back is the same with the version named", async () => {
    const { client, order } = daemon(0);
    await updateCli(client, ["claude-code", "0.95.1"], steps(order));
    expect(order).toContain("install npm install -g @agentclientprotocol/claude-agent-acp@0.95.1");
  });

  test("a failed check exits 1 and names the version to go back to", async () => {
    const { client, order } = daemon(0, { cli: "claude-code", passed: false, problem: "Claude Code 0.100.0 did not pass Nouride's check: it no longer offers steering", before: "0.95.0" });
    await expect(updateCli(client, ["claude-code"], steps(order))).rejects.toThrow("exit 1");
    expect(lines).toContain("  Go back: nouride agents update claude-code 0.95.0");
  });

  test("an install that does not finish lets the CLI go as it was, and nothing is checked", async () => {
    const { client, order } = daemon(0);
    await expect(updateCli(client, ["claude-code"], steps(order, 1))).rejects.toThrow("exit 1");
    expect(order.slice(-2)).toEqual(["install npm install -g @agentclientprotocol/claude-agent-acp@0.100.0", "post /external-clis/claude-code/release"]);
  });

  test("a turn that keeps running ten minutes: let go, nothing installed", async () => {
    const { client, order } = daemon(Number.POSITIVE_INFINITY);
    await expect(updateCli(client, ["claude-code"], steps(order))).rejects.toThrow("exit 1");
    expect(order.some((step) => step.startsWith("install"))).toBe(false);
    expect(order.at(-1)).toBe("post /external-clis/claude-code/release");
  });
});

describe("the update's routes", () => {
  const TOKEN = "control-token-for-tests-0000000000";
  /** The control API as the CLI reaches it, with the control token: an admin's. */
  function app() {
    const audited: { action: string; details?: unknown }[] = [];
    const steps: string[] = [];
    const scoped = new Hono();
    mountControlRoutes(scoped, {
      ctx: { config: { daemon: {}, llm: { defaults: {} }, security: {} }, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
      token: TOKEN,
      registry: { all: () => [agent("nix", "claude-code")], get: () => undefined } as never,
      audit: { record: (entry: { action: string; details?: unknown }) => void audited.push(entry) },
      externalAgents: {
        row: (id: string) => (id === "claude-code" ? CLAUDE : undefined),
        updates: {
          hold: async (cli: string) => (steps.push(`hold ${cli}`), 0),
          release: (cli: string) => void steps.push(`release ${cli}`),
          check: async (cli: string, agents: LoadedAgent[]) => (steps.push(`check ${cli} ${agents.map((one) => one.config.id).join(",")}`), { cli, passed: true, version: "0.100.0", before: "0.95.0" }),
        },
      },
    } as unknown as ControlDeps);
    const call = (path: string) => scoped.request(`/api/control${path}`, { method: "POST", headers: { "x-nouride-token": TOKEN } }, { clientAddress: "203.0.113.10" });
    return { call, audited, steps };
  }

  test("held, released and checked by an admin, the check audited with what it came to", async () => {
    const { call, audited, steps } = app();
    expect(await (await call("/external-clis/claude-code/hold")).json()).toEqual({ busy: 0 });
    expect((await call("/external-clis/claude-code/release")).status).toBe(200);
    expect(await (await call("/external-clis/claude-code/check")).json()).toEqual({ cli: "claude-code", passed: true, version: "0.100.0", before: "0.95.0" });
    expect(steps).toEqual(["hold claude-code", "release claude-code", "check claude-code nix"]);
    expect(audited).toEqual([{ action: "cli_updated", actor: "cli", details: { cli: "claude-code", passed: true, version: "0.100.0", before: "0.95.0" } } as never]);
  });

  test("a CLI it does not know: 404, nothing held", async () => {
    const { call, steps } = app();
    expect((await call("/external-clis/nope/hold")).status).toBe(404);
    expect((await call("/external-clis/nope/check")).status).toBe(404);
    expect(steps).toEqual([]);
  });
});
