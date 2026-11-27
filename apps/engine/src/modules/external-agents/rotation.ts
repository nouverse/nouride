/**
 * An agent moved to its next account when the one it is on reaches a limit.
 *
 * A turn failed on "You've reached your Fable limit" and the person moved the chat back by hand, with a second account
 * signed in beside the first. An agent with several accounts (`[external] profile` as a list) is now started on the
 * next one and the message sent again, once. Three things it stands on, each seen on a real CLI before this was built:
 *
 * - A session opened under one account's token is loaded under another's in the same folder, and the model still has
 *   what was said: the account is the token the CLI starts with, and the folder stays the first account's.
 * - A limit is known from the refusal's data (`CliRow.limit`), never from its sentence.
 * - It may be one model's alone: the same account went on answering on another model. So a mark is an account's for a
 *   model, and an agent moves only for a turn on that model.
 *
 * The limit is the account's and the move is the agent's: every agent on an account reads its marks, and each moves by
 * its own list, in its own folder. Nothing is switched for every agent at once.
 */

import { AcpError, type CliRow, type CliUse } from "@nouride/acp";
import { NourideError, type ExternalAgentConfig } from "@nouride/shared";
import { failedInPrompt } from "./connection.ts";
import type { AccountUse } from "./use.ts";

/** An account at a limit for a model, or near one: until when, and whether the CLI said so. */
export interface LimitMark {
  until: number;
  /** The CLI named the end. Where it did not, `until` is when the account is tried again. */
  known: boolean;
  /**
   * Near a limit, not at it: the share of that limit used when its CLI last said, from 0 to 1. Absent: a message was
   * refused. Kept under `ANY_MODEL`, and read only by an agent that asked to move on early (`move_at`).
   */
  near?: number;
  /** Marked from the account's use as its maker said it, not a refusal: a later word that it has room lifts it. */
  read?: true;
}

/** The model a mark of nearness is kept under: the limit it is near is the account's, whatever model runs. */
const ANY_MODEL = "*";

/**
 * The model a mark of a window used up is kept under, read as every model's: a limit of the account's own, its use
 * read before any message was refused (`seen`).
 */
const EVERY_MODEL = "**";

/**
 * How long a limit that named no end is held: an hour. Trying again costs one refused message and the CLI started
 * again, a few seconds; holding longer leaves the first account unused after its limit has turned. A choice of this
 * code, not something the CLI said, and the words about such a mark say it is tried again, not that it ends then.
 */
export const UNSAID_END_MS = 60 * 60_000;

/**
 * The model a turn runs on where nothing names one: the CLI's own. A turn always has a model, this one at least; a call
 * with none is not a turn (a check of the CLI), and is never moved.
 */
export const OWN_MODEL = "default";

/**
 * The code of a turn not started because every account of the agent is at its limit for the turn's model. Its own, so
 * it is told from a CLI that cannot answer: the agent answers on another model, and is not marked as unable to.
 */
export const ACCOUNTS_SPENT = "external_accounts_spent";

type Kept = Record<string, LimitMark>;
export interface LimitsFile {
  load(): Kept;
  save(marks: Kept): void;
}

/** The accounts an agent has, in the order it moves through them: its list, else its one profile. */
export function accountsOf(external: ExternalAgentConfig): string[] {
  return external.accounts ?? [external.profile ?? "default"];
}

/** A value at a dotted path of a refusal's data, where every step is there. */
function at(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), data);
}

/**
 * A refusal that is a limit of the account, as the row says its connector marks one, with when it ends; null for any
 * other failure, and for a CLI whose row says nothing of limits. Only of a message the CLI had taken: a start that
 * fails is not a limit, whatever its data.
 */
export function limitOf(row: CliRow, error: unknown, now: number): LimitMark | null {
  if (!row.limit || !failedInPrompt(error) || !(error instanceof AcpError)) return null;
  if (at(error.data, row.limit.key) !== row.limit.value) return null;
  const seconds = row.limit.resets ? at(error.data, row.limit.resets) : undefined;
  const until = typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : 0;
  return until > now ? { until, known: true } : { until: now + UNSAID_END_MS, known: false };
}

