/**
 * A mission's life, through the service on a real database: started, given its slot, its turns shaped from its page,
 * and each turn's end leading where §3 and §7 of the design say — the checks, a person, a limit, or the next turn.
 */

import { workedMs } from "@/modules/missions/page.ts";
import { describe, expect, test } from "bun:test";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import type { ToolContext } from "@nouride/shared";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { carryInto } from "@/modules/missions/carry.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { missionsHarness } from "./harness.ts";
import { eventually } from "../wait.ts";

describe("starting", () => {
  test("a mission a person asked for starts at once: running, told in its chat, and its first turn queued on its own connection", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.told[0]!.text).toStartWith(`▶ ${mission.id.slice(0, 10)}: `);
    expect(h.told[0]!.text).toContain(`/mission stop ${mission.id.slice(0, 10)}`);
    const turn = h.queued[0]!;
    expect(turn).toMatchObject({ gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, senderId: SYSTEM_SENDER, mentions: ["nova"] });
  });

  test("one per agent: the second waits in the queue, saying for which, and starts when the first ends", async () => {
    const h = await missionsHarness();
    const first = await h.start("one");
    const second = await h.start("two");
    await h.settle();
    expect(h.store.get(second.id)!.status).toBe("queued");
    expect(h.told.find((one) => one.mission === second.id)!.text).toContain(first.id.slice(0, 10));
    h.missions.stop(first.id, "Gading");
    await h.settle();
    expect(h.store.get(second.id)!.status).toBe("running");
  });

  test("two on the box at most, whoever's agent", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 1 } });
    await h.start("one");
    const other = await h.start("two", { agentId: "nox" });
    expect(h.store.get(other.id)!.status).toBe("queued");
  });

  test("one repository, one mission: one waiting for a person still holds its folder — though not a slot", async () => {
    // Only running ones were counted: a mission parked on an approval left its folder free, and a second started there.
    const h = await missionsHarness({ settings: { perAgent: 4, maxRunning: 4 } });
    const first = await h.start("fix the parser", { workdir: "/srv/repo" });
    h.parked.set(first.id, [{ id: "apr_1", what: "exec: git push" }]);
    h.turn(first, { worked: 0 });
    expect(h.store.get(first.id)!.waitKind).toBe("approval");
    const second = await h.start("fix the lexer", { workdir: "/srv/repo/src" });
    expect(h.store.get(second.id)!.status).toBe("queued");
    expect(h.told.find((one) => one.mission === second.id)!.text).toContain(`${first.id.slice(0, 10)} is working in the same folder`);
    expect(h.store.get((await h.start("tidy the docs", { workdir: "/srv/docs" })).id)!.status).toBe("running");
    // A proposal has not started: nothing of it is in its folder yet.
    await h.start("tidy the wiki", { workdir: "/srv/wiki", startedBy: SYSTEM_SENDER, byAgent: "nova", proposed: true });
    expect(h.store.get((await h.start("fix the wiki", { workdir: "/srv/wiki" })).id)!.status).toBe("running");
  });

  test("two queued for one folder and started in one pass: the first holds it from the second", async () => {
    const h = await missionsHarness({ settings: { perAgent: 4, maxRunning: 4 } });
    h.asleep.add("nova");
    const first = await h.start("fix the parser", { workdir: "/srv/repo" });
    h.tick(1);
    const second = await h.start("fix the lexer", { workdir: "/srv/repo" });
    h.asleep.delete("nova");
    h.missions.woke("nova");
    expect([h.store.get(first.id)!.status, h.store.get(second.id)!.status]).toEqual(["running", "queued"]);
  });

  test("an agent's own idea waits for the person's yes, and their accept starts it", async () => {
    const h = await missionsHarness();
    const mission = await h.start("tidy the logs", { startedBy: SYSTEM_SENDER, byAgent: "nova", proposed: true });
    expect(mission.status).toBe("waiting");
    expect(mission.waitKind).toBe("accept");
    expect(h.queued).toHaveLength(0);
    // Said as what it is — a draft nothing has run of — not as a result that passed its checks (0.8.11, `drafts.ts`).
    const id = mission.id.slice(0, 10);
    expect(h.told.at(-1)!.text).toBe(`📝 Draft ${id} · nova: tidy the logs\n\nno checks · signed off by: the reviewer, then you · brief: none\n\nStart it: /mission accept ${id} · drop it: /mission stop ${id}`);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued).toHaveLength(1);
    // From the dashboard or the CLI, nobody on its connection said it: it runs as it was.
    expect(h.store.get(mission.id)!.startedBy).toBe(SYSTEM_SENDER);
  });

  test("a proposal accepted in its own chat runs as whoever accepted it — elsewhere, as it was", async () => {
    // It ran as the daemon whose turn proposed it: the daemon's approval level, no People entry, and in a group only an
    // admin could answer what it asked.
    const h = await missionsHarness();
    const inChat = await h.start("tidy the logs", { startedBy: SYSTEM_SENDER, byAgent: "nova", proposed: true });
    h.missions.accept(inChat.id, "Gading", { gatewayId: "telegram:nova", senderId: "8142" });
    expect(h.store.get(inChat.id)!.startedBy).toBe("8142");
    expect(h.missions.shapeFor("nova", { gatewayId: "web:mission", chatId: inChat.id, text: "go", senderId: SYSTEM_SENDER, raw: { via: "mission" } } as never)?.person).toEqual({ gatewayId: "telegram:nova", senderId: "8142" });

    const continued = await h.start("tidy the cache", { agentId: "nox", startedBy: SYSTEM_SENDER, byAgent: "nox", proposed: true });
    h.missions.continueMission(continued.id, "Gading", undefined, { gatewayId: "telegram:nova", senderId: "8142" });
    expect(h.store.get(continued.id)!.startedBy).toBe("8142");

    const elsewhere = await h.start("tidy the disk", { startedBy: SYSTEM_SENDER, byAgent: "nova", proposed: true });
    // An id on another connection means nobody on the mission's: it runs as it was.
    h.missions.accept(elsewhere.id, "Gading", { gatewayId: "discord:nova", senderId: "77" });
    expect(h.store.get(elsewhere.id)!.startedBy).toBe(SYSTEM_SENDER);
  });

  test("stopped or deleted while its worktree is made, it stays so — and the worktree goes with it", async () => {
    // `git worktree add` takes a while in a big repository: the copy the mission began with was saved over the stop, and
    // a stopped mission ran on — a deleted one came back.
    let made = (_dir: string) => {};
    const h = await missionsHarness({ prepare: () => new Promise<string>((resolve) => (made = resolve)) });
    const stopped = await h.start("fix the bug", { workdir: "/home/me/repo" });
    h.missions.stop(stopped.id, "Gading");
    made(`/work/private/nova/missions/${stopped.id}/worktree`);
    await h.settle();
    expect(h.store.get(stopped.id)!.status).toBe("stopped");
    expect(h.queued.filter((one) => one.chatId === stopped.id)).toHaveLength(0);
    expect(h.told.filter((one) => one.mission === stopped.id).map((one) => one.text)).not.toContainEqual(expect.stringContaining("started"));
    expect(h.removed).toEqual([stopped.id]);

    const deleted = await h.start("fix the other bug", { workdir: "/home/me/repo" });
    h.missions.forget(deleted.id, "Gading");
    made(`/work/private/nova/missions/${deleted.id}/worktree`);
    await h.settle();
    expect(h.store.get(deleted.id)).toBeNull();
    expect(h.queued.filter((one) => one.chatId === deleted.id)).toHaveLength(0);
  });

  test("refused: no agent, no goal, a relative workdir, and one level of missions inside missions", async () => {
    const h = await missionsHarness();
    const refused = (extra: Partial<Parameters<typeof h.missions.start>[0]>) =>
      h.missions.start({ agentId: "nova", goal: "x", startedBy: "1", gatewayId: "telegram:nova", chatId: "1", ...extra });
    expect(refused({ agentId: "ghost" })).toEqual({ refused: "There is no agent called ghost." });
    expect(refused({ goal: "  " })).toMatchObject({ refused: expect.stringContaining("needs a goal") });
    expect(refused({ workdir: "repo" })).toMatchObject({ refused: expect.stringContaining("absolute path") });
    const parent = await h.start("parent");
    const child = await h.start("child", { parentId: parent.id, agentId: "nox" });
    expect(refused({ parentId: child.id })).toMatchObject({ refused: expect.stringContaining("one level only") });
  });

  test("an agent may start twenty in a day; a person is not counted", async () => {
    const h = await missionsHarness();
    for (let i = 0; i < 20; i += 1) await h.start(`job ${i}`, { byAgent: "nova" });
    expect(h.missions.start({ agentId: "nova", goal: "21st", startedBy: "1", gatewayId: "t:x", chatId: "1", byAgent: "nova" })).toMatchObject({ refused: expect.stringContaining("20 missions") });
    expect("mission" in h.missions.start({ agentId: "nova", goal: "a person's", startedBy: "1", gatewayId: "t:x", chatId: "1" })).toBe(true);
  });
});

