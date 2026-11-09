/**
 * Ephemeral helpers: in the foreground, run in parallel; in the background, a job each.
 *
 * The distinction that shapes this: a *permanent* agent is a persona someone wrote, with memory and
 * conversations. A *subagent* is a blank one, spawned to do one thing and discarded. It inherits
 * everything about what its parent may do — tools, policy, grants, model — and nothing about who the
 * parent is.
 *
 * In the foreground, parallelism is the point, so the test that matters most is the one proving they actually
 * overlap. In the background, it is that the turn ends at once — and that what was refused says what to do instead.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { createDelegateTool, helperRole, type BackgroundStart, type HelperView, type SubagentRequest } from "@/modules/tools/builtins/delegate.ts";
import { parseBriefs, renderBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import { filesNamedIn } from "@/modules/pipeline/background-helper.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { FOREGROUND_WAIT_MS, waitingForm, type MovableRun, type Moved } from "@/modules/tools/builtins/wait-then-move.ts";
import { eventually, sleep } from "../wait.ts";

/**
 * What a subagent hands back. `runSubagent` derives these with `buildHandoff`; a test states one.
 *
 * `agentId` is the *parent's* id, because that is who a subagent runs as — see `handoff.test.ts` for
 * the derivation itself, which is where the status rules are pinned.
 */
function handoff(summary: string, over: Partial<SubAgentHandoff> = {}): SubAgentHandoff {
  return {
    agentId: "nouva",
    status: "success",
    summary,
    files: [],
    spills: [],
    metrics: { toolCalls: 1, steps: 1, ms: 100 },
    ...over,
  };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "ses_1",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    workspaceRoots: ["/tmp"],
    signal: new AbortController().signal,
    ...over,
  } as ToolContext;
}

/** A brief for `goal` with the parts a helper needs — what most of these tests are not about. */
const task = (goal: string) => ({ goal, context: "The logs are in /var/log/app.", deliverable: "What you found, with paths." });

describe("delegate in the foreground", () => {
  test("runs every task and returns all the answers", async () => {
    const tool = createDelegateTool({
      run: async ({ brief }) => handoff(`did: ${brief.goal}`),
    });

    const result = await tool.execute({ tasks: [task("check logs"), task("check disk")] }, ctx());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("did: check logs");
    expect(result.content).toContain("did: check disk");
    expect(result.metadata).toMatchObject({ tasks: 2, failed: 0, toolCalls: 2 });
    // The turn waits for these, so nothing asks it to end.
    expect(result.metadata?.control).toBeUndefined();
  });

  test("they actually run at the same time", async () => {
    // The entire reason this exists. Sequential execution would make it a loop the model could have
    // written itself.
    let running = 0;
    let peak = 0;
    const tool = createDelegateTool({
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(60);
        running -= 1;
        return handoff("ok");
      },
    });

    const started = Date.now();
    await tool.execute({ tasks: [task("a"), task("b"), task("c")] }, ctx());

    expect(peak).toBe(3);
    // Three 60ms tasks in well under 180ms.
    expect(Date.now() - started).toBeLessThan(150);
  });

  test("one failure does not lose the others", async () => {
    const tool = createDelegateTool({
      run: async ({ brief }) => {
        if (brief.goal === "bad") throw new Error("that host is unreachable");
        return handoff(`fine: ${brief.goal}`);
      },
    });

    const result = await tool.execute({ tasks: [task("good"), task("bad")] }, ctx());

    // Three of four answering is a batch the model can still work with; flagging the whole thing as
    // failed would invite it to throw away the answers it did get.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("fine: good");
    expect(result.content).toContain("that host is unreachable");
    expect(result.metadata).toMatchObject({ failed: 1 });
  });

  test("everything failing is a failure", async () => {
    const tool = createDelegateTool({
      run: async () => {
        throw new Error("provider is down");
      },
    });
    expect(await tool.execute({ tasks: [task("a"), task("b")] }, ctx())).toMatchObject({ isError: true });
  });

  test("the helper is handed its brief, and nothing else about the conversation", async () => {
    // A subagent starts with no memory of the conversation, so the brief has to carry
    // everything — the tool description says so, and this is the shape that makes it true.
    const seen: SubagentRequest[] = [];
    const tool = createDelegateTool({
      run: async (request) => {
        seen.push(request);
        return handoff("ok");
      },
    });

    await tool.execute({ tasks: [{ goal: "summarize the hosts file", context: "It is /etc/hosts on this machine.", constraints: "Read only.", deliverable: "One line per host." }] }, ctx());

    expect(seen[0]?.brief).toEqual({ goal: "summarize the hosts file", context: "It is /etc/hosts on this machine.", constraints: "Read only.", deliverable: "One line per host." });
    // It carries the parent's identity, which is what makes grants and approvals inherit.
    expect(seen[0]?.ctx.agentId).toBe("nouva");
    expect(seen[0]?.ctx.signal).toBeDefined();
  });

  test("the fan-out is bounded", async () => {
    // A model that decides to check twenty things would otherwise open twenty provider connections
    // and spend twenty turns' worth of budget in one call.
    const tool = createDelegateTool({ run: async () => handoff("ok") });
    const result = await tool.execute({ tasks: ["a", "b", "c", "d", "e"].map(task) }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("At most");
  });

  test("delegating is not itself gated", async () => {
    // Every tool the helper then calls is gated exactly as it would be in the parent's own turn.
    // Asking about the delegation as well is asking twice for one decision, and the second prompt is
    // the one people stop reading.
    const tool = createDelegateTool({ run: async () => handoff("ok") });
    expect(tool.requiresApproval).toBe(false);
  });
});

