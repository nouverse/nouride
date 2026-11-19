/**
 * `/mission` — a person's side of missions in the chat. `/mission <goal>` asks the agent addressed to draft one from
 * that goal, since every mission an agent starts is a draft first: a turn of its own that reads what it needs, writes
 * the brief and checks, or asks in the chat first when the goal is unclear; `/mission` lists what is running and waiting here, *needs you* first;
 * `/mission stop|pause|continue|accept <id>` and `/mission answer <id> <text>` act on one; `/mission tell <id> <words>` (0.8.10)
 * gives it words while it works. Most missions are started by the agent without a command — this is the explicit way, and
 * the way back in.
 */

import { clip } from "@nouride/shared";
import type { Missions } from "@/modules/missions/missions.ts";
import { doneWhen, shortId } from "@/modules/missions/page.ts";
import { isFinal, seenAs, type Mission } from "@/modules/missions/types.ts";
import type { Hook, HookContext } from "../types.ts";

/** What `/mission` reaches of the missions. */
export type MissionCommands = Pick<Missions, "start" | "stop" | "pause" | "continueMission" | "answer" | "accept" | "acceptOutside" | "tell" | "find" | "forChat" | "now" | "limitsLine" | "forStatus" | "load" | "running">;

const VERBS = ["stop", "pause", "continue", "accept", "answer", "tell", "show"] as const;

const USAGE =
  "/mission <goal>: this agent drafts one from your goal; it runs once you start it, and reports here.\n" +
  "/mission: what is running and waiting here. /mission show <id>: one in full.\n" +
  "/mission stop|continue|accept <id>, /mission answer <id> <answer>.\n" +
  "/mission pause <id>: stop its work for now and keep everything; /mission continue <id> goes on from its checklist, whenever you like.\n" +
  "/mission tell <id> <words>: tell it something while it works; it is read before its next step and followed, never a new goal.\n" +
  '/mission accept <id> --outside "<note>": done another way, closed as accepted without its checks.';

/** One mission in full: what decides it is done, where it stands, and the whole of what it asks. */
function show(mission: Mission, limits: string): string {
  const lines = [
    `${mission.title} · ${shortId(mission.id)} · ${mission.agentId} · ${state(mission)}`,
    `Goal: ${mission.goal}`,
    `Done when: ${doneWhen(mission)}.`,
    `Limits: ${limits}`,
  ];
  const asked = mission.answers.at(-1);
  if (mission.status === "waiting" && mission.waitKind === "input" && asked) lines.push(`Asks: ${asked.question}`);
  else if (mission.status === "waiting" && mission.waitKind === "paused") lines.push(`Paused by ${mission.pausedBy ?? "someone"}: /mission continue ${shortId(mission.id)} goes on from its checklist.`);
  else if (mission.reason) lines.push(`${mission.status === "waiting" ? "Waiting for" : "Why"}: ${mission.reason}`);
  if (mission.report) lines.push(`Report: ${mission.report}`);
  const told = mission.told.at(-1);
  if (told) lines.push(`Told while it worked: ${mission.told.length}. Latest, ${told.read === undefined ? "not read yet" : `read in turn ${told.read}`}: "${clip(told.text, 200)}"`);
  return lines.join("\n");
}

/**
 * What the agent's turn is asked for `/mission <goal>`: the goal as the person wrote it, and a draft made of it, never
 * a mission started. The words that carry the rule are asserted by a test.
 */
export function draftAsked(goal: string): string {
  return (
    `The person sent /mission with this goal: "${goal}"\n\n` +
    "Draft a mission for it with the `mission` tool, action \"start\": read what you need first, then write its title, " +
    "goal, brief and checks. If the goal is unclear, ask in this chat first and draft once it is clear. The draft runs " +
    "only when the person starts it."
  );
}

/** One mission in one line, as a list shows it. */
function line(mission: Mission): string {
  return `${shortId(mission.id)} · ${mission.agentId} · ${state(mission)} · ${mission.title}`;
}

function state(mission: Mission): string {
  if (mission.status === "waiting" && mission.waitKind === "paused") return "paused";
  return seenAs(mission.status) === "needs_you" ? `needs you (${mission.waitKind ?? "?"})` : mission.status;
}