describe("a turn", () => {
  test("starts from the page, fresh, as the person who started it, its approvals parked for a day", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const shape = h.missions.shapeFor("nova", h.queued[0]!)!;
    expect(shape.fresh).toBe(true);
    expect(shape.person).toEqual({ gatewayId: "telegram:nova", senderId: "8142" });
    expect(shape.parkApprovalsMs).toBe(24 * 60 * 60_000);
    expect(shape.workdir).toBe(mission.workdir);
    expect(shape.text).toStartWith(`MISSION ${mission.id}: turn 1 of at most 50`);
  });

  test("is not run for a mission that has ended, or by another agent", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    expect(h.missions.shapeFor("nox", h.queued[0]!)).toBeNull();
    h.missions.stop(mission.id, "Gading");
    expect(h.missions.shapeFor("nova", h.queued[0]!)).toBeNull();
  });

  test("that did something leads to the next turn; one whose job still runs waits for the job's end", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission);
    expect(h.queued).toHaveLength(2);
    expect(h.queued[1]!.text).toBe("continue with the next step.");
    h.jobs.set("nova", [{ id: "job_1", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }]);
    h.turn(mission);
    expect(h.queued).toHaveLength(2);
    expect(h.store.get(mission.id)!.turnsUsed).toBe(2);
  });

  test("three in a row that do nothing — no call that worked, no step moved — and a person is asked", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    for (let i = 0; i < 3; i += 1) h.turn(mission, { worked: 0 });
    const now = h.store.get(mission.id)!;
    expect(now.status).toBe("waiting");
    expect(now.waitKind).toBe("stuck");
    expect(h.told.at(-1)!.text).toContain("is stuck");
  });

  test("calls that were all refused are not progress: three such turns and a person is asked", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    for (let i = 0; i < 3; i += 1) h.turn(mission, { toolCalls: 2, worked: 0 });
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("a step moved is progress, even with no other call", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    for (let i = 0; i < 3; i += 1) {
      h.queued.length = 0;
      h.queued.push({ ...h.queued[0]!, chatId: mission.id } as never);
    }
    for (let i = 0; i < 3; i += 1) {
      const shape = h.missions.shapeFor("nova", { gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, text: "continue", senderId: SYSTEM_SENDER, raw: { via: "mission" } } as never)!;
      await h.plan(mission.id, [{ text: `step ${i}`, state: "done" }]);
      shape.ended({ toolCalls: 0, worked: 0, tokens: 10, failed: false, interrupted: false, readOutside: false });
    }
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("parked approvals and nothing else done: it waits for the person, and goes on when one is answered", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.parked.set(mission.id, [{ id: "apr_1", what: "exec: scp KK.xlsx laptop:" }]);
    h.turn(mission, { worked: 0 });
    const waiting = h.store.get(mission.id)!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.waitKind).toBe("approval");
    expect(h.told.at(-1)!.text).toContain("#apr_1");
    h.tick(3 * 60 * 60_000);
    const answered = h.missions.shapeFor("nova", { gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, text: "approved", senderId: SYSTEM_SENDER, raw: { via: "approval resumed" } } as never);
    expect(answered).not.toBeNull();
    const after = h.store.get(mission.id)!;
    expect(after.status).toBe("running");
    // Three hours waiting on a person are not three hours of work.
    expect(after.waitedMs).toBe(3 * 60 * 60_000);
  });

  test("waiting, it is resumed only by what answers the wait — never by a job's still-going note or a turn taken up", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    const wake = (via: string) => h.missions.shapeFor("nova", { gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, text: via, senderId: SYSTEM_SENDER, raw: { via } } as never);
    // Its question resumed by any of these: it ran on without the answer, and `/mission answer` was then refused.
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Which branch?" }));
    for (const via of ["job quiet", "restart resumed", "provider resumed", "approval resumed"]) expect(wake(via)).toBeNull();
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
    expect("mission" in h.missions.answer(mission.id, "main", "Gading")).toBe(true);
    // Waiting on its approvals: one answered, or a job of its own ending, may be what it waits to move on.
    h.parked.set(mission.id, [{ id: "apr_1", what: "exec: make deploy" }]);
    h.turn(mission, { worked: 0 });
    expect(wake("job quiet")).toBeNull();
    expect(h.store.get(mission.id)!.waitKind).toBe("approval");
    expect(wake("job completion")).not.toBeNull();
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("its approvals answered, it is not told they were refused: the answer's own turn resumes it", async () => {
    // Nothing parked was read as all expired: a minute's check between a person's yes and the turn that yes queues told
    // the agent its approvals were refused.
    const h = await missionsHarness();
    const mission = await h.start();
    h.parked.set(mission.id, [{ id: "apr_1", what: "exec: make deploy" }]);
    h.turn(mission, { worked: 0 });
    h.parked.delete(mission.id);
    h.settled.set(mission.id, ["approved"]);
    h.missions.tick();
    expect(h.store.get(mission.id)!.waitKind).toBe("approval");
    expect(h.queued.map((one) => one.text)).not.toContainEqual(expect.stringContaining("are refused"));
    // Left to expire with nobody answering: it is told so, and goes on without them.
    h.settled.set(mission.id, ["expired"]);
    h.missions.tick();
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toContain("were not answered in time and are refused");
  });

  test("parked approvals and a turn that only checked on them: it waits, rather than a turn a minute", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    await h.plan(mission.id, [{ text: "Write the file", state: "done" }, { text: "Put nox to sleep", state: "active" }]);
    h.turn(mission, { worked: 2 });
    expect(h.store.get(mission.id)!.status).toBe("running");
    h.parked.set(mission.id, [{ id: "apr_1", what: "nouride agent sleep nox" }]);
    // It read its approvals, found them pending, wrote so into the step's note, and ended: calls that worked, a
    // checklist that changed, and no step finished.
    await h.turnPlanning(mission, [{ text: "Write the file", state: "done" }, { text: "Put nox to sleep", state: "active", note: "approval still pending" }], { worked: 2 });
    expect(h.store.get(mission.id)!).toMatchObject({ status: "waiting", waitKind: "approval" });
  });

  test("parked approvals and a step finished: it goes on with what does not depend on them", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.parked.set(mission.id, [{ id: "apr_1", what: "nouride agent sleep nox" }]);
    await h.turnPlanning(mission, [{ text: "Write the file", state: "done" }, { text: "Put nox to sleep", state: "active" }], { worked: 2 });
    expect(h.store.get(mission.id)!.status).toBe("running");
  });

  test("ended, it withdraws the approvals it parked — nothing asks for it after", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.parked.set(mission.id, [{ id: "apr_1", what: "nouride agent sleep nox" }]);
    h.missions.stop(mission.id, "Gading");
    expect(h.parked.has(mission.id)).toBe(false);
  });

  test("ended, its CLI session is let go — kept, it stayed open in the agent's CLI (0.8.1)", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    expect(h.letGo).toEqual([]);
    h.missions.stop(mission.id, "Gading");
    expect(h.letGo).toEqual([mission.id]);
  });

  test("its hours stop when it ends: a page read later says what it worked, not the time since", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.tick(11 * 60_000);
    h.missions.stop(mission.id, "Gading");
    h.tick(90 * 60_000);
    expect(workedMs(h.store.get(mission.id)!, h.now())).toBe(11 * 60_000);
  });

  test("a failed turn pauses it to try again by itself, with the error said once (0.8.7, `retry.test.ts`)", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, { failed: true, worked: 0, error: "provider down" });
    const now = h.store.get(mission.id)!;
    expect(now.waitKind).toBe("retry");
    expect(now.reason).toContain("provider down");
  });

  test("queued and never run — dropped on the way — is lost an hour on: the mission is nudged, then a person is told", async () => {
    // A queue that timed it out or was full, an agent turned off: the turn never reached the mission, which stayed
    // `running` with it in flight for good — past the checks that nudge a quiet mission and the limits.
    const h = await missionsHarness();
    const mission = await h.start();
    h.tick(30 * 60_000);
    h.missions.tick();
    expect(h.queued).toHaveLength(1);
    h.tick(31 * 60_000);
    h.missions.tick();
    expect(h.queued.at(-1)!.text).toContain("nothing has happened in this mission for an hour");
    h.tick(61 * 60_000);
    h.missions.tick();
    expect(h.store.get(mission.id)!).toMatchObject({ status: "waiting", waitKind: "stuck" });
  });

  test("held for an asleep agent is not lost: it runs when the agent wakes", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.asleep.add("nova");
    h.tick(3 * 60 * 60_000);
    h.missions.tick();
    expect(h.queued).toHaveLength(1);
    expect(h.store.get(mission.id)!.status).toBe("running");
    // It wakes: the held turn goes back into the queue, and is the one that runs — none queued beside it.
    h.asleep.delete("nova");
    h.missions.woke("nova");
    expect(h.queued).toHaveLength(1);
    h.tick(30 * 60_000);
    h.missions.tick();
    expect(h.queued).toHaveLength(1);
  });

  test("cut off by a shutdown is left for the restart, not counted against it", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, { interrupted: true, worked: 0 });
    expect(h.store.get(mission.id)!.status).toBe("running");
    expect(h.queued).toHaveLength(1);
  });
});

