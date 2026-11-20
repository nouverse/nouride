/**
 * Deleting an agent: what it would take (`summarize`), and taking it (`deleteAgent`).
 *
 * Nothing deleted one before: an agent could be turned off and its pack removed by hand, with its automations,
 * connections, grants and Linux user left behind. The rule: everything that makes the agent run is
 * deleted, with no folder to bring it back from; what happened stays. So its pack, its private folder with its coding
 * CLI's sign-ins, its automations, its grants and stored sign-ins, the connections only it answers, its seat in
 * rooms, its background jobs and its user on the machine go, its open missions stopped first. Its chats, what it
 * remembered and the graph, its missions' records, the audit log and usage stay, and an agent made later under the
 * same id is joined to them. Which table is which is `ON_AGENT_DELETE` (`db/keys.ts`).
 *
 * The orchestrator is refused: an install needs one, and another agent is made it first. No agent has a tool for
 * this: it is an admin's, from the dashboard or the CLI, which both come through here.
 *
 * In an order that leaves nothing running over what is being removed: the agent is taken out of the registry, so
 * nothing new reaches it; its work is ended; its rows and its credentials go; its folders are deleted as the agent
 * whose they are; and last its user is removed, after which nothing of the machine's is the agent's.
 */

import type { AccountRemoval } from "@nouride/isolation";
import { privateWorkspace } from "@nouride/persona";
import { removeAsAgent, removePath, statFile } from "@nouride/runtime";
import { createLogger, type Job, type JobStep } from "@nouride/shared";
import type { AgentDeleted, AgentDeletion } from "@nouride/wire";
import { agentRowCounts, agentSignIns, forgetAgentRows } from "@/db/agent-rows.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { weigh } from "./system-remove.ts";
import type { ControlDeps } from "./types.ts";

const log = createLogger("control.agent-delete");

/** What the delete reaches of the daemon: the control routes' own, and the agents' users (`boot/agent-users.ts`). */
export type AgentDeleteDeps = Pick<
  ControlDeps,
  "ctx" | "registry" | "pipeline" | "approvals" | "grants" | "toolGrants" | "jobs" | "missions" | "cron" | "settings" | "rooms" | "mcpLogins" | "externalAgents" | "audit"
> & {
  /** The agent's connections to its connectors, closed with it. */
  mcp?: { disconnectAgent(agentId: string): Promise<void> | void } | undefined;
  /** Its user on the machine removed, where agents have one. Absent in a process that never asked: none. */
  account?: ((agentId: string) => Promise<AccountRemoval | { how: "none" }>) | undefined;
  /** Whether agents' commands run as users of their own here: what the summary says goes. */
  ownUsers?: (() => boolean) | undefined;
};

export type Refused = { error: string; why: "missing" | "orchestrator"; plain: string };

/** The words for an agent that is the orchestrator, the same wherever the refusal is shown. */
const ORCHESTRATOR = "You need at least an orchestrator. Make another agent the orchestrator first.";

function refusal(deps: Pick<AgentDeleteDeps, "ctx" | "registry">, agentId: string): Refused | null {
  if (!deps.registry.get(agentId)) return { error: `no agent "${agentId}"`, why: "missing", plain: "This agent is not there any more. Reload the page." };
  if (deps.ctx.config.daemon.orchestrator === agentId) return { error: ORCHESTRATOR, why: "orchestrator", plain: ORCHESTRATOR };
  return null;
}

/** Whether a step of a job is given to `agentId`: its own turn or mission, or one of those started together. */
function handsTo(step: JobStep, agentId: string): boolean {
  if (step.kind === "agentTurn" || step.kind === "mission") return step.agentId === agentId;
  if (step.kind === "parallel") return step.steps.some((one) => one.kind === "agentTurn" && one.agentId === agentId);
  return false;
}

/** Its own automations, and the other agents' with a step given to it. */
function automations(deps: Pick<AgentDeleteDeps, "cron">, agentId: string): { own: Job[]; handed: Job[] } {
  const all = deps.cron?.store.list({ includeDisabled: true }) ?? [];
  return {
    own: all.filter((job) => job.agentId === agentId),
    handed: all.filter((job) => job.agentId !== agentId && job.payload.kind === "steps" && job.payload.steps.some((step) => handsTo(step, agentId))),
  };
}

