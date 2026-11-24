/**
 * Acting on a draft (0.8.11, `drafts.ts` decides): its folder and brief written and its notice sent when it is drafted,
 * and again — saying what changed — when the agent changes it from its chat or a person does on the dashboard.
 */

import { createLogger } from "@nouride/shared";
import { buttonsFor } from "./actions.ts";
import { briefOf, sendBrief } from "./brief-sent.ts";
import { blockedBy } from "./decide.ts";
import type { MissionsDeps } from "./deps.ts";
import { changedDraft, draftChangedLine, draftNotice, ownLimits, type DraftChange, type DraftEditor } from "./drafts.ts";
import type { Missions } from "./missions.ts";
import { paged } from "./notices.ts";
import type { Mission } from "./types.ts";
import { ownFolderOf } from "./worktree.ts";

const log = createLogger("missions");

/**
 * The draft's folder made and its brief written, then its notice sent with Start it and Drop it, and its brief under
 * it as a file: when an agent makes the draft, and again when its agent writes the brief anew (`rewritten`). A
 * person's own draft, or their change to a brief, is not sent back to them. Resolves to why the brief could not be
 * written — the notice then says it has none — or null.
 */
export async function announceDraft(deps: MissionsDeps, mission: Mission, brief?: string, changed: readonly string[] = [], rewritten = false): Promise<string | null> {
  let failed: string | null = null;
  let has = false;
  try {
    // Its own `BRIEF.md`, or a file its goal names: either is what the person is sent.
    has = (await deps.draftFolder?.(mission, brief)) === true || briefOf(deps, mission) !== null;
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    log.warn("a draft's folder or brief could not be written", { mission: mission.id, error: failed });
  }
  // What the dispatcher would hold it back for were it started now: said, so a start is known to be a place in the queue.
  const settings = deps.settings();
  const behind = blockedBy(mission, deps.store.open(), settings);
  const whole = paged(draftNotice(mission, has, changed, behind, ownLimits(mission, settings)), deps.pageOf?.(mission));
  // Its one notice: sent when it is made, rewritten where it stands when it changes (`draft-notices.ts`). A daemon
  // with no such chat (a test bench) says it as any notice.
  if (deps.tellDraft) await deps.tellDraft(mission, whole, changed.length > 0 ? paged(draftChangedLine(mission, changed), deps.pageOf?.(mission)) : null, buttonsFor(mission) ?? []);
  else await deps.tell(mission, whole, buttonsFor(mission));
  if (has && ((changed.length === 0 && mission.byAgent !== null) || rewritten)) await sendBrief(deps, mission);
  return failed;
}

export type DraftEdited = { mission: Mission; changed: string[]; briefFailed: string | null } | { refused: string };

/** A change to a draft, checked as a start is, saved and said in its chat again. A started mission's stays its own. */
export async function editDraft(missions: Missions, deps: MissionsDeps, id: string, change: DraftChange, editor: DraftEditor): Promise<DraftEdited> {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.` };
  const ownFolder = ownFolderOf(deps.agents.privateDir(mission.agentId), mission.id);
  const result = changedDraft(mission, change, editor, { exists: deps.agents.exists, store: deps.store, now: missions.now(), ownFolder, ...(deps.checkRefusal ? { checkRefusal: deps.checkRefusal } : {}) });
  if ("refused" in result) return result;
  const next = result.mission;
  if (next.branch && next.workdir !== ownFolder && (next.branch !== mission.branch || next.workdir !== mission.workdir)) {
    const refused = await missions.branchRefusal({ agentId: next.agentId, workdir: next.workdir, branch: next.branch });
    if (refused) return { refused };
  }
  // Started or dropped while git answered: the change is not saved over what happened.
  const now = deps.store.get(mission.id);
  if (!now || now.updatedAt !== mission.updatedAt) return { refused: `Mission ${id} changed meanwhile. Look at it again.` };
  deps.store.save(next);
  deps.changed?.(next);
  log.info("a draft changed", { mission: next.id, by: editor.byAgent ?? "a person", changed: result.changed });
  const briefFailed = await announceDraft(deps, next, change.brief, result.changed, change.brief !== undefined && editor.byAgent !== undefined);
  return { mission: next, changed: result.changed, briefFailed };
}