/** About how long from now, in the largest unit that fits: an estimate, said as one. */
function about(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

const forModel = (model: string) => (model === OWN_MODEL || model === EVERY_MODEL ? "" : ` for \`${model}\``);
const percent = (mark: LimitMark) => `${Math.round((mark.near ?? 1) * 100)}%`;
const ends = (mark: LimitMark, now: number) => (mark.known ? `for ${about(mark.until - now)} more` : "it did not say until when");

export interface RotationDeps {
  /** Where marks are kept across a restart. Absent: in this process alone. */
  file?: LimitsFile;
  /** Whether an account can be started on: its token is kept. */
  usable: (row: CliRow, account: string) => boolean;
  now?: () => number;
  /** Each mark and each move, for the audit log. */
  record?: (action: "cli_account_limited" | "cli_account_moved" | "cli_account_near" | "cli_account_room", details: Record<string, unknown>) => void;
}

export class AccountRotation {
  private kept: Kept;
  /** The account each agent's CLI was last started on. */
  private readonly on = new Map<string, string>();

  constructor(private readonly deps: RotationDeps) {
    this.kept = deps.file?.load() ?? {};
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The mark on an account for a model, where it still holds: its own, else a window of the account's used up, which
   * holds for every model. One whose time has come is dropped.
   */
  limited(cli: string, account: string, model: string): LimitMark | null {
    return this.held(`${cli}|${account}|${model}`) ?? (model === ANY_MODEL ? null : this.held(`${cli}|${account}|${EVERY_MODEL}`));
  }

  private held(key: string): LimitMark | null {
    const mark = this.kept[key];
    if (!mark) return null;
    if (mark.until > this.now()) return mark;
    const { [key]: _over, ...rest } = this.kept;
    this.kept = rest;
    this.deps.file?.save(rest);
    return null;
  }

  /** Every mark an account holds now, by model, for where accounts are listed. */
  limitsOf(cli: string, account: string): ({ model: string } & LimitMark)[] {
    const prefix = `${cli}|${account}|`;
    return Object.keys(this.kept).flatMap((key) => {
      const model = key.startsWith(prefix) ? key.slice(prefix.length) : null;
      const mark = model === null ? null : this.held(key);
      return mark && model !== null ? [{ model, ...mark }] : [];
    });
  }

  /** An account's marks in words, a sentence a model, for where accounts are listed to a person. */
  says(cli: string, account: string): string[] {
    const now = this.now();
    return this.limitsOf(cli, account).map((mark) =>
      mark.near !== undefined
        ? `Near a limit, ${percent(mark)} of it used: it starts again in ${about(mark.until - now)}.`
        : `At its limit${forModel(mark.model)}: ${mark.known ? `for ${about(mark.until - now)} more` : "it did not say until when, and it is tried again within the hour"}.`,
    );
  }

  /**
   * When a turn on `model` refused for its accounts' limits can go on: the first of their ends, where every account is
   * at a limit that said its end. Null where one is not at a limit, or its limit did not say: nothing to wait for.
   */
  freeAt(cli: string, accounts: readonly string[], model: string): number | null {
    const marks = accounts.map((account) => this.limited(cli, account, model));
    return marks.length > 0 && marks.every((mark) => mark?.known) ? Math.min(...marks.map((mark) => mark!.until)) : null;
  }

  /** The account the agent's CLI was last started on; none before its first start. */
  accountOf(agentId: string): string | undefined {
    return this.on.get(agentId);
  }

  started(agentId: string, account: string): void {
    this.on.set(agentId, account);
  }

  /**
   * The account an agent's CLI starts on, or goes on with, for a turn on `model`: the one it is on while that is not at
   * a limit for the model, else the first of its list that is not and can be started. With no model named (a check, not
   * a turn) it stays where it is. Every account at a limit is said as that, before a message is sent to be refused.
   */
  accountFor(row: CliRow, agent: { id: string; name: string; external: ExternalAgentConfig }, model: string | undefined): string {
    const accounts = accountsOf(agent.external);
    const current = this.on.get(agent.id);
    const here = current && accounts.includes(current) ? current : undefined;
    if (accounts.length < 2 || model === undefined) return here ?? accounts[0]!;
    const next = this.pick(row, agent, model);
    if (next) return next.account;
    throw this.spent(row, agent.name, accounts, model, " Nothing was sent.");
  }

  /** The mark that an account is near a limit, where it holds and is at or past the agent's own (`move_at`). */
  private near(cli: string, account: string, moveAt: number | undefined): LimitMark | null {
    const mark = moveAt === undefined ? null : this.limited(cli, account, ANY_MODEL);
    return mark && (mark.near ?? 1) * 100 >= moveAt! ? mark : null;
  }

  /**
   * The account a turn on `model` goes on with: the one it is on while that is neither at a limit for the model nor,
   * for an agent that asked to move early, near one; else the first of its list that is neither. With none such, it
   * stays where it is until the limit itself, and only then takes one that is merely near. `left`: the account it
   * leaves for being near a limit, with that mark. Null: every account is at its limit.
   */
  private pick(row: CliRow, agent: { id: string; external: ExternalAgentConfig }, model: string): { account: string; left?: { account: string; mark: LimitMark } } | null {
    const accounts = accountsOf(agent.external);
    const current = this.on.get(agent.id);
    const here = current && accounts.includes(current) && !this.limited(row.id, current, model) ? current : undefined;
    const nearHere = here ? this.near(row.id, here, agent.external.moveAt) : null;
    if (here && !nearHere) return { account: here };
    const open = accounts.filter((account) => this.deps.usable(row, account) && !this.limited(row.id, account, model));
    const free = open.find((account) => !this.near(row.id, account, agent.external.moveAt));
    if (free) return { account: free, ...(here && nearHere ? { left: { account: here, mark: nearHere } } : {}) };
    const stay = here ?? open[0];
    return stay ? { account: stay } : null;
  }

  /**
   * What the chat is told where the agent's turn on `model` starts on another account because the one it is on is near
   * a limit: said before the turn, which then starts there (`accountFor`). Null where it stays.
   */
  early(row: CliRow, agent: { id: string; name: string; external: ExternalAgentConfig }, model: string): string | null {
    const next = accountsOf(agent.external).length < 2 ? null : this.pick(row, agent, model);
    if (!next?.left) return null;
    this.deps.record?.("cli_account_moved", { cli: row.id, agent: agent.id, from: next.left.account, to: next.account, model, early: true });
    return `Account ${next.left.account} has used ${percent(next.left.mark)} of a limit that starts again in ${about(next.left.mark.until - this.now())}. ${agent.name} goes on with ${next.account}.`;
  }

  /**
   * A turn ended, with the account's use as its CLI last said it. At or past the agent's own mark (`move_at`), the
   * account is marked as near that limit until it starts again, and the agent's next turn starts on its next account.
   * Only for an agent with another account that asked for it: nothing moves early that was not told to.
   */
  used(row: CliRow, agent: { id: string; external: ExternalAgentConfig }, use: AccountUse | null): void {
    const moveAt = agent.external.moveAt;
    const accounts = accountsOf(agent.external);
    if (moveAt === undefined || accounts.length < 2 || !use || use.until <= this.now() || use.used * 100 < moveAt) return;
    const account = this.on.get(agent.id) ?? accounts[0]!;
    const key = `${row.id}|${account}|${ANY_MODEL}`;
    const seen = this.kept[key]?.until === use.until;
    this.kept = { ...this.kept, [key]: { until: use.until, known: true, near: use.used } };
    this.deps.file?.save(this.kept);
    if (!seen) this.deps.record?.("cli_account_near", { cli: row.id, account, used: use.used, until: use.until, agent: agent.id });
  }

  /**
   * A shared account's use as last read or said. Only where its maker says no credits are left beyond its limits: a
   * window used up marks the account at its limit until it starts again, for every agent on it; a model's own window,
   * that model alone (by the name the maker gives it, which a turn on another id never meets). With credits left, or
   * none said, nothing is marked: such an account answered before, and still does. And a mark made so is lifted by a
   * later word that its window has room: credits left, a share below the end, an end already past.
   */
  seen(row: CliRow, account: string, use: CliUse | null): void {
    if (!use) return;
    const now = this.now();
    const full = new Map<string, number>();
    const said = new Set<string>();
    for (const limit of use.limits) {
      const models = limit.models?.length ? limit.models : [EVERY_MODEL];
      for (const window of limit.windows) {
        for (const model of models) {
          said.add(model);
          if (window.usedPercent >= 100 && window.resetsAt !== null && window.resetsAt > now) full.set(model, Math.max(full.get(model) ?? 0, window.resetsAt));
        }
      }
    }
    const prefix = `${row.id}|${account}|`;
    let kept = this.kept;
    for (const [key, mark] of Object.entries(kept)) {
      const model = key.startsWith(prefix) ? key.slice(prefix.length) : null;
      if (model === null || !mark.read) continue;
      if (use.creditsLeft === true || (said.has(model) && !full.has(model))) {
        const { [key]: _lifted, ...rest } = kept;
        kept = rest;
        this.deps.record?.("cli_account_room", { cli: row.id, account, model });
      }
    }
    if (use.creditsLeft === false) {
      for (const [model, until] of full) {
        if (kept[`${prefix}${model}`]?.until === until) continue;
        kept = { ...kept, [`${prefix}${model}`]: { until, known: true, read: true } };
        this.deps.record?.("cli_account_limited", { cli: row.id, account, model, until, known: true, read: true });
      }
    }
    if (kept !== this.kept) {
      this.kept = kept;
      this.deps.file?.save(kept);
    }
  }

  /**
   * A message the agent's CLI refused. Where the refusal is a limit, the account it was on is marked for the model, for
   * every agent on it; and where the agent has another account to go on with, what the chat is told of the move. Null
   * for any other failure, and for an agent with the one account, whose failure says what it said. Every account spent
   * is thrown as that.
   */
  refused(row: CliRow, agent: { id: string; name: string; external: ExternalAgentConfig }, error: unknown, model: string): string | null {
    const cause = error instanceof NourideError && error.cause !== undefined ? error.cause : error;
    const limit = limitOf(row, cause, this.now());
    if (!limit) return null;
    const accounts = accountsOf(agent.external);
    const from = this.on.get(agent.id) ?? accounts[0]!;
    const key = model;
    this.kept = { ...this.kept, [`${row.id}|${from}|${key}`]: limit };
    this.deps.file?.save(this.kept);
    this.deps.record?.("cli_account_limited", { cli: row.id, account: from, model: key, until: limit.until, known: limit.known, agent: agent.id });
    if (accounts.length < 2) return null;
    const to = this.pick(row, agent, key)?.account;
    if (!to) throw this.spent(row, agent.name, accounts, key, "");
    this.deps.record?.("cli_account_moved", { cli: row.id, agent: agent.id, from, to, model: key });
    return `Account ${from} reached its limit${forModel(key)}: ${ends(limit, this.now())}. ${agent.name} goes on with ${to}.`;
  }

  /**
   * Every account of the agent at its limit for the model, or not signed in: said with each, and when it ends. `after`:
   * what else is so, where the turn was not started at all.
   */
  private spent(row: CliRow, name: string, accounts: readonly string[], model: string, after: string): NourideError {
    const each = accounts.map((account) => {
      const mark = this.limited(row.id, account, model);
      return `${account} (${mark ? ends(mark, this.now()) : "not signed in"})`;
    });
    const words = `Every account of ${name} is at its limit${forModel(model)}: ${each.join(", ")}.${after}`;
    return new NourideError(ACCOUNTS_SPENT, words, words);
  }
}