describe("done means checked", () => {
  test("`done` runs the checks; passed, the mission is done: its result told, then its report as `report.md`, then its files", async () => {
    const h = await missionsHarness();
    const mission = await h.start("write it", { checks: ["test -s out.md"] });
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "The text is written.", report: "Wrote it, all of it.", files: [`${mission.workdir}/out.md`] }));
    await h.settle();
    const done = h.store.get(mission.id)!;
    expect(done.status).toBe("done");
    expect(h.told.at(-1)!.text).toBe("✓ Mission " + mission.id.slice(0, 10) + " done (checks passed, reviewed).\n\nThe text is written.");
    expect(h.reports).toEqual([{ mission: mission.id, report: "Wrote it, all of it." }]);
    expect(h.delivered).toEqual([`${mission.workdir}/out.md`]);
    expect(h.sent.slice(-3)).toEqual(["notice", "report.md", "files"]);
  });

  test("its result files go to its chat after the done notice, and any that could not are named", async () => {
    const h = await missionsHarness();
    h.setUnsent(["big.zip"]);
    const mission = await h.start("pack it", { checks: ["true"] });
    const files = [`${mission.workdir}/report.md`, `${mission.workdir}/big.zip`];
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "Packed.", files }));
    await h.settle();
    expect(h.delivered).toEqual(files);
    expect(h.told.at(-1)!.text).toBe("Not sent as files (they are on the mission's page): big.zip");
  });

  test("a failed check is the next turn, its output on the page; the same failure three times and a person decides", async () => {
    const h = await missionsHarness();
    const mission = await h.start("write it", { checks: ["grep -q hello out.txt"] });
    h.setChecks(async () => ({ passed: false, failed: { command: "grep -q hello out.txt", output: "[no output, exit code 1]" } }));
    for (let i = 0; i < 2; i += 1) {
      const shape = h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "done", files: [] }))!;
      await h.settle();
      expect(h.store.get(mission.id)!.status).toBe("running");
      if (i === 1) expect(shape.text).toContain("Last check failed:\n$ grep -q hello out.txt");
    }
    expect(h.queued.at(-1)!.text).toContain("a check failed");
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "done", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("no commands: a person accepts", async () => {
    const h = await missionsHarness();
    const mission = await h.start("decide the colours");
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "The colours are blue.", report: "Blue, for the reasons below.", files: [] }));
    await h.settle();
    expect(h.store.get(mission.id)!.waitKind).toBe("accept");
    // It had no checks, so it passed none: it is done, and waits for a yes — its report sent with the wait, read first.
    expect(h.told.at(-1)!.text).toStartWith(`☑ Mission ${mission.id.slice(0, 10)} is done.\n\nThe colours are blue.\n\nAccept:`);
    expect(h.reports.map((one) => one.report)).toEqual(["Blue, for the reasons below."]);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    expect(h.store.get(mission.id)!.status).toBe("done");
    expect(h.told.at(-1)!.text).toContain("accepted");
    // Accepted, the same report is not sent again.
    expect(h.reports).toHaveLength(1);
  });

  test("in a worktree of its own, the yes it waits for names the branch its work is on (0.8.1)", async () => {
    const h = await missionsHarness({ prepare: async (mission) => `/srv/agents/nova/missions/${mission.id}/worktree` });
    const mission = await h.start("fix the parser");
    h.turn(h.store.get(mission.id)!, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "The parser is fixed.", report: "Fixed.", files: [] }));
    await h.settle();
    expect(h.told.at(-1)!.text).toContain(`The parser is fixed.\n\nBranch: mission/${mission.id}\n\nAccept:`);
  });
});