describe("a brief", () => {
  test("without context is refused, with what to add", async () => {
    let ran = false;
    const tool = createDelegateTool({
      run: async () => {
        ran = true;
        return handoff("ok");
      },
    });
    for (const context of ["", "   ", "none", "N/A", "-"]) {
      const result = await tool.execute({ tasks: [{ goal: "check the NAS", context, deliverable: "its health" }] }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("`context` is empty");
      // What to add, not only that it is missing.
      expect(result.content).toContain("paths, hosts or repositories involved");
      expect(result.content).toContain("what has been tried");
    }
    expect(ran).toBe(false);
  });

  test("a single string is refused with the shape it should have", async () => {
    const tool = createDelegateTool({ run: async () => handoff("ok") });
    const result = await tool.execute({ tasks: ["read /etc/hosts and summarize"] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('{"goal", "context", "constraints", "deliverable"}');
    expect(result.content).toContain("written in English");
  });

  test("names the part that is missing, by position", () => {
    expect(parseBriefs([], 4)).toMatchObject({ error: expect.stringContaining("non-empty array") });
    expect(parseBriefs("go", 4)).toMatchObject({ error: expect.stringContaining("non-empty array") });
    expect(parseBriefs([task("a"), { context: "x", deliverable: "y" }], 4)).toMatchObject({ error: expect.stringContaining("Task 2 has no `goal`") });
    expect(parseBriefs([{ goal: "a", context: "x" }], 4)).toMatchObject({ error: expect.stringContaining("Task 1 has no `deliverable`") });
    expect(parseBriefs([{ goal: "a", context: "x".repeat(6_000), deliverable: "y" }], 4)).toMatchObject({ error: expect.stringContaining("name its path") });
  });

  test("reaches the helper as its parts under their names, constraints only when given", () => {
    const text = renderBrief({ goal: "Find broken links", context: "Site in /srv/docs.", deliverable: "A list." });
    expect(text).toBe("GOAL\nFind broken links\n\nCONTEXT\nSite in /srv/docs.\n\nDELIVERABLE\nA list.");
    expect(renderBrief({ goal: "g", context: "c", constraints: "Read only.", deliverable: "d" })).toContain("CONSTRAINTS\nRead only.");
  });
});

describe("what the daemon adds to a brief", () => {
  test("a file of the conversation the brief names, with where it is — only those the helper's sandbox opens", () => {
    const root = "/data/attachments/nouva/telegram_main_chat-1";
    const files = [
      { name: "invoice-q3.pdf", localPath: `${root}/2026-10-18/01-invoice-q3.pdf` },
      { name: "photo.jpg", localPath: `${root}/2026-10-18/01-photo.jpg` },
      // Another agent's copy, outside this agent's directory for the chat: named, and still not listed.
      { name: "notes.txt", localPath: "/data/attachments/nox/telegram_main_chat-1/2026-10-18/01-notes.txt" },
      { name: "a.md" },
    ];
    const brief = { goal: "Total the invoice", context: "The person sent invoice-q3.pdf and notes.txt earlier.", deliverable: "The total." };
    expect(filesNamedIn(brief, files, root)).toEqual([`FILES FROM THE CONVERSATION\n- invoice-q3.pdf: ${root}/2026-10-18/01-invoice-q3.pdf`]);
    expect(filesNamedIn({ ...brief, context: "Nothing sent." }, files, root)).toEqual([]);
  });
});

describe("delegate in the background", () => {
  const view = (id: string, goal: string, here = true): HelperView => ({ id, goal, startedAt: Date.now() - 4 * 60_000, here });

  function tool(answers: BackgroundStart[]) {
    const asked: SubagentRequest[] = [];
    let foreground = 0;
    const subject = createDelegateTool({
      run: async () => {
        foreground += 1;
        return handoff("ok");
      },
      background: (request) => {
        asked.push(request);
        return answers[asked.length - 1]!;
      },
    });
    return { subject, asked, foreground: () => foreground };
  }

  test("starts each brief as a job, and asks the turn to end at once", async () => {
    const t = tool([{ started: view("job_a", "Find broken links"), running: [view("job_a", "Find broken links")] }]);
    const result = await t.subject.execute({ tasks: [task("Find broken links")], background: true }, ctx());

    expect(t.foreground()).toBe(0);
    expect(t.asked.map((request) => request.brief.goal)).toEqual(["Find broken links"]);
    expect(result.isError).toBe(false);
    expect(result.metadata?.control).toEqual({ finishTurn: "wrap_up", note: "helper_started" });
    expect(result.content).toContain("Started in the background as job_a");
    expect(result.content).toContain("Your turn ends now");
    expect(result.content).toContain("do not say what it found");
  });

  test("over the limit is refused with what is running — those from another conversation counted, not described", async () => {
    const t = tool([{ refused: "limit", limit: 2, running: [view("job_a", "Find broken links"), view("job_b", "Private thing from another chat", false)] }]);
    const result = await t.subject.execute({ tasks: [task("Check the disks")], background: true }, ctx());

    expect(result.isError).toBe(true);
    expect(result.metadata?.control).toBeUndefined();
    expect(result.content).toContain("`[delegate] max_background = 2`");
    expect(result.content).toContain('job_a "Find broken links" (4m so far)');
    expect(result.content).toContain("1 in another conversation");
    expect(result.content).not.toContain("Private thing");
    // What to do instead: wait, stop one, or the foreground.
    expect(result.content).toContain("Wait for one to finish");
    expect(result.content).toContain("nouride jobs kill <id>");
    expect(result.content).toContain("leave `background` off");
  });

  test("the one over the limit is refused, and the ones that fit still start", async () => {
    const t = tool([
      { started: view("job_a", "First"), running: [view("job_a", "First")] },
      { refused: "limit", limit: 1, running: [view("job_a", "First")] },
    ]);
    const result = await t.subject.execute({ tasks: [task("First"), task("Second")], background: true }, ctx());
    expect(result.isError).toBe(false);
    expect(result.metadata).toMatchObject({ started: ["job_a"], refused: ["limit"], control: { finishTurn: "wrap_up", note: "helper_started" } });
    expect(result.content).toContain('Not started: "Second"');
  });

  test("off, and the same work already running, each say so", async () => {
    const off = await tool([{ refused: "off" }]).subject.execute({ tasks: [task("x")], background: true }, ctx());
    expect(off.content).toContain("`[delegate] max_background = 0`");
    const twin = await tool([{ refused: "duplicate", running: view("job_a", "x") }]).subject.execute({ tasks: [task("x")], background: true }, ctx());
    expect(twin.content).toContain("already running as job_a");
  });

  test("a process with no background helpers says to use the foreground", async () => {
    const subject = createDelegateTool({ run: async () => handoff("ok") });
    const result = await subject.execute({ tasks: [task("x")], background: true }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Leave `background` off");
  });
});

describe("delegate in the foreground, waited on for 45 seconds", () => {
  test("the wait comes back well inside the minute an external agent's MCP client gives one call", () => {
    // Found live: a Claude Code agent's call to `delegate` was given up by its CLI at 60 s, the same moment the wait
    // ended, and the agent read "The operation timed out." where the tool said its helper had moved. 60 s is the MCP
    // clients' default; ten seconds of room covers the move and the answer's way back.
    expect(FOREGROUND_WAIT_MS).toBeLessThanOrEqual(60_000 - 10_000);
  });

  /** A helper that answers when `finish` is called, or never — and moves when asked, the way `start` answers. */
  function helper(moveTo: Moved) {
    let finish: (summary: string) => void = () => {};
    let detached = 0;
    const run: MovableRun = {
      answer: new Promise<SubAgentHandoff>((resolve) => (finish = (summary) => resolve(handoff(summary)))),
      detach: () => ((detached += 1), moveTo),
    };
    return { run, finish: (summary: string) => finish(summary), detached: () => detached };
  }

  function tool(helpers: Record<string, ReturnType<typeof helper>>, waitMs = 30) {
    let ran = 0;
    const subject = createDelegateTool({
      run: async () => ((ran += 1), handoff("waited for")),
      start: ({ brief }) => helpers[brief.goal]!.run,
      waitMs,
    });
    return { subject, ran: () => ran };
  }

  test("a helper that answers inside the wait is answered in the turn, and nothing moves", async () => {
    const quick = helper({ job: "job_never" });
    const t = tool({ "Check the disks": quick });
    const result = t.subject.execute({ tasks: [task("Check the disks")] }, ctx());
    quick.finish("The disks are fine.");
    const said = await result;
    expect(said.content).toContain("The disks are fine.");
    expect(quick.detached()).toBe(0);
    expect(said.metadata?.control).toBeUndefined();
    expect(said.metadata?.moved).toBeUndefined();
    expect(t.ran()).toBe(0);
  });

  test("one still working after the wait moves; the agent is told which answered, which moved, and where the result will come from", async () => {
    const quick = helper({ answered: true });
    const slow = helper({ job: "job_slow" });
    const t = tool({ "Check the disks": quick, "Rebuild the index": slow });
    const result = t.subject.execute({ tasks: [task("Check the disks"), task("Rebuild the index")] }, ctx());
    quick.finish("The disks are fine.");
    const said = await result;

    expect(slow.detached()).toBe(1);
    expect(said.isError).toBe(false);
    expect(said.content).toContain("── task 1: Check the disks\n[nouva · success]\nThe disks are fine.");
    expect(said.content).toContain("── task 2: Rebuild the index\nStill working after 30ms, now in the background as job_slow.");
    expect(said.content).toContain('Still working, now in the background: job_slow "Rebuild the index".');
    expect(said.content).toContain(
      "Your turn ends now, so the person can talk to you meanwhile. Each result comes to you as a message of its own when that helper finishes: you have not seen it, so do not say what it will find.",
    );
    expect(said.content).toContain("Tell the person what the helpers that answered found, and that the rest is still being worked on and you will report it when it comes.");
    expect(said.content).toContain("Stop one with `nouride jobs kill <id>` if the person asks.");
    // The turn ends, as one that started a helper in the background does.
    expect(said.metadata).toMatchObject({ tasks: 2, failed: 0, statuses: ["success", "background"], moved: ["job_slow"], control: { finishTurn: "wrap_up", note: "helper_moved" } });
  });

  test("with no room to move, it stays: waited for to the end, and the answer says why it took so long", async () => {
    const full = helper({ refused: { why: "limit", limit: 2, running: [{ id: "job_a", goal: "a", startedAt: Date.now(), here: true }, { id: "job_b", goal: "b", startedAt: Date.now(), here: true }] } });
    const broke = helper({ refused: { why: "unavailable", reason: "Today's spending limit for this agent has been reached." } });
    const t = tool({ "Rebuild the index": full, "Check the disks": broke });
    const result = t.subject.execute({ tasks: [task("Rebuild the index"), task("Check the disks")] }, ctx());
    // Both still at work when the wait runs out: each asked to move, each refused — and the call waits on.
    await eventually(() => full.detached() === 1 && broke.detached() === 1, 2_000, "the moves tried");
    full.finish("The index is rebuilt.");
    broke.finish("The disks are fine.");
    const said = await result;

    // Each under its own task, after its answer.
    const [first, second] = said.content.split("\n\n── task 2: ");
    expect(first).toContain("The index is rebuilt.");
    expect(first).toEndWith(
      "\n(This took longer than 30ms and stayed in the foreground: you already have 2 jobs working in the background (helpers and asks), the most this agent may have (`[delegate] max_background = 2`).)",
    );
    expect(second).toContain("The disks are fine.");
    expect(second).toEndWith("\n(This took longer than 30ms and stayed in the foreground: Today's spending limit for this agent has been reached.)");
    expect(said.metadata?.control).toBeUndefined();
    expect(said.content).not.toContain("now in the background");
  });

  test("a turn that may hold nothing in the background is offered the form that waits: no `background`, nothing moves", async () => {
    const slow = helper({ job: "job_slow" });
    const t = tool({ "Rebuild the index": slow });
    const waiting = waitingForm(t.subject);
    expect(waiting).not.toBe(t.subject);
    expect(Object.keys((waiting.definition.parameters as { properties: object }).properties)).toEqual(["tasks", "tier", "isolated"]);
    expect(t.subject.definition.description).toContain("Without `background` it is for quick questions: you wait up to 45 seconds, then a helper still working moves to the background.");
    expect(waiting.definition.description).not.toContain("45 seconds");
    // Asked for the background anyway, it waits for its helper to the end.
    const said = await waiting.execute({ tasks: [task("Rebuild the index")], background: true }, ctx());
    expect(said.content).toContain("waited for");
    expect(t.ran()).toBe(1);
    expect(slow.detached()).toBe(0);
  });

  test("the `background` parameter says what it is for, and what happens without it", () => {
    const tool = createDelegateTool({ run: async () => handoff("ok") });
    const background = (tool.definition.parameters as { properties: Record<string, { description: string }> }).properties.background!.description;
    expect(background).toStartWith("For work you know takes more than 45 seconds: each brief becomes a helper job, your turn ends now");
    expect(background).toEndWith("Off: you wait up to 45 seconds, then the same for any still working.");
  });
});

describe("the helper's role", () => {
  test("says it works from a brief, hands back the deliverable in English, writes no memory and stops at a refusal", () => {
    for (const background of [false, true]) {
      const role = helperRole({ background });
      expect(role).toContain("GOAL, CONTEXT, CONSTRAINTS, DELIVERABLE");
      expect(role).toContain("exactly what DELIVERABLE asks for, in English");
      expect(role).toContain("You cannot write memory or record people");
      expect(role).toContain("If a call you need is refused or not approved, stop there");
    }
    expect(helperRole({ background: true })).toContain("You work in the background");
    expect(helperRole({ background: false })).not.toContain("You work in the background");
  });

  test("says its commands run in the foreground, and how long one may wait — longer in the background", () => {
    const behind = helperRole({ background: true });
    expect(behind).toContain("Every command you run is in the foreground and you read what it prints");
    expect(behind).toContain("may\nrun up to thirty minutes: give it `timeout_ms`");
    const waited = helperRole({ background: false });
    expect(waited).toContain("Every command you run is in the foreground, up to four minutes each");
    expect(waited).not.toContain("thirty minutes");
  });
});

describe("delegate, isolated (0.8.1)", () => {
  test("each helper is told its own worktree and branch, and the result names the branches to merge", async () => {
    const seen: SubagentRequest[] = [];
    let n = 0;
    const tool = createDelegateTool({
      run: async (request) => (seen.push(request), handoff("Done.")),
      isolate: async () => ((n += 1), { path: `/work/missions/m1/helpers/${n}`, branch: `mission/m1-helper-${n}` }),
    });
    const result = await tool.execute({ tasks: [task("Fix the parser"), task("Add the tests")], isolated: true }, ctx({ gatewayId: "web:mission", chatId: "m1" }));
    expect(seen.map((request) => request.brief.context)).toEqual([
      "The logs are in /var/log/app.\n\nWork in /work/missions/m1/helpers/1, a worktree of the mission's repository, on the branch mission/m1-helper-1. Commit your work there; the mission merges it.",
      "The logs are in /var/log/app.\n\nWork in /work/missions/m1/helpers/2, a worktree of the mission's repository, on the branch mission/m1-helper-2. Commit your work there; the mission merges it.",
    ]);
    expect(seen[0]!.brief.constraints).toBe("Change nothing outside /work/missions/m1/helpers/1.");
    expect(result.content).toEndWith("Each helper's work is on its own branch (task 1: mission/m1-helper-1, task 2: mission/m1-helper-2). Merge the ones you keep into the mission's branch, in the mission's folder.");
  });

  test("is refused where a worktree cannot be had, and nothing runs", async () => {
    const seen: SubagentRequest[] = [];
    const refusing = createDelegateTool({ run: async (request) => (seen.push(request), handoff("Done.")), isolate: async () => ({ refused: "this mission works in its folder" }) });
    expect(await refusing.execute({ tasks: [task("Fix it")], isolated: true }, ctx())).toEqual({ content: "this mission works in its folder", isError: true });
    const without = createDelegateTool({ run: async (request) => (seen.push(request), handoff("Done.")) });
    expect((await without.execute({ tasks: [task("Fix it")], isolated: true }, ctx())).isError).toBe(true);
    expect(seen).toEqual([]);
  });
});
