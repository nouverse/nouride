/**
 * `/helpers` and `/backgrounds`: what is at work for this agent in the background now.
 *
 * `/helpers` is who: the helpers it started (`delegate`) and the agents it asked (`ask_agent`) whose answers have not
 * come back. `/backgrounds` is what: the commands it left running (`exec` with `background`), a server among them.
 * A person had `/stop` to end the first and nothing to see either with: a helper that ran forty minutes was known
 * only by the agent's own word, or by the dashboard. Only what is running; what ended reported to the chat when it did.
 *
 * Two commands, apart on purpose: who works for the agent, and what it left running, are asked for separately.
 * `/helpers` came first and left commands out, as a job of another kind: told "run sleep 30 in the background", an
 * agent did, and `/helpers` said twice that nobody was working. So each says in one line when the other has
 * something, and "nothing here" is never the whole answer while something runs.
 *
 * A room sees what was started from that room. A direct chat sees what was started from it, and what the person
 * started elsewhere; an admin there sees all of the agent's. A brief or a command line can hold what another chat
 * said, so it is not shown to whoever happens to write to the agent.
 *
 * And the other way round: whom this agent is working for. An ask is a job of the agent that asked, so `/helpers` at
 * Nouva listed Nix while Nix answered her, and the same command at Nix said no helper was working: true, and read as
 * Nix doing nothing. `/helpers` now says which agents it is at work for and since when, and what each asked to
 * whoever may read the chat the ask came from.
 */

import { clipTrimmed, oneLine, plural } from "@nouride/shared";
import { formatDuration } from "../format.ts";
import type { Hook, HookContext } from "../types.ts";

/** One thing at work in the background, as these commands list it. Built by the pipeline from the jobs that run. */
export interface WorkingInBackground {
  id: string;
  /** A helper, an agent asked, or a command left running. */
  kind: "helper" | "ask" | "command";
  /** The agent asked, for an ask; null otherwise. */
  asked: string | null;
  /** A command started as a server, meant to run until stopped. */
  service: boolean;
  /** What it was given to do: a helper's goal, an ask's task, a command's own line. */
  what: string;
  gatewayId: string;
  chatId: string;
  /** The person whose turn started it. */
  senderId: string | null;
  startedAt: number;
  /** When its log was last written: a line at each step a helper or an asked agent makes, a command's output. Null before the first. */
  lastWroteAt: number | null;
}

/** A turn this agent runs for another agent that asked it (`ask_agent`). Built by the pipeline from its peer turns. */
export interface WorkingForAnother {
  /** The agent that asked. */
  by: string;
  task: string;
  /** The conversation the ask was made in, the asking agent's: where the peer turn runs pointed at. */
  gatewayId: string;
  chatId: string;
  /** The person whose turn asked. */
  senderId: string | null;
  startedAt: number;
}

/** Which of the two lists: the turns in the background, or the commands. */
type Which = "helpers" | "commands";

const SHOWN = 160;
/**
 * A helper's and an asked agent's log opens with what it was given, written as it starts: a write that close to the
 * start is that, and no step. Said as a step, one just started read "13s · last step 13s ago".
 */
const OPENING_MS = 2_000;

/** One line of whatever it was given, short enough to read on a phone. */
const brief = (text: string): string => clipTrimmed(oneLine(text), SHOWN);

const isCommand = (one: WorkingInBackground): boolean => one.kind === "command";

function seen(ctx: HookContext, one: Pick<WorkingInBackground, "gatewayId" | "chatId" | "senderId">): boolean {
  if (one.gatewayId === ctx.gatewayId && one.chatId === ctx.chatId) return true;
  if (ctx.envelope.chatType !== "dm") return false;
  return ctx.deps.isAdmin?.(ctx.envelope) === true || (one.gatewayId === ctx.gatewayId && one.senderId === ctx.senderId);
}

/**
 * One list, as the chat reads it (pure). `working` is everything the reader may see, of both kinds: the list shows its
 * own, and points at the other command where that one has something.
 *
 * An entry is three short lines with a blank one between entries: who or what and for how long, what it was given,
 * its job. One run-on line each was not read on a phone.
 */
