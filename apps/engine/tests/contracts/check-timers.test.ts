/**
 * `lint:timers` checks itself: every form it lets through cannot throw, every form it refuses is named by file and
 * line, a timer reached through an alias is still read, and a run that finds too few timers fails.
 *
 * Written after what it guards: 0.7.10 found a throw out of `pipeline/provider-resume.ts`'s timer — an uncaught
 * exception, which shuts the daemon down — and then two dozen more like it. A lint that stopped looking would pass for
 * ever, so each rule is pinned from both sides here rather than trusted from the tree's own clean run.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkTimers, floorFailure, isDaemonSource, MIN_TIMERS, timerFindings } from "../../../../scripts/check-timers.ts";

const ROOT = join(import.meta.dir, "../../../..");

/** The lines a planted file is told about. */
const flagged = (text: string, rel = "apps/engine/src/planted.ts") => timerFindings(rel, text).findings.map((finding) => finding.line);
/** Whether a planted callback, alone in its file, passes. */
const passes = (text: string) => flagged(text).length === 0;

describe("this tree", () => {
  test("holds: every timer in daemon code is one that cannot let an exception out", async () => {
    const { timers, findings } = await checkTimers(ROOT);
    expect(findings).toEqual([]);
    expect(floorFailure(timers)).toBeNull();
  });

  test("and the lint says so the way lint:check runs it", () => {
    const run = spawnSync("bun", ["run", "scripts/check-timers.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("none can let an exception out");
    expect(run.status).toBe(0);
    // A whole parse of the tree in a process of its own: about a second alone, more under a loaded machine.
  }, 60_000);
});

describe("what is refused", () => {
  test("a callback that reaches a store is named by its line, with what to write instead", () => {
    const [finding] = timerFindings("apps/engine/src/boot/sweep.ts", "const a = 1;\nsetInterval(() => store.sweep(30), DAY);\n").findings;
    expect(finding).toMatchObject({ file: "apps/engine/src/boot/sweep.ts", line: 2 });
    expect(finding!.detail).toContain("`setInterval`'s callback can let an exception out");
    expect(finding!.detail).toContain("contained(log, \"what failed\", …)");
  });

  test("every way to start one is a timer", () => {
    for (const start of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "globalThis.setTimeout", "options.setInterval", "process.nextTick"]) {
      expect({ start, lines: flagged(`${start}(() => store.sweep(), 5);`) }).toEqual({ start, lines: [1] });
    }
  });

  test("what only looks harmless: a call is never taken on trust, nor a promise let go of, nor a function by name", () => {
    for (const callback of [
      // A rejection nobody catches — the second half of the bug.
      "() => void tick()",
      "async () => { await store.sweep(); }",
      "tick",
      // Reads like a map's; is a database's.
      "() => this.pending.delete(id)",
      "() => { this.timer = undefined; this.flush(); }",
      // A try that catches nothing, or that is not the whole body.
      "() => { try { flush(); } finally { done(); } }",
      "() => { try { flush(); } catch {} done(); }",
      // Values only, never what a call returned — and only an error is built to reject with.
      "() => controller.abort(reasonFor(id))",
      "() => { this.timer = next(); }",
    ]) {
      expect({ callback, lines: flagged(`setTimeout(${callback}, 5);`) }).toEqual({ callback, lines: [1] });
    }
  });

  test("`resolve` is only a promise's own: not a function of that name, not an argument computed, not one shadowed", () => {
    expect(flagged("const resolve = () => store.write();\nsetTimeout(resolve, 5);")).toEqual([2]);
    expect(flagged("new Promise((resolve) => setTimeout(() => resolve(compute()), 5));")).toEqual([1]);
    expect(flagged("new Promise((resolve) => setTimeout(() => resolve(new Thing()), 5));")).toEqual([1]);
    expect(flagged("new Promise((resolve) => {\n  const later = (resolve: () => void) => setTimeout(resolve, 5);\n});")).toEqual([2]);
    expect(flagged("new Map([[1, (resolve: () => void) => setTimeout(resolve, 5)]]);")).toEqual([1]);
  });

  test("a timer reached through an alias is read; one handed on any other way is refused", () => {
    expect(flagged("const later = options.setInterval ?? setInterval;\nlater(() => store.sweep(), 5);")).toEqual([2]);
    expect(passes("const later = options.setInterval ?? setInterval;\nlater(contained(log, \"x\", tick), 5);")).toBe(true);
    expect(flagged("[tick].forEach(setTimeout);")).toEqual([1]);
    expect(flagged("const { setTimeout: later } = globalThis;")).toEqual([1]);
    expect(timerFindings("apps/engine/src/planted.ts", "[tick].forEach(setTimeout);").findings[0]!.detail).toContain("handed on as a value");
  });
});

describe("what is let through", () => {
  test("the forms that cannot throw", () => {
    for (const text of [
      "new Promise((resolve) => setTimeout(resolve, 5));",
      "new Promise((r) => setTimeout(() => r(\"timeout\"), ms));",
      "new Promise<void>((resolve, reject) => { setTimeout(() => reject(new GatewayError(this.id, `login timed out after ${ms / 1000}s`)), 5); });",
      "setTimeout(() => controller.abort(), 5);",
      "setTimeout(() => { this.timer = undefined; clearTimeout(this.other); }, 5);",
      "setTimeout(() => {}, 5);",
    ]) {
      expect({ text, lines: flagged(text) }).toEqual({ text, lines: [] });
    }
  });

  test("the helper, and its equivalent by hand — a try around the whole body, awaited or not", () => {
    expect(passes("setInterval(contained(log, \"the sweep failed\", () => store.sweep()), DAY);")).toBe(true);
    expect(passes("setTimeout(() => { try { store.sweep(); } catch (err) { note(String(err)); } }, 5);")).toBe(true);
    expect(passes("setTimeout(async () => { try { await store.sweep(); } catch {} }, 5);")).toBe(true);
  });

  test("a type that names a timer is not one", () => {
    const text = "let timer: ReturnType<typeof setTimeout>;\ninterface Options { setInterval?: typeof setInterval; clear(t: ReturnType<typeof setInterval>): void }";
    expect(timerFindings("apps/engine/src/planted.ts", text)).toEqual({ timers: 0, listeners: 0, findings: [] });
  });
});

describe("listeners", () => {
  // What emits an event is the event loop — a socket, a child process, a signal aborting — so a listener's throw is
  // uncaught, as a timer's is. In Bun `abort()` returns normally and the throw still reaches `uncaughtException`.
  test("every way to register one is read, and a listener that can throw is named by its line", () => {
    for (const register of [
      'signal.addEventListener("abort", () => store.sweep())',
      'socket.on("data", (chunk) => buffer.push(parse(chunk)))',
      'child.once("exit", () => this.settle())',
      'emitter.addListener("x", () => tick())',
      'emitter.prependListener("x", () => tick())',
      'emitter.prependOnceListener("x", () => tick())',
      "signal.onabort = () => store.sweep()",
    ]) {
      expect({ register, lines: flagged(`const a = 1;\n${register};`) }).toEqual({ register, lines: [2] });
    }
    const [finding] = timerFindings("packages/x/src/a.ts", 'socket.on("error", () => fail());').findings;
    expect(finding!.detail).toContain('the listener given to `on("error")` can let an exception out');
  });

  test("the forms that cannot throw: contained, a whole try, a promise's own reject, an abort, taking a handler away", () => {
    expect(passes('socket.on("data", contained(log, "could not take a chunk", (chunk: string) => buffer.push(chunk)));')).toBe(true);
    expect(passes('socket.on("data", (chunk) => { try { buffer.push(parse(chunk)); } catch {} });')).toBe(true);
    expect(passes('new Promise((resolve, reject) => { child.once("error", reject); child.once("spawn", () => resolve()); });')).toBe(true);
    expect(passes('signal.addEventListener("abort", () => controller.abort());')).toBe(true);
    expect(passes("signal.onabort = null;")).toBe(true);
  });

  test("a listener by name is judged by what the file declares it as", () => {
    expect(passes('const stop = contained(log, "x", () => reader.cancel());\nsignal.addEventListener("abort", stop);')).toBe(true);
    expect(passes('function onAbort() { try { kill(); } catch {} }\nsignal.addEventListener("abort", onAbort);')).toBe(true);
    expect(flagged('const stop = () => reader.cancel();\nsignal.addEventListener("abort", stop);')).toEqual([2]);
    expect(flagged('signal.addEventListener("abort", handler);')).toEqual([1]);
  });

  test("an `on…` property that is not an event's handler is not one", () => {
    expect(passes("runner.onboard = async () => { await step(); };")).toBe(true);
  });

  test("counted beside the timers", () => {
    expect(timerFindings("x.ts", 'a.on("x", () => {}); setTimeout(() => {}, 1);')).toMatchObject({ timers: 1, listeners: 1 });
  });
});

describe("where it looks", () => {
  test("what runs in the daemon or the CLI — not tests, and not a page a browser runs", () => {
    for (const rel of ["apps/engine/src/boot/maintenance.ts", "apps/engine/src/cli/commands/chat.ts", "packages/gateways/src/commons/resilience.ts", "internals/pro/appliance/src/core/onboard/maintenance.ts"]) {
      expect({ rel, daemon: isDaemonSource(rel) }).toEqual({ rel, daemon: true });
    }
    for (const rel of [
      "apps/engine/tests/pipeline/batcher.test.ts",
      "packages/shared/tests/contained.test.ts",
      "apps/engine/src/boot/nouride-appliance.d.ts",
      "apps/dashboard/src/main.tsx",
      "packages/ui-graph/src/index.ts",
      "internals/pro/appliance/src/ui/App.tsx",
    ]) {
      expect({ rel, daemon: isDaemonSource(rel) }).toEqual({ rel, daemon: false });
    }
  });

  test("a planted timer in a tree of its own is found and named, the Pro plugins' included", async () => {
    const root = mkdtempSync(join(tmpdir(), "nouride-check-timers-"));
    try {
      const plant = (rel: string, text: string) => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      };
      plant("apps/engine/src/boot/sweep.ts", "setInterval(() => store.sweep(), DAY);\n");
      plant("internals/pro/appliance/src/core/restart.ts", "setTimeout(() => options.restart(), 500);\n");
      plant("apps/engine/tests/sweep.test.ts", "setInterval(() => store.sweep(), DAY);\n");
      plant("internals/pro/appliance/src/ui/App.tsx", "setInterval(() => void refresh(), 5000);\n");
      const { findings } = await checkTimers(root);
      expect(findings.map((finding) => `${finding.file}:${finding.line}`).sort()).toEqual([
        "apps/engine/src/boot/sweep.ts:1",
        "internals/pro/appliance/src/core/restart.ts:1",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run that finds too few timers fails, rather than passing on a parser that stopped looking", () => {
    expect(floorFailure(MIN_TIMERS - 1)).toContain("the parser in this script is broken");
    expect(floorFailure(MIN_TIMERS)).toBeNull();
  });
});