describe("a person", () => {
  test("is asked, answers, and the next turn says what they answered", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Keep the old sheet?" }));
    expect(h.store.get(mission.id)!.waitKind).toBe("input");
    expect(h.told.at(-1)!.text).toContain("asks: Keep the old sheet?");
    h.missions.answer(mission.id, "yes, rename it", "Gading");
    expect(h.queued.at(-1)!.text).toBe("Gading answered your question: yes, rename it");
    const page = h.missions.shapeFor("nova", h.queued.at(-1)!)!.text;
    expect(page).toContain('"Keep the old sheet?" → "yes, rename it"');
  });

  test("the same question three times is not asked again: going round in circles", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    for (let i = 0; i < 3; i += 1) {
      h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Which sheet?" }));
      if (i < 2) h.missions.answer(mission.id, "the first", "Gading");
    }
    expect(h.store.get(mission.id)!.waitKind).toBe("stuck");
  });

  test("stops it: its turn stopped, its jobs killed, the chat told", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.jobs.set("nova", [{ id: "job_9", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }]);
    h.missions.stop(mission.id, "Gading");
    expect(h.stopped).toEqual([mission.id]);
    expect(h.killed).toEqual(["job_9"]);
    expect(h.store.get(mission.id)!.status).toBe("stopped");
    expect(h.told.at(-1)!.text).toContain("stopped: stopped by Gading");
  });

  test("finds one by the prefix it was shown, and only when one has it", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    expect(h.missions.find(mission.id.slice(0, 10))?.id).toBe(mission.id);
    expect(h.missions.find(mission.id.slice(4, 12))?.id).toBe(mission.id);
    expect(h.missions.find("msn_")).toBeNull();
  });
});

