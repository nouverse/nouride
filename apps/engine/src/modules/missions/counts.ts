/**
 * What a mission counts beside its turns (0.8.7): a coding CLI's tokens — reported over ACP or not — and its helpers'
 * metered tokens, and from these which limits hold and how its tokens are shown. Kept on the mission's record (0.8.13):
 * its CLI's turns and how many reported no tokens, and up to when its helpers' tokens are in its count. Kept in memory
 * before, a restart showed a CLI mission that counted 0 as unknown, one that reported for some turns only as a full
 * count, and counted its helpers' tokens again from its start.
 */

import type { TurnOutcome } from "@/modules/pipeline/turn-shape.ts";
import type { LimitsInForce } from "./decide.ts";
import type { MissionsDeps } from "./deps.ts";
import type { LimitsShown } from "./page.ts";
import type { Mission } from "./types.ts";

export class MissionCounts {
  constructor(private readonly deps: Pick<MissionsDeps, "runsOnCli" | "helperTokens" | "runningTokens">) {}

  private runsOnCli(mission: Pick<Mission, "agentId">): boolean {
    return this.deps.runsOnCli?.(mission.agentId) === true;
  }

  /** A turn ended: its tokens, and its helpers' since the last count, into the mission's — saved with it by the caller. */
  turnEnded(mission: Mission, outcome: Pick<TurnOutcome, "tokens" | "tokensUnknown">, now: number): void {
    mission.tokensUsed += outcome.tokens;
    if (this.runsOnCli(mission)) {
      mission.cliTurns += 1;
      if (outcome.tokensUnknown) mission.cliUnreported += 1;
    }
    // Its helpers' tokens, metered under its conversation while this turn ran or since the last — background ones too.
    if (this.deps.helperTokens) {
      mission.tokensUsed += this.deps.helperTokens(mission, mission.helpersSince ?? mission.startedAt ?? now);
      mission.helpersSince = now;
    }
  }

  /**
   * What it has spent and is not in its count yet (0.8.8): its helpers' tokens since the last count, metered, and its
   * coding CLI's turn running now, estimated (`MissionsDeps.runningTokens`). A CLI mission's turn runs for hours and is
   * counted at its end, so a limit read only the count went past it unseen — msn_3d28e0 ended at 248M of 208M.
   */
  unsettled(mission: Mission, now: number): { helpers: number; running: number } {
    const since = mission.helpersSince ?? mission.startedAt ?? now;
    return { helpers: this.deps.helperTokens?.(mission, since) ?? 0, running: this.deps.runningTokens?.(mission) ?? 0 };
  }

  /** Its helpers' tokens are in its count up to `now` — the reviewer's, which `Checking` added itself. */
  helpersCounted(mission: Mission, now: number): void {
    mission.helpersSince = now;
  }

  /** The limits that hold for it — a coding CLI's mission is not held to turns (`decide.ts` `LimitsInForce`). */
  inForce(mission: Pick<Mission, "agentId">): LimitsInForce {
    return { turns: !this.runsOnCli(mission) };
  }

  /** Which limits hold, and whether its tokens are known: a CLI that reported none leaves them unknown, not 0. */
  shown(mission: Mission): LimitsShown {
    if (!this.runsOnCli(mission)) return { turns: true, tokens: "known" };
    const { cliUnreported: unreported, cliTurns: heard } = mission;
    const tokens = mission.tokensUsed === 0 && (unreported > 0 || heard === 0) ? "unknown" : unreported > 0 ? "partial" : "known";
    return { turns: false, tokens };
  }
}
