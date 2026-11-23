/**
 * An automation a person has open on its page, for an agent to change in place (`modules/live-edit`).
 *
 * The page sends its draft as it would save it (`createBody` in the dashboard's `automations/lib/draft.ts`, with how
 * it starts and what it keeps between runs beside it). Two things are done with it here:
 *
 * - It is said to the turn in `schedule`'s own words (`openSaid`), so what the agent reads is what it writes back:
 *   `prompt` for a turn's message, `if_failed` for a path, a step's number for where a path leads. A draft is half a
 *   thought, so it is read leniently: a step with nothing written yet is said as it is, and nothing is refused.
 * - What the tool has no word for is carried from the open step onto the one the agent wrote in its place
 *   (`carried`): a turn's own model, where a command runs and for how long, a line of arguments that is not a shell
 *   line. Each step is said with its `id` and written back with it, so "in its place" is by that id and not a guess.
 *   Without this an agent that changed one word of step 4 would have dropped the model step 2 was set to.
 */

import type { JobDelivery, JobPayload, JobStep, LiveEdit, TogetherStep } from "@nouride/shared";

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An automation as its page holds it, read out of what the page sent. */
export interface OpenAutomation {
  name: string;
  agentId: string;
  start: "scheduled" | "manual" | "webhook";
  /** How it starts, as `schedule`'s `when` says it; null for a start not written yet. */
  when: string | null;
  tz?: string;
  /** Its steps as the page holds them: a list's own, or the one thing it does as a single step. */
  steps: Raw[];
  /** It does one thing and is not a list. */
  one: boolean;
  /** What a lone command's output is worth, where it is one. */
  then?: "deliver" | "agentTurn";
  target: { gatewayId: string; chatId: string };
  delivery: JobDelivery;
  session?: string;
  keepAfterRun?: boolean;
}

/** The page's value read as an automation; null where it is not an object at all. Nothing in it is checked. */
export function readOpen(value: unknown): OpenAutomation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Raw;
  const payload = record(body.payload);
  const one = payload.kind !== "steps";
  const steps = one ? (typeof payload.kind === "string" ? [payload] : []) : list(payload.steps).map(record);
  const start = body.start === "webhook" ? "webhook" : body.start === "manual" || body.manual === true ? "manual" : "scheduled";
  const target = record(body.target);
  const delivery = record(body.delivery);
  return {
    name: text(body.name),
    agentId: text(body.agentId),
    start,
    when: start === "scheduled" ? startWords(body) : start,
    ...(text(body.tz).trim() ? { tz: text(body.tz).trim() } : {}),
    steps,
    one,
    ...(one && payload.kind === "command" ? { then: payload.then === "agentTurn" ? ("agentTurn" as const) : ("deliver" as const) } : {}),
    target: { gatewayId: text(target.gatewayId), chatId: text(target.chatId) },
    delivery: { ...(delivery as Partial<JobDelivery>), mode: delivery.mode === "none" || delivery.mode === "webhook" ? delivery.mode : "announce" } as JobDelivery,
    ...(text(body.session) ? { session: text(body.session) } : {}),
    ...(body.keepAfterRun === true ? { keepAfterRun: true } : {}),
  };
}

/** A start on a clock as `when` says it: the page sends one of `every`, `cron` and `at`, as the daemon parses them. */
function startWords(body: Raw): string | null {
  for (const key of ["every", "cron", "at"] as const) if (text(body[key]).trim()) return `${key} ${text(body[key]).trim()}`;
  return null;
}

