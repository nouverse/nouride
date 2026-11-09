/**
 * A brief its goal names, on the mission's page (0.8.11): a person looks for a mission's brief where they see its report,
 * and Nouva's audit for a person named "per …/audit_rina/BRIEF.md" in its goal, with no BRIEF.md of the mission's own.
 * The daemon reads it, so only a file inside the agent's private workspace — every link followed — is shown: a goal
 * naming a path through a linked folder must not put the daemon's own files, its control token, on a page.
 */

import { describe, expect, test } from "bun:test";
import { goalBrief } from "@/modules/missions/drafts.ts";
import { missionsHarness } from "./harness.ts";

const PRIVATE = "/w/private/nouva";
/** Real paths as the kernel would give them: `x` in nouva's folder is a link to the daemon's data. */
const real = (path: string): string | null => (path.startsWith(`${PRIVATE}/x/`) ? path.replace(`${PRIVATE}/x/`, "/srv/nouride/.nouride/data/") : path);

describe("the brief a goal names", () => {
  test("inside the agent's own folder: shown, by its real path", () => {
    expect(goalBrief(`Audit KK 1.3a of latest_master.xlsx per ${PRIVATE}/audit_rina/BRIEF.md`, PRIVATE, real)).toBe(`${PRIVATE}/audit_rina/BRIEF.md`);
  });

  test("through a linked folder to the daemon's own files, outside it, or beside it by a prefix: none", () => {
    expect(goalBrief(`Follow the brief at ${PRIVATE}/x/.control-token for this.`, PRIVATE, real)).toBeNull();
    expect(goalBrief("Translate per /opt/projects/site/BRIEF.md", PRIVATE, real)).toBeNull();
    expect(goalBrief("Translate per /w/private/nouva-other/BRIEF.md", PRIVATE, real)).toBeNull();
  });

  test("no brief named, or a folder that is not there: none", () => {
    expect(goalBrief(`Write ${PRIVATE}/out.txt`, PRIVATE, real)).toBeNull();
    expect(goalBrief(`Audit per ${PRIVATE}/audit/BRIEF.md`, PRIVATE, () => null)).toBeNull();
  });
});

describe("what the mission's page shows", () => {
  test("its own BRIEF.md first; else the one its goal names; else none — each with where it is", async () => {
    const named = "/work/private/nova/audit/BRIEF.md";
    const h = await missionsHarness({ goalBriefOf: () => named, readBrief: (path) => (path === named ? "Audit five vouchers." : null) });
    const mission = await h.start(`Audit per ${named}`);
    expect(h.missions.brief(mission)).toEqual({ path: named, text: "Audit five vouchers." });
    const none = await missionsHarness({ goalBriefOf: () => null });
    expect(none.missions.brief(await none.start("Write the report"))).toBeNull();
  });
});