/** The connections it alone answers: each names one agent, so every one that names it. */
function connections(deps: Pick<AgentDeleteDeps, "ctx">, agentId: string): string[] {
  return deps.ctx.config.gateways.filter((gateway) => gateway.agent === agentId).map((gateway) => gateway.id);
}

/** Its own folders: its pack, and its private folder, which holds its coding CLI's sign-ins and its missions' folders. */
function folders(deps: Pick<AgentDeleteDeps, "ctx" | "registry">, agentId: string): string[] {
  const pack = deps.registry.get(agentId)?.dir;
  return [...(pack ? [pack] : []), privateWorkspace(deps.ctx.config.daemon.workspaceDir, agentId)];
}

/** What `folders` hold together, as Files weighs a folder before it is deleted. */
async function weight(paths: readonly string[]): Promise<AgentDeletion["folder"]> {
  const total = { bytes: 0 as number | null, files: 0, more: false };
  for (const real of paths) {
    if (!statFile(real)?.isDirectory) continue;
    const one = await weigh({ real, link: false, entry: { name: real, path: real, kind: "folder", sizeBytes: null, modifiedAt: 0 } } as Parameters<typeof weigh>[0]);
    total.files += one.files;
    total.more ||= one.more;
    total.bytes = total.bytes === null || one.bytes === null ? null : total.bytes + one.bytes;
  }
  return total;
}

type Counts = AgentDeleted["took"];

function counts(deps: AgentDeleteDeps, agentId: string): Counts {
  const rows = agentRowCounts(deps.ctx.db, agentId);
  const jobs = automations(deps, agentId);
  return {
    missions: deps.missions?.stillOpen(agentId).length ?? 0,
    jobs: deps.jobs?.running(agentId).length ?? 0,
    automations: jobs.own.length,
    handed: jobs.handed.length,
    connections: connections(deps, agentId),
    rooms: rows.chat_members ?? 0,
    grants: (rows.exec_grants ?? 0) + (rows.tool_grants ?? 0),
    signIns: rows.mcp_oauth ?? 0,
  };
}

/** What a delete would take, for the dialog that asks: counted, and its folders weighed. Refused for the orchestrator. */
export async function summarize(deps: AgentDeleteDeps, agentId: string): Promise<AgentDeletion | Refused> {
  const refused = refusal(deps, agentId);
  if (refused) return refused;
  const agent = deps.registry.get(agentId)!;
  return {
    agent: agentId,
    displayName: agent.config.displayName,
    ...counts(deps, agentId),
    folder: await weight(folders(deps, agentId)),
    account: deps.ownUsers?.() === true,
  };
}

/**
 * A folder and all in it gone: as the agent first, which removes what is its own, then what is left as the daemon.
 * `asAgent` false once its user is removed: the daemon alone, since nothing runs as a user that is gone.
 */
async function removeFolder(agentId: string, path: string, asAgent = true): Promise<boolean> {
  if (!statFile(path)) return true;
  if (asAgent) await removeAsAgent(agentId, path).catch((err: unknown) => log.warn("a deleted agent's folder could not be emptied as the agent", { agent: agentId, path, error: String(err) }));
  try {
    removePath(path);
  } catch (err) {
    log.warn("a deleted agent's folder could not be removed", { agent: agentId, path, error: String(err) });
  }
  return !statFile(path);
}

/** The agent's work ended: its open missions stopped, its jobs killed, its turns cut, its coding CLI and connectors let go. */
async function endWork(deps: AgentDeleteDeps, agentId: string, by: string): Promise<void> {
  // A mission's end reads "stopped by" whoever is named: the admin, and why, in words that follow that.
  for (const mission of deps.missions?.stillOpen(agentId) ?? []) deps.missions!.stop(mission.id, `${by}, who deleted its agent ${agentId}`);
  for (const job of deps.jobs?.running(agentId) ?? []) deps.jobs!.kill(job.id, `agent ${agentId} deleted by ${by}`);
  for (const turn of deps.pipeline.runningTurns()) {
    // A mission's turn was cut by its stop above; any other of its turns is cut here, chat by chat.
    if (turn.agentId === agentId && turn.gatewayId !== MISSION_GATEWAY_ID) deps.pipeline.cancelTurnFor(agentId, turn.chatId);
  }
  deps.externalAgents?.stopLogin(agentId);
  await Promise.resolve(deps.externalAgents?.stop(agentId)).catch((err: unknown) => log.warn("a deleted agent's coding CLI could not be stopped", { agent: agentId, error: String(err) }));
  await Promise.resolve(deps.mcp?.disconnectAgent(agentId)).catch((err: unknown) => log.warn("a deleted agent's connectors could not be closed", { agent: agentId, error: String(err) }));
}