describe("limits", () => {
  test("a limit reached stops its jobs and waits; continue raises that one from where it stands, and only that one", async () => {
    const h = await missionsHarness({ settings: { limitTurns: 2 } });
    const mission = await h.start();
    h.jobs.set("nova", [{ id: "job_2", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }]);
    h.turn(mission);
    h.jobs.clear();
    h.queued.push({ gatewayId: MISSION_GATEWAY_ID, chatId: mission.id, text: "job done", senderId: SYSTEM_SENDER, raw: { via: "job completion" } } as never);
    h.turn(mission);
    const waiting = h.store.get(mission.id)!;
    expect(waiting.waitKind).toBe("limit");
    expect(h.told.at(-1)!.text).toContain("reached its turn limit (2 turns)");
    h.missions.continueMission(mission.id, "Gading");
    const again = h.store.get(mission.id)!;
    expect(again.status).toBe("running");
    expect(again.limits).toEqual({ turns: 4, tokens: 50_000_000, hours: 8 });
  });

  test("continuing after its token limit leaves its turns and hours as they were (0.8.8)", async () => {
    // All three rose: msn_3d28e0 went on after 100M tokens and read "101 turns" and "of 8.960713333333333h".
    const h = await missionsHarness({ settings: { limitTokens: 5000 } });
    const mission = await h.start();
    h.tick(57 * 60_000);
    h.turn(mission, { tokens: 6000 });
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits).toEqual({ turns: 50, tokens: 11_000, hours: 8 });
  });

  test("continuing after its hours leaves its turns and tokens as they were, the new limit to the minute (0.8.8)", async () => {
    const h = await missionsHarness({ settings: { limitHours: 1 } });
    const mission = await h.start();
    h.tick(61 * 60_000 + 38_000);
    h.turn(mission, { tokens: 2000 });
    expect(h.store.get(mission.id)).toMatchObject({ waitKind: "limit", reason: "its time limit (1h of work)" });
    h.missions.continueMission(mission.id, "Gading");
    const again = h.store.get(mission.id)!;
    expect(again).toMatchObject({ status: "running", limits: { turns: 50, tokens: 50_000_000 } });
    // 1h01m38s worked and an hour more, up to the whole minute: 2h02m, said as it is kept.
    expect(again.limits.hours * 60).toBeCloseTo(122, 9);
    expect(h.missions.limitsLine(again)).toContain(" · 1h02m of 2h02m · ");
  });

  test("two limits reached at once both rise, the third stays (0.8.8)", async () => {
    const h = await missionsHarness({ settings: { limitTurns: 2, limitTokens: 1500 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 1000 });
    h.turn(mission, { tokens: 1000 });
    expect(h.store.get(mission.id)).toMatchObject({ waitKind: "limit", turnsUsed: 2, tokensUsed: 2000 });
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits).toEqual({ turns: 4, tokens: 3500, hours: 8 });
  });

  test("a coding CLI's mission, held to no turn limit, keeps the turn limit it had when its tokens are raised (0.8.8)", async () => {
    const h = await missionsHarness({ runsOnCli: (agentId) => agentId === "nova", settings: { limitTurns: 1, limitTokens: 5000 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 6000 });
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits).toEqual({ turns: 1, tokens: 11_000, hours: 8 });
  });

  test("hours count work, not waiting for a person", async () => {
    const h = await missionsHarness({ settings: { limitHours: 1 } });
    const mission = await h.start();
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "ask", question: "Which one?" }));
    h.tick(5 * 60 * 60_000);
    h.missions.answer(mission.id, "the first", "Gading");
    h.turn(mission);
    expect(h.store.get(mission.id)!.status).toBe("running");
    h.tick(61 * 60_000);
    h.turn(mission);
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
  });

  test("a proposal accepted days later counts none of that wait: its hours are its work, and the limit holds", async () => {
    // The wait for the yes went into `waitedMs` before it had started: accepted 60 hours on, it read 0h worked after 20.
    const h = await missionsHarness();
    const mission = await h.start("tidy the logs", { startedBy: SYSTEM_SENDER, byAgent: "nova", proposed: true });
    h.tick(60 * 60 * 60_000);
    h.missions.accept(mission.id, "Gading");
    await h.settle();
    h.tick(2 * 60 * 60_000);
    expect(workedMs(h.store.get(mission.id)!, h.now())).toBe(2 * 60 * 60_000);
    h.tick(7 * 60 * 60_000);
    h.turn(h.store.get(mission.id)!);
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
  });

  test("at 80% of one the chat is told, once", async () => {
    const h = await missionsHarness({ settings: { limitTurns: 5 } });
    const mission = await h.start();
    for (let i = 0; i < 4; i += 1) h.turn(mission);
    const warned = h.told.filter((one) => one.text.includes("used 80%"));
    expect(warned).toHaveLength(1);
    expect(warned[0]!.text).toContain("its 5 turns");
  });

  test("a turn that reaches the limit says the limit alone — not 80% of it in the same breath (0.8.8)", async () => {
    // msn_3d28e0's chat: "has used 80% of its 100M tokens" and "reached its token limit" in the same second.
    const h = await missionsHarness({ settings: { limitTokens: 5000 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 6000 });
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
    expect(h.told.filter((one) => one.text.includes("used 80%"))).toEqual([]);
    expect(h.told.at(-1)!.text).toContain(`reached its token limit (5k tokens). It is waiting: /mission continue ${mission.id.slice(0, 10)} gives it 5k more tokens,`);
  });

  test("going on raises a limit at 80% of itself with the one reached — it stopped the mission again a minute on", async () => {
    // A review of 44ec0bc3: with only the reached one raised, hours at 7h59m of 8h stopped the next turn at once.
    const h = await missionsHarness({ settings: { limitTokens: 5000, limitHours: 8 } });
    const mission = await h.start();
    h.tick(7.9 * 3_600_000);
    h.turn(mission, { tokens: 6000 });
    expect(h.told.at(-1)!.text).toContain("gives it 5k more tokens and 8h more of work,");
    h.missions.continueMission(mission.id, "Gading");
    const limits = h.store.get(mission.id)!.limits;
    expect(limits.tokens).toBe(11_000);
    expect(limits.hours).toBeCloseTo(15.9, 5);
    expect(limits.turns).toBe(50);
  });

  test("going on warns again at 80% only of what it raised — not twice of one already said (a review of 44ec0bc3)", async () => {
    const h = await missionsHarness({ settings: { limitHours: 8, limitTokens: 10_000_000 } });
    const mission = await h.start("model", { agentId: "nox" });
    h.turn(mission, { tokens: 8_500_000 });
    expect(h.told.filter((one) => one.text.includes("used 80%"))).toHaveLength(1);
    h.tick(8 * 3_600_000);
    h.missions.tick();
    h.turn(h.store.get(mission.id)!);
    expect(h.store.get(mission.id)!.waitKind).toBe("limit");
    h.missions.continueMission(mission.id, "Gading");
    h.turn(h.store.get(mission.id)!, { tokens: 100_000 });
    expect(h.told.filter((one) => one.text.includes("used 80%"))).toHaveLength(1);
  });

  test("the limit notice says what going on gives — each limit it reached, by its setting", async () => {
    const h = await missionsHarness({ settings: { limitTurns: 1, limitTokens: 5000 } });
    const mission = await h.start();
    h.turn(mission, { tokens: 6000 });
    expect(h.told.at(-1)!.text).toContain("gives it 1 more turn and 5k more tokens,");
    h.missions.continueMission(mission.id, "Gading");
    expect(h.store.get(mission.id)!.limits).toEqual({ turns: 2, tokens: 11_000, hours: 8 });
  });
});

