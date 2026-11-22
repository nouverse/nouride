/**
 * Several at the same time on the Automations page: the step picked from the "+", each of the steps it starts written
 * in its card (what to ask or a command, a name, one more, one fewer), what a save sends, and a run drawn with how
 * each of them went under the name its words were joined by.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep, JobRunSummary } from "@nouride/wire";
import { answer, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { STEPS, TWO_AGENTS, addStep, automation, barButton, detail, flowDrawn, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const parts = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-together] > li")];
const tab = (part: HTMLElement, label: string) => [...part.querySelectorAll<HTMLElement>('[role="tab"]')].find((one) => one.textContent === label)!;
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent?.trim() === label)!;

describe("several at the same time, written in its card", () => {
  test("picked from the plus it starts with two to write; each is what to ask or a command, one more can be added up to five, and none taken below two", async () => {
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: STEPS } })), ...TWO_AGENTS });
    const seen = { began: -1, lacks: "", kinds: [] as string[], removable: [] as boolean[], more: false, full: false, after: -1, title: "" };
    let sent: { path: string; body: unknown }[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await addStep(host, "Add a step at the end", "Several at the same time");
      await eventually(() => parts(host).length === 2, 2_000, "the two to write");
      seen.began = parts(host).length;
      seen.lacks = saveBar(host)?.textContent ?? "";
      seen.kinds = [...parts(host)[0]!.querySelectorAll('[role="tab"]')].map((one) => one.textContent ?? "");
      // At two, neither can be removed: fewer is a step alone.
      seen.removable = parts(host).map((part) => !(part.querySelector('[aria-label^="Remove number"]') as HTMLButtonElement).disabled);
      type(parts(host)[0]!.querySelector("textarea") as HTMLTextAreaElement, "Read the news.");
      tab(parts(host)[1]!, "Run a script").click();
      await eventually(() => parts(host)[1]!.querySelector("input.font-mono") !== null, 2_000, "the command's field");
      type(parts(host)[1]!.querySelector("input.font-mono") as HTMLInputElement, "ls reports");
      type(parts(host)[1]!.querySelector('input[placeholder="News"]') as HTMLInputElement, "Reports");
      // One more, up to five.
      for (let count = 3; count <= 5; count += 1) {
        button(host, "Add another").click();
        await eventually(() => parts(host).length === count, 2_000, `${count} of them`);
      }
      seen.full = button(host, "Add another").disabled;
      // And fewer again, by the one that is taken out: down to three, the third one that was added here.
      for (let count = 4; count >= 3; count -= 1) {
        (host.querySelector(`[aria-label="Remove number ${count + 1}"]`) as HTMLButtonElement).click();
        await eventually(() => parts(host).length === count, 2_000, `${count} left`);
      }
      tab(parts(host)[2]!, "Run a script").click();
      await eventually(() => parts(host)[2]!.querySelector("input.font-mono") !== null, 2_000, "the third's command field");
      type(parts(host)[2]!.querySelector("input.font-mono") as HTMLInputElement, "date");
      seen.after = parts(host).length;
      seen.more = !button(host, "Add another").disabled;
      seen.title = stepCard(host, "s5").textContent ?? "";
      const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
      await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
      barButton(host, "Save")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(seen.began).toBe(2);
    expect(seen.lacks).toContain("Step 5: Write what each of them does: what to ask, or the command to run.");
    expect(seen.kinds).toEqual(["Ask an agent", "Run a script"]);
    expect(seen.removable).toEqual([false, false]);
    expect([seen.full, seen.after, seen.more]).toEqual([true, 3, true]);
    expect(seen.title).toStartWith("3 at the same time");
    const steps = (sent[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps;
    expect(steps.at(-1)).toEqual({
      id: "s5",
      kind: "parallel",
      // One added here is named as the two it began with are: by its step's id and its place.
      steps: [{ id: "s5-1", kind: "agentTurn", message: "Read the news." }, { id: "s5-2", name: "Reports", kind: "command", argv: ["sh", "-lc", "ls reports"] }, { id: "s5-3", kind: "command", argv: ["sh", "-lc", "date"] }],
    });
  });
});

describe("a run of several at the same time", () => {
  const ROUND: AutomationStep[] = [
    { id: "ask", kind: "parallel", steps: [{ id: "ask-1", name: "News", kind: "agentTurn", message: "Read the news.", agentId: "nix" }, { id: "ask-2", kind: "command", argv: ["sh", "-lc", "ls reports"] }, { id: "ask-3", kind: "agentTurn", message: "Read the calendar." }, { id: "ask-4", kind: "agentTurn", message: "Read the mail.", agentId: "nix" }] },
    { id: "sum", kind: "agentTurn", message: "Write the note." },
  ];
  const run: JobRunSummary = {
    id: "run_1",
    jobId: "cron_e",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 50_000,
    status: "error",
    result: "step 1 of 2, 3 steps at the same time failed: News: the model refused",
    steps: [
      {
        id: "ask",
        kind: "parallel",
        status: "failed",
        said: "News: the model refused",
        startedAt: 1,
        ms: 8_000,
        parts: [
          { id: "ask-1", kind: "agentTurn", status: "failed", said: "the model refused", startedAt: 1, ms: 2_100 },
          { id: "ask-2", kind: "command", status: "done", said: "march.pdf\napril.pdf", startedAt: 1, ms: 300 },
          { id: "ask-3", kind: "agentTurn", status: "empty", said: "had nothing to report", startedAt: 1, ms: 4_000 },
          { id: "ask-4", kind: "agentTurn", status: "done", said: "Two letters.", startedAt: 1, ms: 5_000 },
        ],
      },
    ],
  };

  test("says how each of them went under the name its words were joined by, and does not say their words a second time", async () => {
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: ROUND } }), [run]), ...TWO_AGENTS });
    const seen = { rows: [] as string[][], mono: [] as boolean[], chip: "", why: -1, reached: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 2);
      // A run that is over is read on its own tab.
      ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((one) => one.textContent === "Last run") as HTMLElement).click();
      await eventually(() => stepCard(host, "ask")?.querySelector("[data-run-parts]") !== null, 2_000, "the run's parts");
      const card = stepCard(host, "ask");
      const rows = [...card.querySelectorAll<HTMLElement>("[data-run-parts] > li")];
      seen.rows = rows.map((row) => [row.querySelector("span")?.textContent ?? "", row.querySelector("[data-tone]")?.textContent ?? "", row.querySelector("p")?.textContent ?? ""]);
      seen.mono = rows.map((row) => row.querySelector("p")?.getAttribute("class")?.includes("font-mono") === true);
      seen.chip = card.querySelector("[data-tone]")?.textContent ?? "";
      seen.why = card.querySelectorAll("details").length;
      seen.reached = stepCard(host, "sum").textContent ?? "";
    });
    expect(seen.rows).toEqual([
      ["News", "Failed after 2.1 s", "the model refused"],
      ["ls reports", "Done in 0.3 s", "march.pdf\napril.pdf"],
      // Left unsaid, the agent is the automation's own, by its name.
      ["Nouva", "Nothing to say", "had nothing to report"],
      // Another agent's, by what it is called.
      ["Nix", "Done in 5.0 s", "Two letters."],
    ]);
    // A command's words are in the mono face, an agent's are not.
    expect(seen.mono).toEqual([false, true, false, false]);
    expect(seen.chip).toBe("Failed after 8.0 s");
    // No "Why" under them: each one's reason is on its own row.
    expect(seen.why).toBe(0);
    expect(seen.reached).toContain("Not reached in this run");
  });
});
