/**
 * The event stream's contract, held in place (`docs/EVENTS.md`; `EVENT_CONTRACT` in `@nouride/shared`).
 *
 * Its readers are not upgraded with the daemon — a dashboard tab left open, a CLI pointed at another box, an editor —
 * so a row that changes shape breaks them without a word. Each check below is a way a change would otherwise slip by:
 *
 * - the lock file is the contract as it stands, so changing what a row carries is a diff somebody reviews;
 * - within 1.x the lock only adds to the frozen 1.0 baseline, and a version above it has a changelog line;
 * - what the daemon's writers write is what the contract says — a turn through the real pipeline, and each writer
 *   such a turn does not reach, writing the way it does;
 * - the dashboard, `docs/EVENTS.md` and `nouride events` know every kind.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "@nouride/runtime";
import { EVENT_CONTRACT, EVENT_KINDS, EVENT_PROTOCOL_VERSION, eventProblems, type EventField, type Tool } from "@nouride/shared";
import { eventLine } from "@/cli/commands/events.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import type { EventRow } from "@/modules/events/events.store.ts";
import { compactionEnded, compactionStarted } from "@/modules/llm/compaction-steps.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { audited } from "@/modules/tools/audited.ts";
import { UpdateReader } from "@/modules/external-agents/updates.ts";
import { contractJson, LOCK_PATH } from "../../../../scripts/events-contract.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
type Contract = { version: string; kinds: Record<string, Record<string, EventField>> };
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const BASELINE = JSON.parse(read("docs/contracts/events.v1.json")) as Contract;
const CURRENT = EVENT_CONTRACT as unknown as Contract;

/** What a reader of `baseline` would find broken in `current`: anything but an addition. */
function breaks(baseline: Contract, current: Contract): string[] {
  const problems: string[] = [];
  for (const [kind, fields] of Object.entries(baseline.kinds)) {
    const now = current.kinds[kind];
    if (!now) {
      problems.push(`${kind} was removed`);
      continue;
    }
    for (const [key, field] of Object.entries(fields)) {
      const after = now[key];
      if (!after) problems.push(`${kind}.${key} was removed`);
      else {
        if (after.type !== field.type || after.items !== field.items) problems.push(`${kind}.${key} changed type`);
        if (!field.optional && after.optional) problems.push(`${kind}.${key} became optional`);
        if (field.identity && !after.identity) problems.push(`${kind}.${key} is no longer an identity key`);
        if (!field.values && after.values) problems.push(`${kind}.${key} was narrowed to a list of values`);
        for (const value of field.values ?? []) if (!after.values?.includes(value)) problems.push(`${kind}.${key} lost "${value}"`);
      }
    }
    for (const [key, field] of Object.entries(now)) if (!(key in fields) && !field.optional) problems.push(`${kind}.${key} is new and not optional`);
  }
  return problems;
}

