/**
 * A script an automation keeps, on its page: read in words before its text, by what it is said to do and what is known
 * of it without reading it; its text behind a button; run once to be seen, on what the step before it said; written
 * from a one-line command; and held to what the server takes before Save offers to send it. Through the whole app.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep, JobRunSummary } from "@nouride/wire";
import { stepProblems } from "@/modules/automations/lib/steps";
import { answer, dropdown, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, TWO_AGENTS, automation, barButton, detail, editStep, field, flowDrawn, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const TEXT = 'import sys\n\nsummary = sys.stdin.read().strip()\nprint(f"saved {len(summary)} characters")\n';
const SUM: AutomationStep = { id: "sum", kind: "agentTurn", message: "Sum up my unread email in four points." };
const SAVE: AutomationStep = { id: "save", kind: "command", argv: ["python3"], script: { text: TEXT, about: "Saves the summary as today's page.", by: "agent:nix", secrets: ["notes_key"] } };
const TELL: AutomationStep = { id: "tell", kind: "systemEvent", text: "The summary is saved." };
const RAN: JobRunSummary = {
  id: "run_1",
  jobId: "cron_e",
  startedAt: 1,
  finishedAt: 2,
  status: "success",
  result: "The summary is saved.",
  steps: [
    { id: "sum", kind: "agentTurn", status: "done", startedAt: 1, ms: 900, said: "1. An invoice.\n2. Two newsletters." },
    { id: "save", kind: "command", status: "done", startedAt: 1, ms: 40, said: "saved 34 characters" },
  ],
};
const shown = (steps: AutomationStep[] = [SUM, SAVE, TELL], runs: JobRunSummary[] = []) => answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps } }), runs), ...TWO_AGENTS });
const pressed = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("main button")].find((button) => button.textContent?.trim() === label);
const chips = (host: HTMLElement) => [...host.querySelectorAll('main [aria-label="About this script"] li')].map((chip) => chip.textContent ?? "");
const text = (host: HTMLElement) => [...host.querySelectorAll<HTMLTextAreaElement>("main textarea")].find((area) => area.getAttribute("class")?.includes("font-mono")) ?? null;

async function saved(host: HTMLElement): Promise<{ path: string; body: unknown }[]> {
  const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
  await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
  barButton(host, "Save")!.click();
  await eventually(() => record.posts.length > 0, 2_000, "the save");
  record.restore();
  return record.posts;
}
const steps = (posts: { path: string; body: unknown }[]) => (posts[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps;

describe("a script step, read", () => {
  test("its box is called by what it does and says who wrote it; its fields say what is known of it, and its text stays behind a button", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { box: "", about: "", chips: [] as string[], hidden: false, asks: [] as string[], words: [] as string[], text: "", written: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      seen.box = stepCard(host, "save").textContent ?? "";
      editStep(host, 2).click();
      await eventually(() => chips(host).length > 0, 2_000, "what is known of it");
      seen.about = field(host, "What it does").value;
      seen.chips = chips(host);
      seen.hidden = text(host) === null;
      // Its own ask, named apart from the page's at its head.
      seen.asks = [...host.querySelectorAll<HTMLElement>('main button[title^="Ask Nouva"]')].map((button) => button.getAttribute("title") ?? "");
      seen.words = [...host.querySelectorAll<HTMLElement>('main button[title^="Ask Nouva"]')].map((button) => button.textContent ?? "");
      pressed(host, "Show the script")!.click();
      await eventually(() => text(host) !== null, 2_000, "its text");
      seen.text = text(host)!.value;
      seen.written = dropdown(host, "Written in").holds();
      type(field(host, "What it does"), "Saves the summary to the notes page.");
      sent = await saved(host);
    });
    // Its words, and what a failure does, which every box that can fail says.
    expect(seen.box).toBe("Saves the summary as today's page.A script Nix wrote · no AIIf it fails, the run ends, and its chat is told why.");
    expect(seen.about).toBe("Saves the summary as today's page.");
    expect(seen.chips).toEqual(["Written by Nix", "Python, 4 lines", "No AI", "Uses your saved key: notes_key"]);
    expect(seen.hidden).toBe(true);
    expect(seen.asks).toEqual(["Ask Nouva to change it", "Ask Nouva to change this script"]);
    // In a step's fields its words are whole at every width: on a phone the page's own, in its head, says "Ask Nouva"
    // alone, and two of those said nothing of which asks what.
    expect(seen.words).toEqual(["Ask NouvaAsk Nouva to change it", "Ask Nouva to change this script"]);
    expect(seen.text).toBe(TEXT);
    expect(seen.written).toBe("Python");
    // Its text, who wrote it and the keys it is handed go back as they were: only what was typed changed.
    expect(steps(sent)).toEqual([SUM, { ...SAVE, script: { ...SAVE.script!, about: "Saves the summary to the notes page." } }, TELL]);
  });

  test("one a person wrote names no writer; a program the list does not hold is shown as it is, and can still be picked back", async () => {
    shown([SUM, { id: "save", kind: "command", argv: ["deno", "run"], script: { text: "console.log(1)\n", about: "Counts to one.", by: "web:usr_1" } }, TELL]);
    const seen = { box: "", chips: [] as string[], written: "" as string | null, offered: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      seen.box = stepCard(host, "save").textContent ?? "";
      editStep(host, 2).click();
      await eventually(() => chips(host).length > 0, 2_000, "what is known of it");
      seen.chips = chips(host);
      pressed(host, "Show the script")!.click();
      await eventually(() => dropdown(host, "Written in").button() !== undefined, 2_000, "what it is written in");
      seen.written = dropdown(host, "Written in").holds();
      seen.offered = await dropdown(host, "Written in").open();
    });
    expect(seen.box).toBe("Counts to one.A script · no AIIf it fails, the run ends, and its chat is told why.");
    expect(seen.chips).toEqual(["deno run, 1 line", "No AI"]);
    expect(seen.written).toBe("deno run");
    expect(seen.offered).toEqual(["Shell", "Python", "JavaScript (Bun)", "JavaScript (Node)", "deno run"]);
  });
});

describe("a script step, where nothing is changed", () => {
  const read = (host: HTMLElement) => stepCard(host, "save").querySelector<HTMLElement>("[data-script-read]");
  const shownText = (host: HTMLElement) => read(host)?.querySelector("pre")?.textContent ?? null;

  test("one an agent proposed is agreed to by its text: on its page, before it is turned on, what is known of the script and its text behind the button", async () => {
    answer({ [PAGE]: detail(automation({ enabled: false, proposal: { by: "nix", at: 1 }, payload: { kind: "steps", steps: [SUM, SAVE, TELL] } })), ...TWO_AGENTS });
    const seen = { box: "", chips: [] as string[], hidden: false, text: "" as string | null, again: "" as string | null, fields: 0, others: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      await eventually(() => read(host) !== null, 2_000, "the script to read");
      seen.box = stepCard(host, "save").querySelector("[data-box-title]")?.textContent ?? "";
      seen.chips = chips(host);
      seen.hidden = shownText(host) === null;
      pressed(host, "Show the script")!.click();
      await eventually(() => shownText(host) !== null, 2_000, "its text");
      seen.text = shownText(host);
      pressed(host, "Hide the script")!.click();
      await eventually(() => shownText(host) === null, 2_000, "its text hidden");
      seen.again = shownText(host);
      // Read, and nothing of it changed: no field anywhere on the canvas, and no step opens.
      seen.fields = host.querySelectorAll("[data-flow] input, [data-flow] textarea, main [data-step-fields]").length + host.querySelectorAll('main [aria-label^="Edit step"]').length;
      // A step that keeps no script has nothing more to read than its box says.
      seen.others = host.querySelectorAll("[data-script-read]").length;
    });
    expect(seen.box).toBe("Saves the summary as today's page.");
    expect(seen.chips).toEqual(["Written by Nix", "Python, 4 lines", "No AI", "Uses your saved key: notes_key"]);
    expect(seen.hidden).toBe(true);
    expect(seen.text).toBe(TEXT);
    expect(seen.again).toBeNull();
    expect(seen.fields).toBe(0);
    expect(seen.others).toBe(1);
  });

  test("a change an agent suggests is read the same way, as it would be and as it runs now; and an account that only looks reads it too", async () => {
    const NEW = "import sys\nprint('saved, the new way')\n";
    const suggested = automation({ id: "cron_s", enabled: false, proposal: { by: "nix", at: 1, replaces: "cron_e" }, payload: { kind: "steps", steps: [SUM, { ...SAVE, script: { ...SAVE.script!, text: NEW } }, TELL] } });
    answer({ [PAGE]: detail(automation({ suggested: "cron_s", payload: { kind: "steps", steps: [SUM, SAVE, TELL] } }), [], suggested), ...TWO_AGENTS });
    const seen = { would: "" as string | null, mark: "", viewer: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      ([...host.querySelectorAll<HTMLElement>('[aria-label="Suggested change"] button')].find((button) => button.textContent === "Suggested") as HTMLElement).click();
      await eventually(() => read(host) !== null, 2_000, "the script as it would be");
      seen.mark = stepCard(host, "save").textContent ?? "";
      pressed(host, "Show the script")!.click();
      await eventually(() => shownText(host) !== null, 2_000, "its text");
      seen.would = shownText(host);
    });
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: [SUM, SAVE, TELL] } })), ...TWO_AGENTS, ...AS_VIEWER });
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      await eventually(() => read(host) !== null, 2_000, "the script to read");
      pressed(host, "Show the script")!.click();
      await eventually(() => shownText(host) !== null, 2_000, "its text");
      seen.viewer = shownText(host);
    });
    expect(seen.mark).toContain("Would change");
    expect(seen.would).toBe(NEW);
    expect(seen.viewer).toBe(TEXT);
  });
});

describe("a script step, tried", () => {
  const tryIt = async (host: HTMLElement) => {
    editStep(host, 2).click();
    await eventually(() => pressed(host, "Try it") !== undefined, 2_000, "Try it");
    pressed(host, "Try it")!.click();
    await eventually(() => host.querySelector('main [aria-label="Try it"]') !== null, 2_000, "the try");
    return host.querySelector<HTMLElement>('main [aria-label="Try it"]')!;
  };

  test("starts from what the step before it said in the last run, runs once as its agent with the script as it is on the page, and shows what it printed", async () => {
    shown([SUM, SAVE, TELL], [RAN]);
    const record = recordPosts({ "/cron/try": ok({ tried: { status: "done", said: "saved 34 characters", ms: 640 } }) });
    const seen = { given: "", warns: "", result: "", status: "" as string | undefined, bar: true };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host, 3);
        const box = await tryIt(host);
        seen.given = (box.querySelector("textarea") as HTMLTextAreaElement).value;
        seen.warns = box.textContent ?? "";
        pressed(host, "Run it once")!.click();
        await eventually(() => box.querySelector("[data-tried]") !== null, 3_000, "how it went");
        seen.result = box.querySelector("[data-tried]")?.textContent ?? "";
        seen.status = box.querySelector<HTMLElement>("[data-tried]")?.dataset.tried;
        // A try changes nothing of the automation: there is nothing to save.
        seen.bar = saveBar(host) !== null;
      });
    } finally {
      record.restore();
    }
    expect(seen.given).toBe("1. An invoice.\n2. Two newsletters.");
    // Said before it is pressed: it is no rehearsal.
    expect(seen.warns).toContain("It runs for real, once: a script that sends or saves something does so.");
    expect(record.posts).toEqual([{ path: "/cron/try", body: { agentId: "nouva", step: SAVE, input: "1. An invoice.\n2. Two newsletters." } }]);
    expect(seen.status).toBe("done");
    expect(seen.result).toBe("It worked · 0.6 ssaved 34 characters");
    expect(seen.bar).toBe(false);
  });

  test("with nothing to hand it, it is sent nothing; a failure and silence are each said as what they are, and a refusal in the server's words", async () => {
    shown();
    const seen: Record<string, string> = {};
    const bodies: unknown[] = [];
    for (const [name, answered] of [
      ["failed", ok({ tried: { status: "failed", said: "exit 1\nNo such page", ms: 1200 } })],
      ["empty", ok({ tried: { status: "empty", said: "", ms: 300 } })],
      ["refused", { status: 400, body: { error: "python3 is not on this machine", plain: "It could not be tried. Check what the script is written in, and try again." } }],
    ] as const) {
      const record = recordPosts({ "/cron/try": answered });
      try {
        await renderPage(PAGE, async (host) => {
          await flowDrawn(host, 3);
          const box = await tryIt(host);
          pressed(host, "Run it once")!.click();
          await eventually(() => box.querySelector('[data-tried], [role="alert"]') !== null, 3_000, "how it went");
          seen[name] = box.querySelector('[data-tried], [role="alert"]')?.textContent ?? "";
        });
      } finally {
        record.restore();
      }
      bodies.push(record.posts[0]?.body);
    }
    expect(bodies[0]).toEqual({ agentId: "nouva", step: SAVE });
    expect(seen.failed).toBe("It failed · 1.2 sexit 1\nNo such page");
    expect(seen.empty).toBe("It worked, and had nothing to say · 0.3 s");
    expect(seen.refused).toContain("It could not be tried. Check what the script is written in, and try again.");
  });
});

describe("a script step, written", () => {
  test("a one-line command becomes a script that holds that line, opened to be written; Save waits for what it does, and sends the script", async () => {
    shown([{ id: "check", kind: "command", argv: ["sh", "-lc", "curl -sf https://shop.example.com/health"] }, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { text: "", lacks: "", disabled: false, box: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 2);
      editStep(host, 1).click();
      await eventually(() => pressed(host, "Write it as a script instead") !== undefined, 2_000, "the way to a script");
      pressed(host, "Write it as a script instead")!.click();
      // With nothing said of it yet, its text is what there is to read: shown at once.
      await eventually(() => text(host) !== null, 2_000, "its text");
      seen.text = text(host)!.value;
      seen.lacks = saveBar(host)?.textContent ?? "";
      seen.disabled = barButton(host, "Save")?.disabled === true;
      type(field(host, "What it does"), "Checks that the shop answers.");
      type(text(host)!, "curl -sf https://shop.example.com/health\necho ok");
      seen.box = stepCard(host, "check").textContent ?? "";
      sent = await saved(host);
    });
    expect(seen.text).toBe("curl -sf https://shop.example.com/health");
    expect(seen.lacks).toContain("Step 1: Say what the script does, in one line.");
    expect(seen.disabled).toBe(true);
    expect(seen.box).toBe("Checks that the shop answers.A script · no AIIf it fails, the run ends, and its chat is told why.");
    expect(steps(sent)).toEqual([{ id: "check", kind: "command", argv: ["sh"], script: { text: "curl -sf https://shop.example.com/health\necho ok", about: "Checks that the shop answers." } }, TELL]);
  });

  test("the keys it uses are named with a comma between, and sent as the names they are; none named, none sent", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    let cleared: { path: string; body: unknown }[] = [];
    for (const [typed, into] of [["notes_key, mail.key", (posts: typeof sent) => (sent = posts)], ["", (posts: typeof sent) => (cleared = posts)]] as const) {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host, 3);
        editStep(host, 2).click();
        await eventually(() => pressed(host, "Show the script") !== undefined, 2_000, "the script's buttons");
        pressed(host, "Show the script")!.click();
        await eventually(() => text(host) !== null, 2_000, "its text");
        // How a script reads one is said where its name is typed: the name alone would not say it.
        expect(host.querySelector("main [data-step-fields]")?.textContent).toContain("The script reads each by its name in capitals: notes_key is NOTES_KEY.");
        type(field(host, "Saved keys it uses"), typed);
        into(await saved(host));
      });
    }
    expect((steps(sent)[1] as typeof SAVE).script!.secrets).toEqual(["notes_key", "mail.key"]);
    expect("secrets" in (steps(cleared)[1] as typeof SAVE).script!).toBe(false);
  });

  test("what a save would be refused for is said before it is sent: no text, nothing said of it, no program, a key that is no name", () => {
    const script = (over: Record<string, unknown>, argv = ["sh"]): AutomationStep => ({ id: "a", kind: "command", argv, script: { text: "echo ok\n", about: "Says ok.", ...over } });
    const lacks = (step: AutomationStep) => stepProblems([step]).map((problem) => problem.message);
    expect(lacks(script({}))).toEqual([]);
    expect(lacks(script({ secrets: ["notes_key", "mail.key-2"] }))).toEqual([]);
    expect(lacks(script({ text: " \n" }))).toEqual(["Write the script, or ask an agent to write it."]);
    expect(lacks(script({ about: " " }))).toEqual(["Say what the script does, in one line."]);
    expect(lacks(script({}, []))).toEqual(["Pick what the script is written in."]);
    expect(lacks(script({}, ["sh -lc"]))).toEqual(["Pick what the script is written in."]);
    // A program with words after it is one word and its own: what the server takes.
    expect(lacks(script({}, ["python3", "-u"]))).toEqual([]);
    expect(lacks(script({ secrets: ["notes key"] }))).toEqual(["Check the saved keys it uses: each is one name, as it is saved."]);
    // One among several started at the same time is held the same way.
    const together: AutomationStep = { id: "t", kind: "parallel", steps: [{ id: "t-1", kind: "agentTurn", message: "Read the news." }, { id: "t-2", kind: "command", argv: ["sh"], script: { text: "", about: "Lists the reports." } }] };
    expect(lacks(together)).toEqual(["Write the script, or ask an agent to write it."]);
  });
});