/**
 * The agent deleted. `by`: the admin, as the audit log names them. The orchestrator and an agent that is not there are
 * refused before anything is touched; past that it goes through to the end, and what could not be taken is said in
 * `notes`, since half a delete put back is not something this can do.
 */
export async function deleteAgent(deps: AgentDeleteDeps, agentId: string, by: string): Promise<AgentDeleted | Refused> {
  const refused = refusal(deps, agentId);
  if (refused) return refused;
  const took = counts(deps, agentId);
  const paths = folders(deps, agentId);
  const jobs = automations(deps, agentId);
  const notes: string[] = [];
  log.info("deleting an agent", { agent: agentId, by });

  // Out of the registry first: no message, schedule or ask reaches it from here on.
  deps.registry.remove(agentId);
  await endWork(deps, agentId, by);

  for (const job of jobs.own) deps.cron!.store.delete(job.id, by);
  // Another agent's automation with a step for it would fail at that step, or start an agent made later under the id:
  // turned off, with why on its row, for its owner to give the step to somebody else.
  for (const job of jobs.handed) deps.cron!.store.turnOff(job.id, `A step of it was given to ${agentId}, an agent that has been deleted. Give that step to another agent, then turn it on again.`);
  for (const id of took.connections) {
    const removed = await deps.settings?.removeGateway(id, by, { keepToken: true });
    if (!removed?.ok) notes.push(`The connection ${id} could not be removed${removed && !removed.ok ? `: ${removed.error}` : ""}.`);
  }
  deps.approvals.expireAll(agentId);
  deps.grants?.revokeAll(by, agentId);
  // Stored sign-ins: each one's tokens out of the secret store, then its row.
  for (const server of agentSignIns(deps.ctx.db, agentId)) await deps.mcpLogins?.forget(agentId, server).catch((err: unknown) => log.warn("a deleted agent's sign-in could not be forgotten", { agent: agentId, server, error: String(err) }));
  const rows = forgetAgentRows(deps.ctx.db, agentId);

  // Its jobs' logs go with the jobs; the folder is made by asking for it, so it is asked for only to be removed.
  if (deps.jobs) paths.push(deps.jobs.logDirFor(agentId));
  for (const path of paths) {
    if (!(await removeFolder(agentId, path))) notes.push(`Part of ${path} could not be deleted.`);
  }
  const account = await removeAccount(deps, agentId, notes);
  // What the agent's own user could not delete, and its user is gone: the helper handed it over, so once more.
  if (account === "removed") for (const path of paths) await removeFolder(agentId, path, false);

  deps.audit.record({ action: "agent_deleted", actor: by, agentId, details: { ...took, connections: took.connections.join(",") || "none", account, rows, notes: notes.length } });
  log.info("agent deleted", { agent: agentId, by, account, notes: notes.length });
  return { deleted: agentId, took, account, notes };
}

/** Its user on the machine removed, last. What the helper said becomes one word, and a note where it is left behind. */
async function removeAccount(deps: AgentDeleteDeps, agentId: string, notes: string[]): Promise<AgentDeleted["account"]> {
  const answer = deps.account ? await deps.account(agentId).catch((err: unknown): AccountRemoval => ({ how: "refused", why: String(err) })) : { how: "none" as const };
  if (answer.how === "none" || answer.how === "absent") return answer.how;
  if (answer.how === "removed") {
    if (answer.left > 0) notes.push(`${answer.left} of its files in the shared folder could not be handed over.`);
    return "removed";
  }
  notes.push(
    answer.how === "old"
      ? `Its account on the machine, nr-${agentId}, is left: the part of Nouride that removes one was installed by an earlier release. Running the installer again brings it up to date.`
      : `Its account on the machine, nr-${agentId}, is left: ${answer.why}.`,
  );
  return "left";
}