describe("the contract, as a file", () => {
  test("the lock is the contract as it stands — a change to what a row carries is a reviewed diff", () => {
    const current = readFileSync(LOCK_PATH, "utf8") === contractJson();
    if (!current) console.error("EVENT_CONTRACT changed: run `bun run scripts/events-contract.ts --write`, bump EVENT_PROTOCOL_VERSION's minor, and add a line to docs/contracts/EVENTS_CHANGELOG.md");
    expect(current).toBe(true);
  });

  test("within 1.x it only adds to the frozen 1.0 baseline", () => {
    expect(BASELINE.version).toBe("1.0");
    expect(breaks(BASELINE, CURRENT)).toEqual([]);
  });

  test("…and that check catches what it is for", () => {
    const changed = (edit: (kinds: Contract["kinds"]) => void): Contract => {
      const copy = structuredClone(BASELINE);
      edit(copy.kinds);
      return copy;
    };
    expect(breaks(BASELINE, changed((k) => delete k.tool!.callId))).toEqual(["tool.callId was removed"]);
    expect(breaks(BASELINE, changed((k) => void (k.reply!.from = { type: "string", identity: true })))).toEqual(["reply.from changed type"]);
    expect(breaks(BASELINE, changed((k) => void (k.tool!.text = { type: "string", optional: true })))).toEqual(["tool.text became optional"]);
    expect(breaks(BASELINE, changed((k) => void (k.compact!.phase = { type: "string", identity: true, values: ["start", "done"] })))).toEqual(['compact.phase lost "failed"', 'compact.phase lost "trimmed"', 'compact.phase lost "pruned"']);
    expect(breaks(BASELINE, changed((k) => void (k.tool!.ms = { type: "number" })))).toEqual(["tool.ms is new and not optional"]);
    // What 1.x may do: a new optional key, a new kind, a new value.
    expect(breaks(BASELINE, changed((k) => void (k.tool!.ms = { type: "number", optional: true })))).toEqual([]);
    expect(breaks(BASELINE, changed((k) => void (k.signal = { text: { type: "string" } })))).toEqual([]);
  });

  test("its version is the protocol's, any change from the baseline raises it, and the changelog says what for", () => {
    expect(CURRENT.version).toBe(EVENT_PROTOCOL_VERSION);
    const [major, minor] = EVENT_PROTOCOL_VERSION.split(".").map(Number);
    expect(major).toBe(1);
    if (contractJson(CURRENT) !== contractJson(BASELINE)) expect(minor).toBeGreaterThan(0);
    expect(read("docs/contracts/EVENTS_CHANGELOG.md")).toContain(`\n## ${EVENT_PROTOCOL_VERSION} — `);
  });
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

/**
 * Rows of every kind, from the daemon's own writers: a turn through the real pipeline — asked again after a 429, a
 * tool call audited, an answer, its usage — then each writer a turn here does not reach, as it writes: the executor's
 * reasoning, steering's two lines, an approval's wait, compaction's helpers and the provider's two other retries, a
 * take-back, the step cap, and a command's answer.
 */
async function writtenRows(): Promise<{ rows: EventRow[]; db: SqliteDb }> {
  let calls = 0;
  const bench = await pipelineBench({
    turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "probed." }],
    fetch: (scripted) =>
      (async (...args: Parameters<typeof fetch>) => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error: { message: "rate limit reached" } }), { status: 429, headers: { "content-type": "application/json" } });
        return scripted(...args);
      }) as unknown as typeof fetch,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
    deps: ({ db, events }) => ({ usage: new UsageStore(db, Date.now, events) }),
  });
  cleanup.push(bench.dispose);
  const { pipeline, gateway, db, events, turns } = bench;
  const probe: Tool = {
    requiresApproval: false,
    definition: { name: "probe", description: "checks a thing", parameters: { type: "object", properties: {} } },
    execute: async () => ({ content: "probe ok", isError: false }),
  };
  pipeline.setTools(new Map([["probe", audited("probe", probe, new AuditLog(db))]]));
  pipeline.attach();
  gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "probe it", timestamp: Date.now() }));
  await pipeline.idle();

  const where = { sessionId: "ses_contract", agentId: "nouva", gatewayId: "web:dashboard", chatId: "web-1" };
  const id = turns.begin({ ...where, prompt: "the rest" });
  turns.step(id, "reasoning", "thinking it through");
  const steer = turns.step(id, "steer", "also check lint");
  turns.step(id, "steer_reply", "↪ Got it");
  // A person's edit read as the turn worked, and a turn answering one (1.3).
  turns.step(id, "steer", "✎ also check the types", { editOf: "m1" });
  turns.finish(turns.begin({ ...where, prompt: "check the types", messageId: "m1:edited:1", cause: { via: "edit", of: "m1" } }), { status: "done", reply: "ok" });
  turns.step(id, "waiting", "waiting for approval: exec", { callId: "call_9", name: "exec", approvalId: "apr_9" });
  turns.unstep(id, [steer]);
  const say = (text: string, detail: Record<string, unknown>) => void turns.step(id, "compact", text, detail);
  compactionStarted(say, 3, 1_200);
  compactionEnded(say, { messages: [], compacted: true, summarizedTurns: 3, prunedToolResults: 1, archivedParts: 0 }, "dropping the oldest turns instead");
  compactionEnded(say, { messages: [], compacted: false, summarizedTurns: 0, prunedToolResults: 0, archivedParts: 0, failed: true }, "dropping the oldest turns instead");
  // `prepare.ts` and the executor's room-making, and the provider caller's two retries that are not a provider's.
  turns.step(id, "compact", "context full — left out 2 earlier message(s)", { phase: "trimmed", dropped: 2 });
  turns.step(id, "compact", "context full — cleared 3 earlier tool result(s) to make room", { phase: "pruned", pruned: 3 });
  turns.step(id, "retry", "the model's context overflowed — retrying without 4 earlier message(s)", { reason: "context_overflow", dropped: 4 });
  turns.step(id, "retry", "the model refused the voice note — answering without it", { reason: "audio_refused" });
  turns.finish(id, { status: "done", reply: "done" });
  const capped = turns.begin({ ...where, prompt: "a runaway" });
  for (let i = 0; i <= 500; i += 1) turns.step(capped, "note", `note ${i}`);
  turns.note({ ...where, prompt: "/status", reply: "all good" });
  return { rows: events.list({ limit: 1_000 }), db };
}

