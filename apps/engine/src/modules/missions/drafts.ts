/**
 * Drafts (0.8.11, RFC MISSION_DRAFTS): a mission an agent starts from a chat waits for the person's start — its goal,
 * its brief, its checks and who signs it off shown first, and changed before anything runs. On 2026-10-31 three RFC
 * missions ran with a reviewer judging documents for a person who was in the chat to read them, and none could be
 * changed once asked for. A draft is a proposal (`waiting` for an `accept`, never started): its buttons, its place under
 * needs-you and its start on a yes were there already.
 */

import { plural } from "@nouride/shared";
import { GAP } from "./notices.ts";
import { shortId } from "./page.ts";
import { briefFilesOf, briefRefusal, startRefusal, type StartRequest } from "./start.ts";
import type { MissionsPort } from "./missions.store.ts";
import type { Mission } from "./types.ts";
import { ownFolderOf } from "./worktree.ts";

/**
 * A brief its goal names by its path — "audit KK 1.3a per /…/audit_rina/BRIEF.md" — where the mission has no `BRIEF.md`
 * of its own (0.8.11): it is shown on the mission's page, as its report is. Its real path, every link
 * followed, and only inside the agent's private workspace: the daemon reads it, so a goal naming a path through a
 * linked folder must not put the daemon's own files — its control token — on a page. `real` is `realPathStrict`.
 */
export function goalBrief(goal: string, privateDir: string, real: (path: string) => string | null): string | null {
  const root = real(privateDir);
  if (!root) return null;
  for (const path of briefFilesOf(goal)) {
    const resolved = real(path);
    if (resolved && resolved.startsWith(`${root}/`)) return resolved;
  }
  return null;
}

/** The brief's file, in the mission's own folder: what the work is, why, what to read, what done means. */
export const BRIEF_FILE = "BRIEF.md";

/** Not started and waiting for the person's start: a draft — the agent's own, or a proposal a turn nobody typed made. */
export function isDraft(mission: Pick<Mission, "status" | "waitKind" | "startedAt">): boolean {
  return mission.status === "waiting" && mission.waitKind === "accept" && mission.startedAt === null;
}

/** Where its brief is: in the folder the daemon makes for it under its agent's own (`ownFolderOf`). */
export function briefPath(privateDir: string, missionId: string): string {
  return `${ownFolderOf(privateDir, missionId)}/${BRIEF_FILE}`;
}

/** Who signs its result off, as the person reads it: the reviewer, they themselves, or its checks alone. */
export function signedOffBy(mission: Pick<Mission, "checks" | "reviewOn" | "accept" | "jobId">): string {
  const person = mission.accept || (mission.checks.length === 0 && mission.jobId === null);
  return [mission.reviewOn ? "the reviewer" : "", person ? "you" : ""].filter(Boolean).join(", then ") || "its checks";
}

/**
 * The draft's notice: what the person decides on before anything runs, with a line saying what changed when it is sent
 * again after an edit. The proposal said "💡 … proposes a mission" and its goal, and the person started it without the
 * checks or the sign-off in front of them.
 */
export function draftNotice(mission: Pick<Mission, "id" | "goal" | "agentId" | "byAgent" | "checks" | "reviewOn" | "accept" | "jobId">, brief: boolean, changed: readonly string[] = []): string {
  const id = shortId(mission.id);
  const who = mission.byAgent && mission.byAgent !== mission.agentId ? `${mission.agentId}, drafted by ${mission.byAgent}` : mission.agentId;
  const checks = mission.checks.length === 0 ? "no checks" : `${mission.checks.length} ${plural(mission.checks.length, "check")}`;
  return [
    ...(changed.length > 0 ? [`✎ Draft ${id} changed: ${changed.join(", ")}.`] : []),
    `📝 Draft ${id} · ${who}: ${mission.goal.trim()}`,
    `${checks} · signed off by: ${signedOffBy(mission)} · brief: ${brief ? "on the mission's page" : "none"}`,
    `Start it: /mission accept ${id} · drop it: /mission stop ${id}`,
  ].join(GAP);
}

/** What may change in a draft — the start's own fields; `limits` from the dashboard only, as an agent raises none. */
export interface DraftChange {
  goal?: string;
  checks?: readonly string[];
  /** Criteria in words; false for no reviewer; true for the reviewer on the goal. */
  review?: string | boolean;
  accept?: boolean;
  /** A folder to work in, or null for the mission's own. */
  workdir?: string | null;
  branch?: string | null;
  limits?: Partial<Mission["limits"]>;
  /** `BRIEF.md`'s new text, written whole. */
  brief?: string;
}

