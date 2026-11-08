/**
 * The daemon's own small state that has to outlive the process, one row each in `daemon_state` (D15; in the database
 * since 0.8.18, D6). They were JSON files in the data directory, outside every snapshot and `nouride db restore`; the
 * first start that has the table moves them in (`boot/state-files.ts`).
 *
 * For what is too small for a table of its own and changes too rarely to matter: which agents are paused, when each alert
 * was last sent. Both lived in memory, so every restart reset them, and a nightly update is a restart: an agent somebody
 * had stopped started answering again the next morning, and an alert sent a minute before the update was sent again a
 * minute after it.
 *
 * Written whole, a row at a time, and read back the same. Reading never throws: a row that is missing is no state, and
 * one that cannot be read is said and treated the same. Writing never throws either: the change it records has already
 * been made in memory, and a full disk must not undo a `/stop`.
 */

import { createLogger } from "@nouride/shared";
import type { StateName, StateRows } from "@/commons/daemon-state.store.ts";
import type { NewestRead } from "@/modules/external-agents/newest.ts";

const log = createLogger("daemon");

class StateRow<T> {
  constructor(
    private readonly rows: StateRows,
    private readonly name: StateName,
    /** What it holds, for the log: "the paused agents". */
    private readonly what: string,
    /** The parsed JSON as `T`, or null when it is not one. */
    private readonly parse: (value: unknown) => T | null,
  ) {}

  load(): T | null {
    let text: string | null;
    try {
      text = this.rows.get(this.name);
    } catch (err) {
      log.warn(`${this.what} could not be read, starting without them`, { state: this.name, error: String(err) });
      return null;
    }
    if (text === null) return null;
    try {
      const value = this.parse(JSON.parse(text));
      if (value !== null) return value;
    } catch {
      // Falls through to the same line as a value that parsed into something else.
    }
    log.warn(`${this.what} could not be read, starting without them`, { state: this.name });
    return null;
  }

  save(value: T): void {
    try {
      this.rows.set(this.name, JSON.stringify(value));
    } catch (err) {
      log.warn(`${this.what} could not be saved: they hold until the process ends`, { state: this.name, error: String(err) });
    }
  }
}

/** The spend alerts said today (`llm/spend-alerts.ts`): a restart must not say them again. */
export function spendAlertsState(rows: StateRows): { load(): { day: number; steps: ("threshold" | "near")[] } | null; save(said: { day: number; steps: ("threshold" | "near")[] }): void } {
  const row = new StateRow<{ day: number; steps: ("threshold" | "near")[] }>(rows, "spend-alerts", "the spend alerts said today", (value) => {
    const { day, steps } = (value ?? {}) as { day?: unknown; steps?: unknown };
    if (typeof day !== "number" || !Array.isArray(steps)) return null;
    return { day, steps: steps.filter((step): step is "threshold" | "near" => step === "threshold" || step === "near") };
  });
  return { load: () => row.load(), save: (said) => row.save(said) };
}

/** Which agents are paused (`AgentRegistry`): `{ "paused": ["nouva"] }`. */
export function pausedAgentsState(rows: StateRows): { load(): string[]; save(ids: readonly string[]): void } {
  const row = new StateRow<{ paused: string[] }>(rows, "paused-agents", "the paused agents", (value) => {
    const paused = (value as { paused?: unknown } | null)?.paused;
    return Array.isArray(paused) ? { paused: paused.filter((id): id is string => typeof id === "string") } : null;
  });
  return { load: () => row.load()?.paused ?? [], save: (ids) => row.save({ paused: [...ids] }) };
}

/** A JSON object of strings, its other entries dropped: what four of the states below hold. */
function stringsOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * Each external agent's ACP session, by conversation (0.8.1, `external-agents/`): `{ "coder|telegram:nouva|555": "…" }`.
 * A CLI that reopens sessions takes the conversation up where it was after a restart, or after its idle stop.
 */
export function externalSessionsState(rows: StateRows): { load(): Record<string, string>; save(sessions: Record<string, string>): void } {
  const row = new StateRow<Record<string, string>>(rows, "external-sessions", "the external agents' sessions", stringsOf);
  return { load: () => row.load() ?? {}, save: (sessions) => row.save(sessions) };
}

/**
 * The fingerprint of the instructions each external agent's kept session opened on, by the same key (0.8.8,
 * `external-agents/instruction.ts`): a session whose instructions changed while the daemon was down — an upgrade's
 * harness text — is let go at its next turn rather than reopened.
 */
export function externalInstructionsState(rows: StateRows): { load(): Record<string, string>; save(instructions: Record<string, string>): void } {
  const row = new StateRow<Record<string, string>>(rows, "external-instructions", "what the external agents' sessions opened on", stringsOf);
  return { load: () => row.load() ?? {}, save: (instructions) => row.save(instructions) };
}

/**
 * The chats whose external agent's CLI was left running a command of its own, by session (0.8.6,
 * `external-agents/index.ts`): `{ "nix|s1": { agentId, gatewayId, chatId } }`. Written as it happens, so a crash leaves
 * it too; what is here at a start was stopped with the last process, and its chat is told.
 */
export function cliLeftRunningState(rows: StateRows): { load(): Record<string, { agentId: string; gatewayId: string; chatId: string }>; save(left: Record<string, { agentId: string; gatewayId: string; chatId: string }>): void } {
  type Chat = { agentId: string; gatewayId: string; chatId: string };
  const row = new StateRow<Record<string, Chat>>(rows, "cli-left-running", "the commands external agents' CLIs left running", (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const chat = (entry: unknown): entry is Chat => {
      const c = entry as Partial<Chat> | null;
      return !!c && typeof c.agentId === "string" && typeof c.gatewayId === "string" && typeof c.chatId === "string";
    };
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Chat] => chat(entry[1])));
  });
  return { load: () => row.load() ?? {}, save: (left) => row.save(left) };
}

