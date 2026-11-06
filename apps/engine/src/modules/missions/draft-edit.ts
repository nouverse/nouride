/**
 * Acting on a draft (0.8.11, `drafts.ts` decides): its folder and brief written and its notice sent when it is drafted,
 * and again — saying what changed — when the agent changes it from its chat or a person does on the dashboard.
 */

import { createLogger } from "@nouride/shared";
import { buttonsFor } from "./actions.ts";
import type { MissionsDeps } from "./deps.ts";
import { changedDraft, draftNotice, type DraftChange, type DraftEditor } from "./drafts.ts";
import type { Missions } from "./missions.ts";
import { paged } from "./notices.ts";
import type { Mission } from "./types.ts";
import { ownFolderOf } from "./worktree.ts";

const log = createLogger("missions");

/**
 * The draft's folder made and its brief written, then its notice sent with Start it and Drop it. Resolves to why the
 * brief could not be written — the notice then says it has none — or null.
 */
export async function announceDraft(deps: MissionsDeps, mission: Mission, brief?: string, changed: readonly string[] = []): Promise<string | null> {
  let failed: string | null = null;
  let has = false;
  try {
    has = (await deps.draftFolder?.(mission, brief)) === true;
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
    log.warn("a draft's folder or brief could not be written", { mission: mission.id, error: failed });
  }
  await deps.tell(mission, paged(draftNotice(mission, has, changed), deps.pageOf?.(mission)), buttonsFor(mission));
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
  const briefFailed = await announceDraft(deps, next, change.brief, result.changed);
  return { mission: next, changed: result.changed, briefFailed };
}
