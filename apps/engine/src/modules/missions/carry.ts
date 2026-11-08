/**
 * A chat's task becomes a mission without starting over: the task the chat's plan is kept with — else the
 * one written last — moves into the mission's notes with its plan, and the chat keeps one line in its place,
 * `→ mission msn_…, running`. When the mission ends, that line becomes its outcome. One page moves; nothing is written
 * twice, and the chat's next turn does not carry on with work a mission is doing. Only the work of the turn that starts
 * it (0.8.8): a task untouched since before it is other work.
 */

import { createLogger } from "@nouride/shared";
import { sameTitle } from "@/modules/notes/format.ts";
import type { NotesKey, NotesPort } from "@/modules/notes/store.ts";
import { MISSION_GATEWAY_ID } from "./gateway.ts";
import { shortId } from "./page.ts";
import type { Mission } from "./types.ts";

const log = createLogger("missions.carry");

const marker = (mission: Pick<Mission, "id">) => `→ mission ${shortId(mission.id)}`;

/**
 * Move the chat's task into the mission. Nothing to move — no task in the chat, or none written in the turn that started
 * it, `since` its start — is not a failure. Any task went, however old: a mission Nix started on 0.8.8 took the chat's
 * notes of the night's CI work, hours untouched, and the chat was left a line saying a test mission was running.
 */
export async function carryInto(notes: NotesPort, mission: Mission, from: NotesKey, since: number | null = null): Promise<void> {
  const fresh = (at: number | undefined) => since === null || (at ?? 0) >= since;
  const plan = notes.plan(from);
  const planned = plan && fresh(plan.updatedAt) ? notes.task(from, plan.task) : undefined;
  const last = notes.latest(from);
  const task = planned ?? (last && fresh(notes.writtenAt(from, last.title)) ? last : undefined);
  if (!task) return;
  const into: NotesKey = { agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id };
  await notes.write(into, task.title, task.body || mission.goal);
  if (plan && planned && sameTitle(plan.task, task.title)) {
    await notes.keepPlan(into, task.title, plan.steps);
    await notes.dropPlan(from);
  }
  await notes.write(from, task.title, `${marker(mission)}, running`);
  log.info("a chat's task moved into a mission", { mission: mission.id, task: task.title, plan: plan?.steps.length ?? 0 });
}

/** The chat's line for the mission becomes how it ended. */
export async function carryBack(notes: NotesPort, mission: Mission): Promise<void> {
  const key: NotesKey = { agentId: mission.byAgent ?? mission.agentId, gatewayId: mission.gatewayId, chatId: mission.chatId };
  const task = notes.tasks(key).find((one) => one.body.startsWith(marker(mission)));
  if (!task) return;
  const how = mission.status === "done" ? `done. ${mission.report ?? "See its report."}` : `${mission.status}${mission.reason ? ` (${mission.reason})` : ""}`;
  await notes.write(key, task.title, `${marker(mission)}: ${how}`.slice(0, 600));
}

/**
 * A mission done by its checks closes the step it was on (0.8.7). Its last step is calling `done`, which ends the turn
 * before the step can be ticked, so every finished mission read "2 of 3 steps done", its last step still at work — on
 * the page, in `nouride mission show` and in `work`, where its own agent took it for a fault. Only when the checks or the
 * person after them said it is done (`reason` null): accepted as it stood, the step it stopped on stays where it was.
 */
export async function closePlan(notes: NotesPort, mission: Mission): Promise<void> {
  if (mission.status !== "done" || mission.reason !== null) return;
  const key: NotesKey = { agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id };
  const plan = notes.plan(key);
  if (!plan?.steps.some((step) => step.state === "active")) return;
  await notes.keepPlan(key, plan.task, plan.steps.map((step) => (step.state === "active" ? { ...step, state: "done" as const } : step)));
}

/** The words of a waiting line — what `carryWait` looks for to put the line back once the answer came. */
const WAITING = "waits for the person's answer";

/**
 * The chat's line for the mission while it waits on a question (0.8.7): the chat's agent reads its notes at every request,
 * so when the person writes in that chat it knows its mission is waiting on them and can say so. Before, the question
 * reached the chat as a notice the agent never saw, and it answered the person as if nothing were open. A mission with
 * no line there gets one. `question` null: answered — the line says it runs again.
 */
export async function carryWait(notes: NotesPort, mission: Mission, question: string | null): Promise<void> {
  if (mission.gatewayId === MISSION_GATEWAY_ID) return;
  const key: NotesKey = { agentId: mission.byAgent ?? mission.agentId, gatewayId: mission.gatewayId, chatId: mission.chatId };
  const task = notes.tasks(key).find((one) => one.body.startsWith(marker(mission)));
  if (question === null) {
    if (task?.body.includes(WAITING)) await notes.write(key, task.title, `${marker(mission)}, running`);
    return;
  }
  const id = shortId(mission.id);
  const line = `${marker(mission)} ${WAITING}: "${question}". They answer with /mission answer ${id} <answer>; you may answer for them with \`work\` only if they told you the answer.`;
  await notes.write(key, task?.title ?? `Mission ${id}`, line.slice(0, 600));
}