/** The version of each external agent's CLI that last passed its check (0.8.1): a new one is checked before work. */
export function externalVersionsState(rows: StateRows): { load(): Record<string, string>; save(versions: Record<string, string>): void } {
  const row = new StateRow<Record<string, string>>(rows, "external-versions", "the external CLIs' checked versions", stringsOf);
  return { load: () => row.load() ?? {}, save: (versions) => row.save(versions) };
}

/** A model — or an effort — a coding CLI offers, as it names it and, where it gives one, as it calls it. */
export interface CliModel {
  value: string;
  name?: string;
  /** On the one its last session opened on: that model as lists name it, the CLI's own default where the pack sets none. */
  current?: string;
}

/**
 * The models each external agent's CLI offered when its last session opened, by agent id (0.8.1): the Brain tab suggests
 * them in its model field, and a restart, which stops every CLI, would otherwise leave nothing to suggest until a turn.
 */
export function externalModelsState(rows: StateRows): { load(): Record<string, CliModel[]>; save(models: Record<string, CliModel[]>): void } {
  return cliChoicesState(rows, "external-models", "the models the external CLIs offer");
}

/**
 * The efforts each external agent's CLI offered for the model its last session was on, by agent id (0.8.7): the Brain
 * tab shows them beside the model, and which one `[llm] effort` set.
 */
export function externalEffortsState(rows: StateRows): { load(): Record<string, CliModel[]>; save(efforts: Record<string, CliModel[]>): void } {
  return cliChoicesState(rows, "external-efforts", "the efforts the external CLIs offer");
}

/** The newest version of each coding CLI's package, as the npm registry said at its last read (0.8.24, `newest.ts`). */
export function cliNewestState(rows: StateRows): { load(): NewestRead | null; save(read: NewestRead): void } {
  const row = new StateRow<NewestRead>(rows, "cli-newest", "the newest coding CLI versions", (value) => {
    const { at, asked, versions } = (value ?? {}) as { at?: unknown; asked?: unknown; versions?: unknown };
    const strings = stringsOf(versions);
    if (typeof at !== "number" || !Array.isArray(asked) || !strings) return null;
    return { at, asked: asked.filter((name): name is string => typeof name === "string"), versions: strings };
  });
  return { load: () => row.load(), save: (read) => row.save(read) };
}

function cliChoicesState(rows: StateRows, name: StateName, what: string): { load(): Record<string, CliModel[]>; save(choices: Record<string, CliModel[]>): void } {
  const row = new StateRow<Record<string, CliModel[]>>(rows, name, what, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const choices = (list: unknown): CliModel[] => (Array.isArray(list) ? list : []).filter((entry): entry is CliModel => typeof entry?.value === "string").map(({ value, name, current }) => ({ value, ...(typeof name === "string" ? { name } : {}), ...(typeof current === "string" ? { current } : {}) }));
    return Object.fromEntries(Object.entries(value).map(([agentId, list]) => [agentId, choices(list)]));
  });
  return { load: () => row.load() ?? {}, save: (choices) => row.save(choices) };
}

/**
 * The coding-CLI accounts a person added, by CLI id (0.8.1): kept so an account shows on the Models page before any
 * agent uses it. An account a pack names is listed whether or not it is here; a shared one's token is in the secret store.
 */
export function cliAccountsState(rows: StateRows): { load(): Record<string, string[]>; save(accounts: Record<string, string[]>): void } {
  const row = new StateRow<Record<string, string[]>>(rows, "cli-accounts", "the coding-CLI accounts", (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).map(([cli, names]) => [cli, (Array.isArray(names) ? names : []).filter((name): name is string => typeof name === "string")]));
  });
  return { load: () => row.load() ?? {}, save: (accounts) => row.save(accounts) };
}

/** The day each person's morning line last came (0.8.0, `people/morning-line.ts`): a restart says none twice. */
export function morningLinesState(rows: StateRows): { load(): Record<string, string>; save(said: Record<string, string>): void } {
  const row = new StateRow<Record<string, string>>(rows, "morning-lines", "the morning lines said", stringsOf);
  return { load: () => row.load() ?? {}, save: (said) => row.save(said) };
}

/** A JSON object of numbers, its other entries dropped: when something was first seen, or last sent. */
function timesOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

/** When the daemon first saw each agent (0.8.1, `agents-seen.ts`): `{ "nouva": 1790000000000 }`. */
export function agentsSeenState(rows: StateRows): { load(): Record<string, number>; save(seen: Record<string, number>): void } {
  const row = new StateRow<Record<string, number>>(rows, "agents-seen", "when each agent was first seen", timesOf);
  return { load: () => row.load() ?? {}, save: (seen) => row.save(seen) };
}

/** When each alert was last sent (`Notifier`): `{ "gateway_dead:telegram:nouva": 1790000000000 }`. */
export function alertCooldownsState(rows: StateRows): { load(): Record<string, number>; save(at: Record<string, number>): void } {
  const row = new StateRow<Record<string, number>>(rows, "alert-cooldowns", "the alert cooldowns", timesOf);
  return { load: () => row.load() ?? {}, save: (at) => row.save(at) };
}
