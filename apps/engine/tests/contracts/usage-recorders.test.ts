/**
 * Every model call reaches `llm_usage` saying what it was for (`purpose`) and why it ended (`stop_reason`) — the
 * contributing skill's invariant 16, held over the whole engine.
 *
 * A four-hour task on 2026-10-20/21 had to be debugged by inference: a compaction that failed silently, replies cut at
 * the output limit read off counts that stopped at 8192. Both facts existed at the call and were dropped on the way to
 * the record. Metering is one seam since 0.7.10 (`llm/metered.ts`): a caller asks for a meter with its purpose, and the
 * provider's own usage — which carries its stop reason since 0.7.26 — goes through `reportedCounts` into the row. So
 * the ways to lose either fact are the ways round the seam, and each is checked here, by reading every call site:
 *
 * - the store written by anything but the meter;
 * - a meter with no purpose, or one that is not a purpose;
 * - a provider metered by a callback that names none;
 * - an executor built without a meter, whose calls would reach no row at all;
 * - a usage written out by hand instead of passed on — the one way a stop reason the provider gave is dropped.
 *
 * Then the round trip itself, from a provider's usage to the row.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { EVENT_CONTRACT, type UsagePurpose } from "@nouride/shared";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";

const SRC = join(import.meta.dir, "../../src");
const SEAM = "modules/llm/metered.ts";
const BRAIN = "modules/pipeline/brain.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

interface Site {
  file: string;
  line: number;
  call: ts.CallExpression | ts.NewExpression;
  source: ts.SourceFile;
}

/** Every call and `new` in the engine's source, parsed — never matched by a regex that a line break would defeat. */
const SITES: Site[] = sources(SRC).flatMap((path) => {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      found.push({ file: relative(SRC, path), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, call: node, source });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
});

const where = (site: Site) => `${site.file}:${site.line}`;
/** The name a call is made by: `meter`, `record` of `deps.usage?.record`, `TurnExecutor` of `new TurnExecutor`. */
const calleeName = (site: Site): string => {
  const callee = site.call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
};
const receiver = (site: Site): string => {
  const callee = site.call.expression;
  return ts.isPropertyAccessExpression(callee) ? callee.expression.getText(site.source) : "";
};
const objectArg = (site: Site, index: number): ts.ObjectLiteralExpression | undefined => {
  const arg = site.call.arguments?.[index];
  return arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
};
const property = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined =>
  object.properties.find((element) => element.name !== undefined && ts.isIdentifier(element.name) && element.name.text === name);

const PURPOSES = new Set<string>(EVENT_CONTRACT.kinds.usage.purpose.values);

/**
 * The purposes whose calls are no generation, so carry no stop reason: their usage is written by hand, and the record
 * says nothing about why they ended rather than a guess. Every purpose is one or the other — a new one fails below
 * until somebody decides which.
 */
const NO_STOP_REASON: Partial<Record<UsagePurpose, string>> = {
  embedding: "vectors, not a reply — `metered()` writes the embedding's input count, the one number it has",
  transcription: "a clip billed by its length (`attachments/transcribe.ts`) — no tokens, no reply",
};
const GENERATIONS: readonly UsagePurpose[] = ["turn", "helper", "peer", "steer_reply", "compaction", "reflection", "memory", "vision", "second_look", "side_question"];

/** Where a usage is written by hand, and the purpose that makes that honest. Anywhere else, a hand-written one drops the reason. */
const HAND_WRITTEN: Record<string, UsagePurpose> = {
  [SEAM]: "embedding",
  "modules/attachments/transcribe.ts": "transcription",
};