/** Whether this sender may act on this mission from here: its chat, and in a room the person who started it or an admin. */
function mayAct(ctx: HookContext, mission: Mission): boolean {
  if (mission.gatewayId !== ctx.gatewayId || mission.chatId !== ctx.chatId) return false;
  return ctx.envelope.chatType === "dm" || mission.startedBy === ctx.senderId || ctx.deps.isAdmin?.(ctx.envelope) === true;
}

function list(missions: MissionCommands, ctx: HookContext): string {
  const here = missions.forChat(ctx.gatewayId, ctx.chatId);
  if (here.length === 0) return `No missions here yet.\n${USAGE}`;
  const order = { needs_you: 0, working: 1, done: 2, ended: 3 } as const;
  const sorted = [...here].sort((a, b) => order[seenAs(a.status)] - order[seenAs(b.status)] || b.createdAt - a.createdAt);
  const open = sorted.filter((mission) => !isFinal(mission.status));
  const ended = sorted.filter((mission) => isFinal(mission.status)).slice(0, 5);
  return [...open.map(line), ...(ended.length ? ["", "Ended:", ...ended.map(line)] : [])].join("\n");
}

/**
 * `/mission`, and `/goal` as other harnesses name it (0.8.10): one objective worked turn after turn — Codex CLI, Letta
 * Code and others have it. Here it is a mission, signed off by its checks, a reviewer or a person; `/goal` got "Unknown
 * command", a dead end for a habit. Hidden, as `/daemon_restart` is: `/help` and the menus keep one name.
 */
const missionHook: Hook = {
  command: "/mission",
  description: "Ask for a mission (a draft you start), or see and answer the missions here: /mission <goal>",
  handler: async (ctx) => {
    const missions = ctx.deps.missions;
    if (!missions) return { handled: true, reply: "Missions are not run in this process." };
    const [first, second, ...rest] = ctx.args;
    if (!first) return { handled: true, reply: list(missions, ctx) };
    const verb = VERBS.find((one) => one === first.toLowerCase());
    if (!verb) return { handled: false, prompt: draftAsked(ctx.args.join(" ")) };
    if (!second) return { handled: true, reply: `Which mission? ${USAGE}` };
    const mission = missions.find(second);
    if (!mission || !mayAct(ctx, mission)) return { handled: true, reply: `No mission ${second} here that you can act on.` };
    if (verb === "show") return { handled: true, reply: show(mission, missions.limitsLine(mission)) };
    const by = ctx.envelope.senderName || ctx.senderId;
    const as = { gatewayId: ctx.gatewayId, senderId: ctx.senderId };
    // `--outside "<note>"`: done another way, closed as accepted without its checks (0.8.7).
    const outside = verb === "accept" && rest[0] === "--outside";
    if (outside) {
      const note = rest.slice(1).join(" ").replace(/^["“]|["”]$/g, "").trim();
      const closed = missions.acceptOutside(mission.id, note, by);
      return { handled: true, ...("refused" in closed ? { reply: closed.refused } : {}) };
    }
    // Words for it while it works (0.8.10): the answer says where they went, and what moves it if it is waiting.
    if (verb === "tell") {
      const told = missions.tell(mission.id, rest.join(" "), by);
      return { handled: true, reply: "refused" in told ? told.refused : told.said };
    }
    const acted =
      verb === "stop"
        ? missions.stop(mission.id, by)
        : verb === "pause"
          ? missions.pause(mission.id, by)
          : verb === "continue"
          ? missions.continueMission(mission.id, by, rest.join(" ") || undefined, as)
          : verb === "accept"
            ? missions.accept(mission.id, by, as)
            : missions.answer(mission.id, rest.join(" "), by);
    if ("refused" in acted) return { handled: true, reply: acted.refused };
    // Stop, pause and accept are answered by the mission's own notice; continue and answer go on quietly. An answer to one
    // that went on working says where it went, as a `tell` does.
    return { handled: true, ...(verb === "continue" || verb === "answer" ? { reply: acted.said ?? `Mission ${shortId(mission.id)} goes on.` } : {}) };
  },
};

export const missionHooks: Hook[] = [missionHook, { ...missionHook, command: "/goal", hidden: true }];
