/**
 * What a mission keeps when it is ended over a turn still at work: the turn's count, and a word about the work it left.
 *
 * A stop ends the mission and then its turn, so the turn's end found a mission that had ended and counted nothing. A
 * coding CLI's mission is one long turn: msn_fec04791 was stopped at 26.7M tokens with seven files staged, and its record
 * read 0 turns and tokens unknown while its notice said "stopped by agent nix" and nothing of the files.
 */

import { describe, expect, test } from "bun:test";
import { missionsHarness } from "./harness.ts";

const cli = (agentId: string) => agentId === "nova";

describe("a turn cut short by its mission's end", () => {
  test("a stop still counts it: its turn and its tokens, on the record", async () => {
    const h = await missionsHarness({ runsOnCli: cli, helperTokens: () => 500 });
    const mission = await h.start();
    // The stop comes while the turn is at work; the turn's end comes after it, as a cancelled CLI's does.
    h.turn(mission, { tokens: 26_742_673 }, () => h.missions.stop(mission.id, "Gading"));
    const stopped = h.store.get(mission.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped).toMatchObject({ turnsUsed: 1, tokensUsed: 26_742_673 + 500, cliTurns: 1, cliUnreported: 0 });
    // Known, where it read "tokens unknown (the CLI reports none)".
    expect(h.missions.limitsShown(stopped)).toEqual({ turns: false, tokens: "known" });
    expect(h.missions.limitsLine(stopped)).toContain("26.7M of 50M tokens");
    // Nothing else of the turn is acted on: no next turn, no second notice.
    expect(h.queued.filter((one) => one.chatId === mission.id)).toHaveLength(1);
    expect(h.told.filter((one) => one.text.includes("stopped"))).toHaveLength(1);
  });

  test("a close outside its checks counts it too, and a turn that reported no tokens is counted as one that did not", async () => {
    const h = await missionsHarness({ runsOnCli: cli });
    const mission = await h.start();
    h.turn(mission, { tokens: 0, tokensUnknown: true }, () => h.missions.acceptOutside(mission.id, "merged by hand", "Gading"));
    const closed = h.store.get(mission.id)!;
    expect(closed.status).toBe("done");
    expect(closed).toMatchObject({ turnsUsed: 1, cliTurns: 1, cliUnreported: 1 });
  });

  test("an agent on a model: the turn and its tokens", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, { tokens: 4000 });
    h.turn(h.store.get(mission.id)!, { tokens: 6000 }, () => h.missions.stop(mission.id, "Gading"));
    expect(h.store.get(mission.id)!).toMatchObject({ status: "stopped", turnsUsed: 2, tokensUsed: 10_000 });
  });
});

describe("the notice of a mission that stopped", () => {
  const worktree = (id: string) => `/srv/agents/nova/missions/${id}/worktree`;

  test("names the work nobody committed, and the branch it is on", async () => {
    const asked: string[] = [];
    const h = await missionsHarness({ prepare: async (mission) => worktree(mission.id), leftUncommitted: async (mission) => (asked.push(mission.id), [worktree(mission.id)]) });
    const mission = await h.start("fix the parser");
    h.missions.stop(mission.id, "Gading");
    await h.settle();
    expect(asked).toEqual([mission.id]);
    expect(h.told.at(-1)!.text).toBe(
      `✗ Mission ${mission.id.slice(0, 10)} stopped: stopped by Gading\n\nNot committed: work is left in ${worktree(mission.id)}, on the branch mission/${mission.id}. The folder is kept while it is there.`,
    );
  });

  test("says nothing of it where all is committed, or where it could not be read", async () => {
    const clean = await missionsHarness({ prepare: async (mission) => worktree(mission.id), leftUncommitted: async () => [] });
    const one = await clean.start();
    clean.missions.stop(one.id, "Gading");
    await clean.settle();
    expect(clean.told.at(-1)!.text).toBe(`✗ Mission ${one.id.slice(0, 10)} stopped: stopped by Gading`);

    const broken = await missionsHarness({ leftUncommitted: async () => Promise.reject(new Error("git is not there")) });
    const two = await broken.start();
    broken.missions.stop(two.id, "Gading");
    await broken.settle();
    expect(broken.told.at(-1)!.text).toBe(`✗ Mission ${two.id.slice(0, 10)} stopped: stopped by Gading`);
  });

  test("a mission that gave up is told the same way; a draft dropped is not looked at, and a done one names its branch as before", async () => {
    const asked: string[] = [];
    const h = await missionsHarness({ prepare: async (mission) => worktree(mission.id), leftUncommitted: async (mission) => (asked.push(mission.id), [worktree(mission.id)]) });
    const failed = await h.start("fix the parser");
    h.turn(h.store.get(failed.id)!, {}, () => h.missions.claim(failed.id, { kind: "fail", reason: "the parser is gone", report: "Nothing to fix." }));
    await h.settle();
    expect(h.told.find((one) => one.text.includes("ended: gave up"))!.text).toContain(`Not committed: work is left in ${worktree(failed.id)}`);

    const draft = await h.start("write the notes", { byAgent: "nova", proposed: true });
    h.missions.stop(draft.id, "Gading");
    await h.settle();
    expect(asked).toEqual([failed.id]);

    const done = await h.start("fix the lexer");
    h.turn(h.store.get(done.id)!, {}, () => h.missions.claim(done.id, { kind: "done", summary: "Fixed.", report: "Fixed.", files: [] }));
    await h.settle();
    h.missions.accept(done.id, "Gading");
    await h.settle();
    expect(asked).toEqual([failed.id]);
    expect(h.told.at(-1)!.text).toContain(`Branch: mission/${done.id}`);
  });
});