describe("after a restart", () => {
  test("a running mission goes on — and one cut off three times with no step finished fails", async () => {
    const h = await missionsHarness();
    await h.start();
    h.queued.length = 0;
    h.missions.afterRestart();
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.text).toContain("the daemon restarted");
    const fresh = await missionsHarness();
    const looping = await fresh.start();
    fresh.store.save({ ...fresh.store.get(looping.id)!, resumes: 2 });
    fresh.missions.afterRestart(new Map([[looping.id, []]]));
    expect(fresh.store.get(looping.id)!.status).toBe("failed");
  });

  test("a restart that cut none of its turns is not counted: three deploys while its job runs, and it runs on", async () => {
    // Every restart was counted, graceful ones included: a healthy mission on one long step failed at the third deploy.
    const h = await missionsHarness();
    const mission = await h.start();
    h.jobs.set("nova", [{ id: "job_1", gatewayId: MISSION_GATEWAY_ID, chatId: mission.id }]);
    h.turn(mission);
    for (let i = 0; i < 3; i += 1) h.missions.afterRestart();
    expect(h.store.get(mission.id)!).toMatchObject({ status: "running", resumes: 0 });
  });

  test("cut off in a call the gate asks about, it waits for a person; cut off in one that changed things, it goes on told to check", async () => {
    const h = await missionsHarness();
    const asking = await h.start("clean up");
    h.missions.afterRestart(new Map([[asking.id, [{ name: "exec", arguments: { command: "rm -rf /srv/old" } }]]]));
    expect(h.store.get(asking.id)!.waitKind).toBe("unknown_outcome");
    expect(h.told.at(-1)!.text).toContain("cut off by a restart in the middle of exec rm -rf /srv/old");
    const other = await missionsHarness();
    const changing = await other.start("deploy");
    other.queued.length = 0;
    other.missions.afterRestart(new Map([[changing.id, [{ name: "exec", arguments: { command: "./deploy.sh" } }]]]));
    expect(other.queued[0]!.text).toContain("It was cut off in `exec ./deploy.sh`, which may have changed something");
  });
});

describe("a chat's task", () => {
  test("moves into the mission started from it, plan and all, and the chat keeps one line — its outcome once it ends", async () => {
    const h = await missionsHarness();
    const chat = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142" };
    await h.notes.write(chat, "Audit KK 1.1", "Rules: LS if the payee is a vendor.");
    await h.notes.keepPlan(chat, "Audit KK 1.1", [{ text: "sort the sheet", state: "done" }, { text: "check 52 documents", state: "pending" }]);
    const mission = await h.start("finish the audit", { from: chat });
    const into = { agentId: "nova", gatewayId: "web:mission", chatId: mission.id };
    await eventually(() => h.notes.task(chat, "Audit KK 1.1")?.body.startsWith("→ mission") === true, 2_000, "the chat's line");
    expect(h.notes.task(into, "Audit KK 1.1")?.body).toBe("Rules: LS if the payee is a vendor.");
    expect(h.notes.plan(into)?.steps).toHaveLength(2);
    expect(h.notes.plan(chat)).toBeUndefined();
    expect(h.notes.task(chat, "Audit KK 1.1")?.body).toBe(`→ mission ${mission.id.slice(0, 10)}, running`);
    h.turn(mission, {}, () => h.missions.claim(mission.id, { kind: "done", summary: "Done.", report: "52 marked.", files: [] }));
    await h.settle();
    h.missions.accept(mission.id, "Gading");
    await eventually(() => h.notes.task(chat, "Audit KK 1.1")?.body.includes(": done") === true, 2_000, "the outcome line");
    expect(h.notes.task(chat, "Audit KK 1.1")?.body).toBe(`→ mission ${mission.id.slice(0, 10)}: done. 52 marked.`);
  });
});

describe("a chat's task, only the turn's own (0.8.8)", () => {
  // Nix's test mission on the live box took the chat's notes of the night's CI work, hours untouched, and the chat was left
  // "→ mission msn_c691d8, running" in their place.
  test("a task untouched since before the turn that starts the mission stays in the chat, whole", async () => {
    const h = await missionsHarness();
    const chat = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142" };
    await h.notes.write(chat, "v0.8.8 CI red", "Root cause: the harness leaks into /tmp.");
    const mission = await h.start("count the lines");
    await carryInto(h.notes, mission, chat, Date.now() + 60_000);
    expect(h.notes.task(chat, "v0.8.8 CI red")?.body).toBe("Root cause: the harness leaks into /tmp.");
    expect(h.notes.tasks({ agentId: "nova", gatewayId: "web:mission", chatId: mission.id })).toEqual([]);
    // Started with no turn to read — a person's own start — it moves as it always did.
    await carryInto(h.notes, mission, chat, null);
    expect(h.notes.task(chat, "v0.8.8 CI red")?.body).toBe(`→ mission ${mission.id.slice(0, 10)}, running`);
  });

  test("one written in that turn moves, plan and all — and a plan kept in it moves its task though another was written later", async () => {
    let turnStart = 0;
    const h = await missionsHarness({ turnStartedAt: () => turnStart });
    const chat = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142" };
    await h.notes.write(chat, "old work", "Done last week.");
    turnStart = Date.now();
    await h.notes.write(chat, "Audit KK", "Rules: LS if the payee is a vendor.");
    await h.notes.keepPlan(chat, "Audit KK", [{ text: "check 52 documents", state: "pending" }]);
    const mission = await h.start("finish the audit", { from: { ...chat, turnId: "turn_2" } });
    const into = { agentId: "nova", gatewayId: "web:mission", chatId: mission.id };
    await eventually(() => h.notes.task(into, "Audit KK") !== undefined, 2_000, "the task in the mission");
    expect(h.notes.plan(into)?.steps).toHaveLength(1);
    expect(h.notes.task(chat, "old work")?.body).toBe("Done last week.");
  });

  test("the chat's `mission` start names the turn it is called in, whose start the carry reads", async () => {
    const asked: string[] = [];
    const h = await missionsHarness({ turnStartedAt: (turnId) => (asked.push(turnId), 0) });
    await createMissionTools(h.missions).chat.execute({ action: "start", goal: "count the lines" }, { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142", turnId: "turn_9" } as ToolContext);
    expect(asked).toEqual(["turn_9"]);
  });
});

describe("a mission handed out from inside another", () => {
  test("tells the one it came from how it ended — the parent's next turn starts from that", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 4 } });
    const parent = await h.start("ship the release");
    const child = await h.start("write the notes", { agentId: "nox", parentId: parent.id });
    h.turn(child, {}, () => h.missions.claim(child.id, { kind: "done", summary: "Done.", report: "Notes written.", files: [] }));
    await h.settle();
    h.missions.accept(child.id, "Gading");
    const told = h.queued.filter((one) => one.chatId === parent.id).at(-1)!;
    expect(told.text).toContain(`the mission you handed to nox, ${child.id.slice(0, 10)}, is done: Notes written.`);
  });

  test("its parent waits for it as for a job of its own: no next turn with nothing to do, no nudge — its end is the next", async () => {
    // A parent with nothing left but its child's result went round idle turns into `stuck`, and the child's end found it
    // waiting and was dropped.
    const h = await missionsHarness({ settings: { maxRunning: 4 } });
    const parent = await h.start("ship the release");
    const child = await h.start("write the notes", { agentId: "nox", parentId: parent.id });
    const parentTurns = () => h.queued.filter((one) => one.chatId === parent.id);
    h.turn(parent, { worked: 0 });
    expect(parentTurns()).toHaveLength(1);
    h.tick(3 * 60 * 60_000);
    h.missions.tick();
    expect(h.store.get(parent.id)!.status).toBe("running");
    expect(parentTurns()).toHaveLength(1);
    h.turn(h.store.get(child.id)!, {}, () => h.missions.claim(child.id, { kind: "fail", reason: "no access to the wiki", report: "" }));
    expect(parentTurns().at(-1)!.text).toContain("ended (failed): gave up: no access to the wiki");
  });

  test("how it went is on its parent's page — an end that came while the parent waited for a person is not lost", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 4 } });
    const parent = await h.start("ship the release");
    const child = await h.start("write the notes", { agentId: "nox", parentId: parent.id });
    h.turn(parent, {}, () => h.missions.claim(parent.id, { kind: "ask", question: "Which version?" }));
    h.turn(child, {}, () => h.missions.claim(child.id, { kind: "done", summary: "Done.", report: "Notes written.", files: [] }));
    await h.settle();
    h.missions.accept(child.id, "Gading");
    h.missions.answer(parent.id, "0.8.1", "Gading");
    const page = h.missions.shapeFor("nova", h.queued.filter((one) => one.chatId === parent.id).at(-1)!)!.text;
    expect(page).toContain(`Missions you handed out: ${child.id.slice(0, 10)} to nox (done: Notes written.)`);
  });
});