describe("a coding CLI's step, as its reader writes it (1.6)", () => {
  test("carries `like`, which the contract describes — every one logged \"tool.like is not in the contract\" on the box", () => {
    const rows: { kind: string; data: Record<string, unknown> }[] = [];
    const reader = new UpdateReader({ text: () => {}, activity: (kind, text, detail) => void rows.push({ kind, data: { step: rows.length + 1, text, ...detail } }), plan: () => {}, preamble: async () => false });
    reader.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "git status", kind: "execute", name: "Bash", status: "in_progress", rawInput: { command: "git status" } });
    reader.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(rows.find((row) => row.kind === "tool")?.data.like).toBe("exec");
    for (const row of rows) expect(eventProblems(row.kind, row.data)).toEqual([]);
  });
});

describe("what the daemon writes", () => {
  test("every kind, as its writers write it, is what the contract says", async () => {
    const { rows } = await writtenRows();
    const problems = rows.flatMap((row) => eventProblems(row.kind, row.data).map((problem) => `#${row.seq} ${problem}`));
    expect(problems).toEqual([]);
    expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(EVENT_KINDS));
    // The ones a real turn wrote, not a stand-in: asked again after the 429, and the call its three rows pair by.
    expect(rows.find((row) => row.kind === "retry" && row.data.reason === "provider")?.data).toMatchObject({ failure: "rate_limit", status: 429, attempt: 2 });
    const call = rows.filter((row) => row.kind === "tool" || row.kind === "audit" || row.kind === "tool_done").map((row) => [row.kind, row.data.callId]);
    expect(call).toEqual([["tool", "c1"], ["audit", "c1"], ["tool_done", "c1"]]);
    // How it ended, said for a reader to decide on — not left in the line's words (1.1).
    expect(rows.find((row) => row.kind === "tool_done")?.data.outcome).toBe("ok");
    // Every row of that turn says its conversation — its metered calls too, which a chat's follower would miss.
    const turn = rows.find((row) => row.kind === "tool")!.turnId;
    const where = new Set(rows.filter((row) => row.turnId === turn).map((row) => `${row.gatewayId}/${row.chatId}`));
    expect(where).toEqual(new Set([`${rows.find((row) => row.kind === "tool")!.gatewayId}/chat-1`]));
    expect(rows.some((row) => row.kind === "note" && row.data.capped === true)).toBe(true);
  });

  test("…and the check refuses a row that is not", () => {
    expect(eventProblems("tool", { step: 1, text: "exec ls" })).toEqual(["tool.callId is missing", "tool.name is missing"]);
    expect(eventProblems("retry", { step: 1, text: "", reason: "tired" })).toEqual(['retry.reason is "tired", not one of provider, context_overflow, audio_refused, fallback']);
    expect(eventProblems("reply", { from: "0", text: "x" })).toEqual(["reply.from is string, not number"]);
    expect(eventProblems("note", { step: 1, text: "", extra: true })).toEqual(["note.extra is not in the contract"]);
    expect(eventProblems("signal", {})).toEqual(['"signal" is not a kind']);
  });
});

describe("its readers", () => {
  test("the dashboard's step kinds are the contract's own type, through @nouride/wire — not a list written again", () => {
    const wire = read("packages/wire/src/chat.ts");
    expect(/export interface TurnStep \{[^}]*?\n\s+kind: ([^;]+);/s.exec(wire)?.[1]).toBe("TurnStepKind");
    expect(wire).toMatch(/^import type \{[^}]*\bTurnStepKind\b[^}]*\} from "@nouride\/shared";$/m);
  });

  test("docs/EVENTS.md lists every kind, with exactly its keys and which are optional", () => {
    const doc = read("docs/EVENTS.md");
    const table = doc.slice(doc.indexOf("## The kinds"), doc.indexOf("## What a reader can rely on"));
    const listed = Object.fromEntries(
      table
        .split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => {
          const [, kind, , keys] = line.split("|");
          return [/`([a-z_]+)`/.exec(kind!)![1]!, [...keys!.matchAll(/`([A-Za-z]+\??)`/g)].map((match) => match[1]!).sort()];
        }),
    );
    const contract = Object.fromEntries(
      Object.entries(CURRENT.kinds).map(([kind, fields]) => [kind, Object.entries(fields).map(([key, field]) => (field.optional ? `${key}?` : key)).sort()]),
    );
    expect(listed).toEqual(contract);
  });

  test("`nouride events` says something about a row of every kind — a new kind with no `text` would print blank", async () => {
    const { rows } = await writtenRows();
    for (const kind of EVENT_KINDS) {
      const row = rows.find((candidate) => candidate.kind === kind)!;
      // `#seq time kind turn agent summary`
      const [, printed, summary] = /^#\d+ [\d:]+ (\S+) +\S+ \S* (.*)$/.exec(eventLine(row).replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
      expect({ kind: printed, said: Boolean(summary?.trim()) }).toEqual({ kind, said: true });
    }
  });
});
