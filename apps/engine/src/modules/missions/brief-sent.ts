/**
 * A mission's brief, sent into its chat as a file after the notice that names it.
 *
 * A person reading a draft in a chat app was told "brief: on the mission's page", or read a path on the server at the
 * end of the goal ("Full brief: /srv/…/BRIEF.md"), and could open neither from there: they started work whose
 * instructions they had not read. The brief goes the way the report does (`results.ts`): whole, as a file, under the
 * notice. An agent's brief only: a person's own words are not sent back to them.
 */

import { createLogger } from "@nouride/shared";
import type { MissionsDeps } from "./deps.ts";
import { BRIEF_FILE } from "./drafts.ts";
import type { Mission } from "./types.ts";

const log = createLogger("missions");

type BriefPorts = Pick<MissionsDeps, "briefOf" | "goalBriefOf" | "readBrief">;

/** Its brief as written, and where: its own `BRIEF.md`, else one its goal names inside its agent's own folder. */
export function briefOf(deps: BriefPorts, mission: Mission): { path: string; text: string } | null {
  for (const path of [deps.briefOf?.(mission), deps.goalBriefOf?.(mission)]) {
    const text = path ? (deps.readBrief?.(path) ?? null) : null;
    if (path && text !== null) return { path, text };
  }
  return null;
}

/** Its brief as `BRIEF.md` into its chat; where the chat could not take it, said so, with where it is read instead. */
export async function sendBrief(deps: BriefPorts & Pick<MissionsDeps, "sendBrief" | "tell">, mission: Mission): Promise<void> {
  const brief = deps.sendBrief ? briefOf(deps, mission) : null;
  if (!brief || !deps.sendBrief) return;
  try {
    const refused = await deps.sendBrief(mission, brief.text);
    if (refused) await deps.tell(mission, `${BRIEF_FILE} was not sent: ${refused} The brief is on the mission's page.`);
  } catch (err) {
    log.warn("a mission's brief could not be sent", { mission: mission.id, error: String(err) });
  }
}

/**
 * The briefs of missions an agent started with no draft before them (one mission handing a piece to another agent):
 * written as the start is made, and owed to the chat with the notice that it started (a job's run has no such notice,
 * and is sent none). Held from a start to its first turn, or to its end where it never began; a daemon stopped in
 * between begins the mission from its folder as it is, and sends nothing.
 */
export class StartBriefs {
  private readonly writing = new Map<string, Promise<string | null>>();
  private readonly owed = new Set<string>();

  /** A start with no draft: its brief, where it gave one, is written now. Resolves to why it could not be, or null. */
  started(deps: Pick<MissionsDeps, "draftFolder">, mission: Mission, brief: string | undefined, byAgent: boolean): Promise<string | null> | undefined {
    if (byAgent) this.owed.add(mission.id);
    if (brief === undefined || !deps.draftFolder) return undefined;
    const written = deps.draftFolder(mission, brief).then(
      () => null,
      (err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        log.warn("a mission's brief could not be written at its start", { mission: mission.id, error: why });
        return why;
      },
    );
    this.writing.set(mission.id, written);
    // Held only while it is being written: a mission that waits a day for its turn keeps no row here.
    void written.then(() => void (this.writing.get(mission.id) === written && this.writing.delete(mission.id)));
    return written;
  }

  /** Before its first turn names it: its brief is in its folder, or could not be. */
  async written(missionId: string): Promise<void> {
    await this.writing.get(missionId);
  }

  /** Whether its chat is owed the brief under the notice that it started. Asked once. */
  owes(missionId: string): boolean {
    return this.owed.delete(missionId);
  }

  forget(missionId: string): void {
    this.writing.delete(missionId);
    this.owed.delete(missionId);
  }

  entries(): number {
    return this.writing.size + this.owed.size;
  }
}