describe("an ended mission", () => {
  test("is remembered once, as an episode of its agent's memory", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.stop(mission.id, "Gading");
    await h.settle();
    expect(h.remembered).toEqual([mission.id]);
  });

  test("a week on, its own folder is removed — never a folder a person named", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 4, perAgent: 4 } });
    const own = await h.start("own folder");
    const named = await h.start("in the repo", { workdir: "/srv/repo" });
    h.missions.stop(own.id, "Gading");
    h.missions.stop(named.id, "Gading");
    h.tick(6 * 24 * 60 * 60_000);
    h.missions.tick();
    expect(h.removed).toEqual([]);
    h.tick(2 * 24 * 60 * 60_000);
    h.missions.tick();
    await h.settle();
    expect(h.removed).toEqual([own.id]);
    // Not over work nobody committed — which deleting its conversation, a person's own say, does not ask.
    expect(h.keepingUnsaved).toEqual([own.id]);
    h.missions.forget(named.id, "Gading");
    await h.settle();
    expect(h.removed).toEqual([own.id, named.id]);
    expect(h.keepingUnsaved).toEqual([own.id]);
  });
});

describe("an ended mission's folder, with the disk low", () => {
  test("goes an hour after it ended, oldest first — only its own, and not over work nobody committed", async () => {
    // Sixteen ended missions' folders held 1.9 GB on the live box; a Box on a small eMMC cannot keep a week.
    let freeMb: number | null = null;
    const h = await missionsHarness({ settings: { maxRunning: 4, perAgent: 4 }, diskLow: () => freeMb });
    const older = await h.start("older");
    const named = await h.start("in the repo", { workdir: "/srv/repo" });
    h.missions.stop(older.id, "Gading");
    h.missions.stop(named.id, "Gading");
    h.tick(30 * 60_000);
    const newer = await h.start("newer");
    h.missions.stop(newer.id, "Gading");
    h.tick(2 * 60 * 60_000);
    h.missions.tick();
    await h.settle();
    // Room on the disk: a week, as ever.
    expect(h.removed).toEqual([]);
    freeMb = 600;
    h.tick(2 * 60 * 60_000);
    h.missions.tick();
    await h.settle();
    expect(h.removed).toEqual([older.id, newer.id]);
    expect(h.keepingUnsaved).toEqual([older.id, newer.id]);
  });
});

describe("what the missions keep in memory", () => {
  test("goes with a mission that ends — and is not made again by a turn that ends, or a message that comes, after it", async () => {
    // The box's one slot holds the second back while the first is checked (its agent's own does not, since 0.8.11).
    const h = await missionsHarness({ settings: { maxRunning: 1 } });
    const running = await h.start("write it", { checks: ["test -s out.txt"] });
    const queued = await h.start("then this");
    h.setChecks(async () => ({ passed: false, failed: { command: "test -s out.txt", output: "[no output, exit code 1]" } }));
    h.turn(running, {}, () => h.missions.claim(running.id, { kind: "done", summary: "Done.", report: "Wrote it.", files: [] }));
    await h.settle();
    expect(h.missions.tables()).toEqual({ turns: 1, toldQueued: 1, sameCheck: 1, swept: 0 });
    h.missions.stop(queued.id, "Gading");
    h.missions.stop(running.id, "Gading");
    expect(h.missions.tables()).toEqual({ turns: 0, toldQueued: 0, sameCheck: 0, swept: 0 });
    h.missions.turnEnded(running.id, { toolCalls: 1, worked: 1, tokens: 10, failed: false, interrupted: false, readOutside: false });
    expect(h.missions.tables().turns).toBe(0);
    h.missions.shapeFor("nova", h.queued.filter((one) => one.chatId === running.id).at(-1)!);
    expect(h.missions.tables().turns).toBe(0);
  });

  test("a folder swept is let go once the sweep's window has passed it", async () => {
    const h = await missionsHarness();
    const mission = await h.start();
    h.missions.stop(mission.id, "Gading");
    h.tick(8 * 24 * 60 * 60_000);
    h.missions.tick();
    expect(h.missions.tables().swept).toBe(1);
    h.tick(31 * 24 * 60 * 60_000);
    h.missions.tick();
    expect(h.missions.tables().swept).toBe(0);
  });
});