/** Who changes it: an agent's words are working text, held to English as its start is; a person's are theirs. */
export interface DraftEditor {
  byAgent?: string;
}

/**
 * The draft with a change applied, and what changed in words — or why not. Checked as a start is (`startRefusal`), except
 * the day's count, which the draft is already in.
 */
export function changedDraft(
  mission: Mission,
  change: DraftChange,
  editor: DraftEditor,
  deps: { exists: (agentId: string) => boolean; store: Pick<MissionsPort, "get">; now: number; ownFolder: string; checkRefusal?: (request: Pick<StartRequest, "agentId" | "workdir">, command: string) => string | null },
): { mission: Mission; changed: string[] } | { refused: string } {
  if (!isDraft(mission)) return { refused: `Mission ${shortId(mission.id)} has started; a running mission's goal and checks stay as they are. Tell it something instead.` };
  const next: Mission = { ...mission, checks: [...mission.checks], limits: { ...mission.limits } };
  const changed: string[] = [];
  if (change.goal !== undefined && change.goal.trim() !== mission.goal) {
    next.goal = change.goal.trim();
    changed.push("goal");
  }
  if (change.checks !== undefined) {
    const checks = change.checks.map((check) => (typeof check === "string" ? check.trim() : check)).filter(Boolean);
    if (JSON.stringify(checks) !== JSON.stringify(mission.checks)) {
      next.checks = checks as string[];
      changed.push(checks.length === 0 ? "no checks" : `checks (${checks.length})`);
    }
  }
  if (change.review !== undefined) {
    const on = change.review !== false;
    const criteria = typeof change.review === "string" && change.review.trim() ? change.review.trim() : null;
    if (on !== mission.reviewOn || (typeof change.review === "string" && criteria !== mission.review)) {
      next.reviewOn = on;
      next.review = on ? (typeof change.review === "string" ? criteria : mission.review) : null;
      changed.push(on ? "the reviewer's criteria" : "no reviewer");
    }
  }
  if (change.accept !== undefined && change.accept !== mission.accept) {
    next.accept = change.accept;
    changed.push(change.accept ? "you accept it" : "no accept of yours");
  }
  if (change.workdir !== undefined) {
    const workdir = change.workdir?.trim() || deps.ownFolder;
    if (workdir !== mission.workdir) {
      next.workdir = workdir;
      if (workdir === deps.ownFolder) next.branch = null;
      changed.push(workdir === deps.ownFolder ? "its own folder" : `folder ${workdir}`);
    }
  }
  if (change.branch !== undefined && (change.branch?.trim() || null) !== next.branch) {
    next.branch = change.branch?.trim() || null;
    changed.push(next.branch ? `branch ${next.branch}` : "the default branch");
  }
  for (const key of ["hours", "turns", "tokens"] as const) {
    const value = change.limits?.[key];
    if (value === undefined || value === mission.limits[key]) continue;
    if (!Number.isFinite(value) || value <= 0) return { refused: `A limit is a number above zero: ${key}.` };
    next.limits[key] = value;
    changed.push(`its ${key} limit`);
  }
  if (change.brief !== undefined) {
    const why = briefRefusal(change.brief, Boolean(editor.byAgent));
    if (why) return { refused: why };
    changed.push("the brief");
  }
  if (changed.length === 0) return { refused: "Nothing in the draft changes." };
  const request: StartRequest = {
    agentId: next.agentId,
    goal: next.goal,
    checks: next.checks,
    review: next.reviewOn ? (next.review ?? undefined) : false,
    ...(next.workdir !== deps.ownFolder ? { workdir: next.workdir } : {}),
    ...(next.branch ? { branch: next.branch } : {}),
    startedBy: next.startedBy,
    gatewayId: next.gatewayId,
    chatId: next.chatId,
    ...(editor.byAgent ? { byAgent: editor.byAgent } : {}),
  };
  // The day's count is the start's, and this draft is in it already.
  const refused = startRefusal(request, {
    exists: deps.exists,
    store: { get: (id) => deps.store.get(id), startedByAgentSince: () => 0 },
    now: deps.now,
    ...(deps.checkRefusal ? { checkRefusal: deps.checkRefusal } : {}),
  });
  if (refused) return { refused };
  next.updatedAt = deps.now;
  return { mission: next, changed };
}