export function backgroundSaid(input: {
  which: Which;
  agent: string;
  working: readonly WorkingInBackground[];
  here: (one: WorkingInBackground) => boolean;
  nameOf: (agentId: string) => string;
  now: number;
  /** Whom the agent is at work for, for `/helpers`: each ask with its task, or null where this reader is not shown it. */
  forOthers?: readonly { by: string; task: string | null; startedAt: number }[];
}): string {
  const { which, agent, now } = input;
  const ago = (at: number) => formatDuration(Math.max(0, Math.round((now - at) / 1000)));
  const asks = which === "helpers" ? (input.forOthers ?? []) : [];
  // Its own section, under the list: who works for the agent and whom the agent works for are two questions.
  const forOthers =
    asks.length === 0
      ? []
      : [
          `**${agent} is working for** (${asks.length})`,
          ...asks.map((ask, index) => {
            const who = `**${index + 1}. ${input.nameOf(ask.by)}** · ${ago(ask.startedAt)}`;
            return ask.task === null ? `${who} · asked from another chat` : `${who}\n${brief(ask.task)}`;
          }),
        ];
  const mine = input.working.filter((one) => isCommand(one) === (which === "commands")).sort((a, b) => a.startedAt - b.startedAt);
  const others = input.working.length - mine.length;
  // The other list has something: said, so "nothing here" is never read as nothing at all.
  const other =
    others === 0
      ? []
      : [which === "helpers" ? `${others} ${plural(others, "command")} ${others === 1 ? "runs" : "run"} in the background: /backgrounds` : `${others} ${plural(others, "helper")} at work: /helpers`];
  if (mine.length === 0) {
    const none = which === "helpers" ? `No helper is working for ${agent} now.` : `No command of ${agent}'s runs in the background now.`;
    return [none, ...forOthers, ...other].join("\n\n");
  }
  const entries = mine.map((one, index) => {
    const who = one.kind === "ask" && one.asked ? `**${index + 1}. ${input.nameOf(one.asked)}**, asked` : `**${index + 1}. ${isCommand(one) ? (one.service ? "A server" : "A command") : "A helper"}**`;
    // A command writes its log as it prints; a helper and an asked agent, a line at each step.
    const made = isCommand(one) ? "output" : "step";
    const wrote = one.lastWroteAt !== null && (isCommand(one) || one.lastWroteAt - one.startedAt > OPENING_MS);
    const last = wrote ? `last ${made} ${ago(one.lastWroteAt!)} ago` : `no ${made} yet`;
    const where = input.here(one) ? "" : " · started in another chat";
    // A command's own line is shown as code, with nothing in it that would end the code early.
    const what = isCommand(one) ? `\`${brief(one.what).replace(/`/g, "'")}\`` : brief(one.what);
    return [`${who} · ${ago(one.startedAt)} · ${last}${where}`, what, `\`${one.id}\``].join("\n");
  });
  const fromHere = mine.some(input.here);
  // `/stop` ends the turns in the background and no command: each list says what ends its own.
  const ends = which === "helpers" ? (fromHere ? ["/stop ends the ones started from this chat."] : []) : [`${agent} stops one when you ask, by its job.`];
  const title = which === "helpers" ? `**Helpers working for ${agent}** (${mine.length})` : `**Running in the background for ${agent}** (${mine.length})`;
  return [title, ...entries, ...ends, ...forOthers, ...other].join("\n\n");
}

function answer(which: Which) {
  return async (ctx: HookContext) => {
    const agentId = ctx.agent.config.id;
    const all = ctx.deps.workingInBackground?.(agentId);
    if (!all) return { handled: true, reply: "Background work is not run in this process." };
    return {
      handled: true,
      reply: backgroundSaid({
        which,
        agent: ctx.agent.config.displayName || agentId,
        working: all.filter((one) => seen(ctx, one)),
        here: (one) => one.gatewayId === ctx.gatewayId && one.chatId === ctx.chatId,
        nameOf: (id) => ctx.deps.registry.get(id)?.config.displayName || id,
        now: Date.now(),
        // What another agent asked can hold what its chat said: shown where that chat's own work would be.
        ...(which === "helpers" ? { forOthers: (ctx.deps.workingForOthers?.(agentId) ?? []).map((ask) => ({ by: ask.by, task: seen(ctx, ask) ? ask.task : null, startedAt: ask.startedAt })) } : {}),
      }),
    };
  };
}

export const helperHooks: Hook[] = [
  {
    command: "/helpers",
    description: "Who works for this agent in the background now, and which agents it is working for",
    worksWhilePaused: true,
    handler: answer("helpers"),
  },
  {
    command: "/backgrounds",
    description: "The commands this agent left running in the background",
    worksWhilePaused: true,
    handler: answer("commands"),
  },
];