/** `when` with its spaces and its case evened out: two that say the same start read the same. */
export const sameStart = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** A command's line of arguments as one shell line: the line itself where it is `sh -lc <line>`, else each part quoted where it needs it. */
export function commandLine(argv: readonly string[]): string {
  if (argv.length === 3 && argv[0] === "sh" && argv[1] === "-lc") return argv[2]!;
  return argv.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A length of time as `for` takes it, in the largest unit that says it whole. */
function duration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** What a step or a part does, in the one field `schedule` has for it, with what goes with that field. */
function doesSaid(step: Raw): Raw {
  switch (step.kind) {
    case "systemEvent":
      return { text: text(step.text) };
    case "agentTurn":
      return { prompt: text(step.message), ...(text(step.agentId) ? { agent: text(step.agentId) } : {}) };
    case "command": {
      const argv = list(step.argv).map(String);
      const script = step.script && typeof step.script === "object" ? record(step.script) : null;
      if (!script) return { command: commandLine(argv) };
      const secrets = list(script.secrets).map(String).filter(Boolean);
      const run = argv.join(" ");
      return { script: text(script.text), ...(run && run !== "sh" ? { run } : {}), about: text(script.about), ...(secrets.length > 0 ? { secrets } : {}) };
    }
    case "mission": {
      const checks = list(step.checks).map(String).filter(Boolean);
      return {
        mission: text(step.goal),
        ...(checks.length > 0 ? { checks } : {}),
        ...(step.review === false ? { no_review: true } : text(step.review) ? { review: text(step.review) } : {}),
        ...(step.draft === true ? { draft: true } : {}),
        ...(text(step.agentId) ? { agent: text(step.agentId) } : {}),
      };
    }
    case "approval":
      return { ask: text(step.ask) };
    case "parallel":
      return { together: list(step.steps).map(record).map((part) => ({ ...(text(part.name) ? { name: text(part.name) } : {}), ...doesSaid(part) })) };
    default:
      return {};
  }
}

/** Where a path leads, as `schedule` takes it: `next`, `end`, or the number of the step it goes to. */
function goSaid(go: unknown, ids: readonly string[]): string | number | undefined {
  if (go === "next" || go === "end") return go;
  const to = text(record(go).to);
  const at = ids.indexOf(to);
  return to ? (at >= 0 ? at + 1 : to) : undefined;
}

/**
 * The automation as a call of `schedule` would write it: what the turn reads, and writes back whole with its change.
 * A step is said with its `id`, which the agent keeps on a step it keeps or changes and leaves off a new one.
 */
export function openSaid(open: OpenAutomation, who: { agentId: string }): Raw {
  const ids = open.steps.map((step) => text(step.id));
  const steps = open.steps.map((step) => {
    const [then, failed, empty] = [goSaid(step.then, ids), goSaid(step.whenFailed, ids), goSaid(step.whenEmpty, ids)];
    return {
      ...(text(step.id) ? { id: text(step.id) } : {}),
      ...(text(step.name) ? { name: text(step.name) } : {}),
      ...doesSaid(step),
      ...(then !== undefined ? { then } : {}),
      ...(failed !== undefined ? { if_failed: failed } : {}),
      ...(empty !== undefined ? { if_empty: empty } : {}),
      ...(step.onlyChanged === true ? { only_changed: true } : {}),
    };
  });
  return {
    name: open.name,
    ...(open.when ? { when: open.when } : {}),
    ...(open.tz && open.when && /^(cron|at) /.test(open.when) ? { tz: open.tz } : {}),
    ...(open.agentId && open.agentId !== who.agentId ? { agent: open.agentId } : {}),
    // One thing is written as that thing; a list as its steps, each with its id.
    ...(open.one ? (open.steps[0] ? doesSaid(open.steps[0]) : {}) : { steps }),
    ...(open.delivery.once ? { once: true } : {}),
    ...(typeof open.delivery.lasts === "number" ? { for: duration(open.delivery.lasts) } : {}),
  };
}

/** What `schedule` has no word for, by kind: carried from the open step to the one written in its place. */
function unsaid(from: Raw, to: Raw): Raw {
  if (from.kind !== to.kind) return {};
  switch (to.kind) {
    case "agentTurn":
      return text(from.model) ? { model: text(from.model) } : {};
    case "command": {
      const [was, now] = [list(from.argv).map(String), list(to.argv).map(String)];
      // A line that was not a shell line, written back as it was shown, is that line still and not `sh -lc` of it.
      const same = !from.script && !to.script && now.length === 3 && now[0] === "sh" && now[1] === "-lc" && now[2] === commandLine(was);
      return { ...(same ? { argv: was } : {}), ...(text(from.cwd) ? { cwd: text(from.cwd) } : {}), ...(typeof from.timeoutMs === "number" ? { timeoutMs: from.timeoutMs } : {}) };
    }
    case "approval":
      return typeof from.timeoutMs === "number" ? { timeoutMs: from.timeoutMs } : {};
    default:
      return {};
  }
}

/**
 * The payload an agent wrote for the open automation, with what the tool cannot say put back on each step that keeps
 * its id and its kind, and on each part of a step of several by its place. A job of one thing keeps what its one
 * thing had, a lone command's hand-over to its agent among it.
 */
export function carried(written: JobPayload, open: OpenAutomation): JobPayload {
  if (written.kind !== "steps") {
    const was = open.one ? open.steps[0] : undefined;
    if (!was) return written;
    const kept = unsaid(was, written as unknown as Raw);
    const then = written.kind === "command" && was.kind === "command" && open.then === "agentTurn" ? { then: "agentTurn" as const } : {};
    return { ...written, ...kept, ...then } as JobPayload;
  }
  const byId = new Map(open.steps.filter((step) => text(step.id)).map((step) => [text(step.id), step]));
  const steps = written.steps.map((step): JobStep => {
    const was = byId.get(step.id);
    if (!was) return step;
    const now = step as unknown as Raw;
    if (step.kind !== "parallel" || was.kind !== "parallel") return { ...step, ...unsaid(was, now) } as JobStep;
    const parts = list(was.steps).map(record);
    return { ...step, steps: step.steps.map((part, at): TogetherStep => (parts[at] ? ({ ...part, ...unsaid(parts[at], part as unknown as Raw) } as TogetherStep) : part)) };
  });
  return { kind: "steps", steps };
}

/** How a turn is told to change what is open, and what happens then: a sentence each, and each held by a test. */
const HOW =
  'To change it, call `schedule` with `replaces: "open"` and all of it as it should be: every step, changed or not, each one you keep with its `id` and a new one with none. ' +
  "Nothing is stored and nothing is turned on: the page draws your change over what they have, and they apply it there and save it when they are ready. " +
  "Say what you changed in one line. A change to this one is never a second automation proposed beside it.";

/** Automations, as a kind of thing a page holds open: what `LiveEdits` is handed for them at boot (its `LiveEditKind`). */
export const automationKind = {
  tool: "schedule",
  noun: "automation",
  said: (open: LiveEdit, who: { agentId: string }): Record<string, unknown> | null => {
    const read = readOpen(open.value);
    return read ? openSaid(read, who) : null;
  },
  how: HOW,
};