describe("every model call is recorded through the one seam, with its purpose", () => {
  test("the usage store is written by the meter alone", () => {
    const writers = SITES.filter((site) => calleeName(site) === "record" && /\busage\b[?!]?$/.test(receiver(site)) && site.file !== SEAM).map(where);
    expect(writers).toEqual([]);
    // And the meter is where it is: a rule over a file that no longer writes holds nothing.
    expect(SITES.some((site) => site.file === SEAM && calleeName(site) === "record" && /usage[?!]?$/.test(receiver(site)))).toBe(true);
  });

  test("…whose only INSERT names both columns", () => {
    const inserts = sources(SRC).filter((path) => /INSERT INTO llm_usage/.test(readFileSync(path, "utf8")));
    expect(inserts.map((path) => relative(SRC, path))).toEqual(["modules/llm/usage.store.ts"]);
    const sql = /INSERT INTO llm_usage \(([^)]*)\)/.exec(readFileSync(inserts[0]!, "utf8"))?.[1] ?? "";
    expect(sql).toContain("purpose");
    expect(sql).toContain("stop_reason");
  });

  test("every meter names a purpose, and one the record knows", () => {
    const meters = SITES.filter((site) => calleeName(site) === "meter" && site.file !== SEAM);
    expect(meters.length).toBeGreaterThan(8);
    const wrong = meters.flatMap((site) => {
      const to = objectArg(site, 1);
      const purpose = to && property(to, "purpose");
      if (!purpose || !ts.isPropertyAssignment(purpose)) return [`${where(site)}: no purpose`];
      const value = purpose.initializer;
      return ts.isStringLiteral(value) && PURPOSES.has(value.text) ? [] : [`${where(site)}: ${value.getText(site.source)}`];
    });
    expect(wrong).toEqual([]);
  });

  test("a provider metered by a callback of its own says the purpose in it", () => {
    const wrapped = SITES.filter((site) => calleeName(site) === "metered" && site.file !== SEAM);
    expect(wrapped.length).toBeGreaterThan(4);
    const unnamed = wrapped.filter((site) => {
      const record = site.call.arguments?.[1];
      if (!record) return true;
      if (ts.isCallExpression(record) && ts.isIdentifier(record.expression) && record.expression.text === "meter") return false;
      return !/\bpurpose\b/.test(record.getText(site.source));
    });
    expect(unnamed.map(where)).toEqual([]);
  });

  test("every executor is built with a meter — one without would make calls that reach no row", () => {
    // A turn's brain is chosen by `brainFor` (0.8.1), whose third argument is the executor's deps; its own `new
    // TurnExecutor(deps)` builds with what its caller passed, so the caller is what is checked.
    const executors = SITES.filter(
      (site) => (ts.isNewExpression(site.call) && calleeName(site) === "TurnExecutor" && site.file !== BRAIN) || (ts.isCallExpression(site.call) && calleeName(site) === "brainFor"),
    );
    expect(executors.length).toBeGreaterThanOrEqual(4);
    const unmetered = executors.filter((site) => {
      const deps = objectArg(site, calleeName(site) === "brainFor" ? 2 : 0);
      const onUsage = deps && property(deps, "onUsage");
      return !onUsage || !/\b(meter|charge)\(/.test(onUsage.getText(site.source));
    });
    expect(unmetered.map(where)).toEqual([]);
  });
});

describe("…and why it ended", () => {
  test("every purpose is a generation, which carries its stop reason, or is said not to be — none left undecided", () => {
    expect([...GENERATIONS, ...Object.keys(NO_STOP_REASON)].sort()).toEqual([...PURPOSES].sort());
    expect(new Set(Object.values(HAND_WRITTEN))).toEqual(new Set(Object.keys(NO_STOP_REASON) as UsagePurpose[]));
  });

  test("a usage is passed on as the provider gave it, never written out by hand where a stop reason could be dropped", () => {
    // A usage handed to a meter, a recorder or an executor's `onUsage` as an object literal: it carries the provider's
    // own — and its stop reason — only by spreading it.
    const handWritten = SITES.filter((site) => ["record", "onUsage", "charge"].includes(calleeName(site)) || (ts.isCallExpression(site.call.expression) && calleeName({ ...site, call: site.call.expression }) === "meter"))
      .flatMap((site) => {
        const usage = objectArg(site, 0);
        if (!usage || !property(usage, "inputTokens")) return [];
        // `...delta`, `...usage`: the provider's whole usage passed on. A conditional spread of a flag is not one.
        const passedOn = usage.properties.some((element) => ts.isSpreadAssignment(element) && (ts.isIdentifier(element.expression) || ts.isPropertyAccessExpression(element.expression)));
        return passedOn ? [] : [site];
      });
    expect(handWritten.map((site) => site.file).sort()).toEqual(Object.keys(HAND_WRITTEN).sort());
  });

  test("…and the seam carries it into the row, chat and stream alike — with the purpose beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nouride-usage-recorders-"));
    const db = openDatabase(join(dir, "t.db"));
    try {
      await migrate(db);
      const provider = {
        kind: "openai",
        baseUrl: "https://fake.test/v1",
        chat: async () => ({ text: "x", toolCalls: [], stopReason: "tool_calls", usage: { inputTokens: 3, outputTokens: 8_192, stopReason: "max_tokens" }, model: "m" }),
        async *stream() {
          yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, stopReason: "stop" } };
          yield { type: "done", stopReason: "stop" };
        },
      } as never;
      const wrapped = metered(provider, meter(new UsageStore(db), { agentId: "nouva", provider: "default", purpose: "reflection" }));
      await wrapped.chat({ model: "m", messages: [] });
      for await (const _chunk of wrapped.stream({ model: "m", messages: [] })) void _chunk;
      expect(db.prepare<{ purpose: string; stop_reason: string }>("SELECT purpose, stop_reason FROM llm_usage ORDER BY timestamp, rowid").all()).toEqual([
        { purpose: "reflection", stop_reason: "max_tokens" },
        { purpose: "reflection", stop_reason: "stop" },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