describe("an asleep agent's missions", () => {
  test("wait, marked asleep, and start when it wakes; a running one goes on from its page", async () => {
    const h = await missionsHarness({ settings: { perAgent: 2 } });
    const running = await h.start("the first");
    h.asleep.add("nova");
    const waiting = await h.start("the second");
    expect(h.store.get(waiting.id)!.status).toBe("queued");
    expect(h.told.find((one) => one.mission === waiting.id)!.text).toContain("nova is asleep");
    h.turn(running);
    h.queued.length = 0;
    h.asleep.delete("nova");
    h.missions.woke("nova");
    await h.settle();
    expect(h.store.get(waiting.id)!.status).toBe("running");
    expect(h.queued.map((one) => one.text)).toContain("the agent was asleep and has woken. Carry on from the page.");
  });
});

/**
 * `mission` start said only "queued — it starts when a slot is free" (0.8.7): not why, nor what held the slot. What
 * it says now is the dispatcher's own reason (`blockedBy`), the one the queue notice gives the chat.
 */
describe("the tool's answer to a start", () => {
  const ctx = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142", senderId: "8142" } as ToolContext;
  // Started at once, as the person asked: a draft waits for nothing but them (0.8.11).
  const atOnce = { now: true, said: "do it now" };

  test("queued, it names the reason and what holds the slot, as the dispatcher decided it", async () => {
    const h = await missionsHarness();
    const first = await h.start("one");
    const tool = createMissionTools(h.missions).chat;
    const answer = await tool.execute({ action: "start", goal: "two", ...atOnce }, ctx);
    expect(answer.isError).toBe(false);
    expect(answer.content).toContain(`It waits because nova already runs ${first.id.slice(0, 10)} (per_agent 1); it starts by itself once that clears.`);
    const queued = h.store.recent(5).find((one) => one.goal === "two")!;
    // The same words the queue notice gave the chat — one decision, said twice.
    expect(h.told.find((one) => one.mission === queued.id)!.text).toBe(`⏳ Mission ${queued.id.slice(0, 10)} is queued: nova already runs ${first.id.slice(0, 10)} (per_agent 1). It starts by itself.`);
  });

  test("an agent's own per_agent (0.8.11): nox at three runs three and queues its fourth; nova keeps the daemon's one", async () => {
    // Three or four missions at once were wanted, set per agent; the setting was the box's alone.
    const h = await missionsHarness({ settings: { maxRunning: 8, slotsOf: (agentId) => (agentId === "nox" ? 3 : 1) } });
    const nox = [await h.start("one", { agentId: "nox" }), await h.start("two", { agentId: "nox" }), await h.start("three", { agentId: "nox" })];
    expect(nox.map((one) => h.store.get(one.id)!.status)).toEqual(["running", "running", "running"]);
    const fourth = await h.start("four", { agentId: "nox" });
    expect(h.store.get(fourth.id)!.status).toBe("queued");
    expect(h.told.find((one) => one.mission === fourth.id)!.text).toContain(`(per_agent 3). It starts by itself.`);
    const first = await h.start("five");
    const second = await h.start("six");
    expect([h.store.get(first.id)!.status, h.store.get(second.id)!.status]).toEqual(["running", "queued"]);
    expect(h.told.find((one) => one.mission === second.id)!.text).toContain(`nova already runs ${first.id.slice(0, 10)} (per_agent 1)`);
  });

  test("queued behind the box's limit, it names the missions running and max_running", async () => {
    const h = await missionsHarness({ settings: { maxRunning: 1 } });
    const first = await h.start("one");
    const answer = await createMissionTools(h.missions).chat.execute({ action: "start", goal: "two", agent: "nox", ...atOnce }, ctx);
    expect(answer.content).toContain(`It waits because the box already runs ${first.id.slice(0, 10)} (max_running 1);`);
  });

  test("started at once, it says nothing about waiting", async () => {
    const h = await missionsHarness();
    const answer = await createMissionTools(h.missions).chat.execute({ action: "start", goal: "one", ...atOnce }, ctx);
    expect(answer.content).toStartWith("Mission ");
    expect(answer.content).not.toContain("It waits because");
  });

  test("a branch git refuses refuses the start, and nothing is made", async () => {
    const asked: string[] = [];
    const h = await missionsHarness({ branchRefusal: async ({ branch }) => (asked.push(branch), branch === "main" ? "main already exists in /srv/repo" : null) });
    const tool = createMissionTools(h.missions).chat;
    const refused = await tool.execute({ action: "start", goal: "one", workdir: "/srv/repo", branch: "main" }, ctx);
    expect(refused).toEqual({ content: "main already exists in /srv/repo", isError: true });
    expect(h.store.recent(5)).toHaveLength(0);
    const taken = await tool.execute({ action: "start", goal: "one", workdir: "/srv/repo", branch: "feat/x" }, ctx);
    expect(taken.isError).toBe(false);
    expect(h.store.recent(5)[0]!.branch).toBe("feat/x");
    expect(asked).toEqual(["main", "feat/x"]);
  });

  test("a goal too long points at a file the caller writes first, not notes that do not exist yet", async () => {
    const h = await missionsHarness();
    const answer = await createMissionTools(h.missions).chat.execute({ action: "start", goal: "x".repeat(5000) }, ctx);
    expect(answer.isError).toBe(true);
    expect(answer.content).toContain("write the detail to a brief file first (in English, and whole, as the goal is) and name its absolute path in the goal");
    expect(answer.content).not.toContain("notes");
  });
});

describe("an agent's missions, for its status (0.8.15)", () => {
  test("at work: queued, running, checking, or trying its model again by itself; waiting for a person: the rest; an approval, ended, or another agent's: neither", async () => {
    const h = await missionsHarness({ agents: ["nova", "nox"] });
    const set = (mission: Mission, status: Mission["status"], waitKind: Mission["waitKind"] = null) => h.store.save({ ...h.store.get(mission.id)!, status, waitKind });
    const first = await h.start("one");
    const second = await h.start("two");
    await h.start("three", { agentId: "nox" });
    set(first, "running");
    set(second, "checking");
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 2, waiting: 0 });
    set(second, "waiting", "input");
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 1, waiting: 1 });
    set(second, "waiting", "retry");
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 2, waiting: 0 });
    set(second, "waiting", "approval");
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 1, waiting: 0 });
    set(second, "waiting", "accept");
    set(first, "done");
    expect(h.missions.forStatus("nova")).toEqual({ atWork: 0, waiting: 1 });
    expect(h.missions.forStatus("nox")).toEqual({ atWork: 1, waiting: 0 });
  });
});
