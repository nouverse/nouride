/**
 * An automation that watches, through the whole app: one set to tell once that told and turned itself off, a run that
 * ended because a step said what it said the last time, the switch on a step that makes a run end so, and the two
 * switches where an automation reports (tell once and turn off, tell at once whatever the hour).
 *
 * Each case is a way the page would say something else than what happened, or save something else than what was set:
 * an automation that did what it was asked drawn as one that kept failing, with the server's own word for why under
 * it; a step that found nothing new drawn as a failure, or as one that printed the words the server keeps for it; a
 * switch offered where the server refuses it, saved as anything but the mark the server reads, or saved at the cost
 * of something else the automation holds; and a switch offered to someone the server would refuse.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep, AutomationSummary, JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { answer, dropdown, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { AS_VIEWER, STEPS, TWO_AGENTS, automation, barButton, detail, field, flowDrawn, labelled, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { sameAsLastTime } from "@/modules/automations/lib/runs";
import { marksWords, toldAndOff } from "@/modules/automations/lib/watch";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const AS_OPERATOR = { ...TWO_AGENTS, "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) };
const LIST = WIRE["/automations"] as { automations: AutomationSummary[]; timezone: string };
const TOLD = { enabled: false, disabledReason: "told", delivery: { mode: "announce", once: true } } as const;

/** A switch with its line under it, by what it is called: the row, the box itself, and the line. */
const toggleRow = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>("main label")].find((row) => row.querySelector("span > span")?.textContent === label);
const toggle = (host: HTMLElement, label: string) => toggleRow(host, label)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
const lineOf = (host: HTMLElement, label: string) => toggleRow(host, label)?.querySelectorAll("span > span")[1]?.textContent ?? null;

/** Save pressed, and what it sent. */
async function save(host: HTMLElement): Promise<{ path: string; body: unknown }[]> {
  const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
  await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
  barButton(host, "Save")!.click();
  await eventually(() => record.posts.length > 0, 2_000, "the save");
  record.restore();
  return record.posts;
}

/** The line under an automation's head that says why it is off: which kind it is, its words, and how it is drawn. */
function whyOff(host: HTMLElement) {
  const note = host.querySelector<HTMLElement>("main header [data-off]");
  const colours = note?.getAttribute("class") ?? "";
  return { kind: note?.dataset.off ?? null, said: note?.querySelector("p")?.textContent ?? note?.textContent ?? null, info: colours.includes("text-info"), warning: colours.includes("warning"), details: note?.querySelectorAll("details").length ?? 0 };
}

describe("an automation that told, and turned itself off", () => {
  test("says so on its page as information, with how to be told again, and nothing of a failure or of the server's word for it", async () => {
    answer({ [PAGE]: detail(automation(TOLD)) });
    const seen = { off: whyOff(document.body), head: "", switches: -1 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.off = whyOff(host);
      seen.head = host.querySelector("main header")?.textContent ?? "";
      seen.switches = host.querySelectorAll('main header [role="switch"]').length;
    });
    expect(seen.off).toEqual({ kind: "told", said: "It told you, and turned itself off. Turn it on to be told again.", info: true, warning: false, details: 0 });
    expect(seen.head).not.toContain("kept failing");
    expect(seen.head).not.toContain("Details");
    // The switch that turns it on again is right there.
    expect(seen.switches).toBe(1);
  });

  test("one turned off after it kept failing keeps its warning, with the reason under Details; one a person paused says neither", async () => {
    answer({ [PAGE]: detail(automation({ enabled: false, disabledReason: "5 runs failed in a row" })) });
    const seen = { failing: whyOff(document.body), reason: "", paused: whyOff(document.body) };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.failing = whyOff(host);
      seen.reason = host.querySelector("main header [data-off] details")?.textContent ?? "";
    });
    expect(seen.failing).toEqual({ kind: "failing", said: "It was turned off after it kept failing. Turn it on to try again.", info: false, warning: true, details: 1 });
    expect(seen.reason).toContain("5 runs failed in a row");

    answer({ [PAGE]: detail(automation({ enabled: false })) });
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.paused = whyOff(host);
    });
    expect(seen.paused.kind).toBeNull();
  });

  test("turned on again it says nothing of having told", async () => {
    answer({ [PAGE]: detail(automation({ ...TOLD, enabled: true })) });
    let off = whyOff(document.body);
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      off = whyOff(host);
    });
    expect(off.kind).toBeNull();
  });

  test("a reader who only reads it is told what happened, and not to turn on what is not theirs to turn on", async () => {
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation({ ...TOLD, person: { key: "gading", name: "Gading" }, changeable: false })) });
    const seen = { off: whyOff(document.body), switches: -1 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.off = whyOff(host);
      seen.switches = host.querySelectorAll('main [role="switch"]').length;
    });
    expect(seen.off).toMatchObject({ kind: "told", said: "It told you, and turned itself off.", info: true, warning: false });
    expect(seen.switches).toBe(0);
  });

  test("its row in the list says it told, quietly; one a person paused says Paused", async () => {
    answer({ "/automations": ok({ ...LIST, automations: [automation({ id: "cron_t", name: "Build watch", ...TOLD }), automation({ id: "cron_p", name: "Shop check", enabled: false })] }) });
    const seen: Record<string, { word: string; tone: string | undefined }> = {};
    await renderPage("/automations", async (host) => {
      await eventually(() => host.querySelectorAll("[data-automation]").length === 2, 3_000, "the rows");
      for (const row of host.querySelectorAll<HTMLElement>("[data-automation]")) {
        const chip = row.querySelector<HTMLElement>("footer [data-state]");
        seen[row.dataset.automation!] = { word: chip?.textContent ?? "", tone: chip?.dataset.state };
      }
    });
    expect(seen).toEqual({ cron_t: { word: "Told you, now off", tone: "quiet" }, cron_p: { word: "Paused", tone: "quiet" } });
  });
});

describe("a run that ended because a step said the same as last time", () => {
  const out = (id: string, status: StepRunOutcome["status"], more: Partial<StepRunOutcome> = {}): StepRunOutcome => ({ id, kind: STEPS.find((step) => step.id === id)?.kind ?? "command", status, startedAt: 1, ...more });
  const run = (steps: StepRunOutcome[], result: string): JobRunSummary => ({ id: "run_1", jobId: "cron_e", startedAt: Date.now() - 60_000, finishedAt: Date.now() - 59_000, status: "success", steps, result });
  const pressTab = (host: HTMLElement, label: string) => ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === label) as HTMLElement).click();

  /** The first step's card over the newest run: its chip, how the card is drawn, what is folded under it, and the path lit. */
  async function firstStep(outcome: StepRunOutcome, result: string) {
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: [{ ...STEPS[0]!, onlyChanged: true }, ...STEPS.slice(1)] } }), [run([outcome], result)]) });
    const seen = { chip: "", tone: "" as string | undefined, state: "" as string | undefined, folded: [] as string[], reached: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      pressTab(host, "Last run");
      await eventually(() => stepCard(host, "check").querySelector("[data-tone]") !== null, 2_000, "the run over the steps");
      const card = stepCard(host, "check");
      seen.chip = card.querySelector("[data-tone]")?.textContent ?? "";
      seen.tone = card.querySelector<HTMLElement>("[data-tone]")?.dataset.tone;
      seen.state = card.dataset.state;
      seen.folded = [...card.querySelectorAll("details")].map((one) => one.textContent ?? "");
      seen.reached = STEPS.map((step) => step.id).filter((id) => !stepCard(host, id).hasAttribute("data-dimmed"));
    });
    return seen;
  }

  test("the step says so in the colours of one with nothing to say, not as a failure, and the server's words for it are not drawn as what it printed", async () => {
    const seen = await firstStep(out("check", "empty", { said: "said the same as last time", same: true, ms: 30 }), "step 1 of 4 said the same as last time: the run ended there");
    expect(seen).toEqual({ chip: "The same as last time", tone: "quiet", state: undefined, folded: [], reached: ["check"] });
  });

  test("a step that printed nothing still says that, with the server's words for it under it", async () => {
    const seen = await firstStep(out("check", "empty", { said: "printed nothing", ms: 30 }), "step 1 of 4 had nothing to say: the run ended there");
    expect(seen.chip).toBe("Nothing to say");
    expect(seen.folded).toHaveLength(1);
    expect(seen.folded[0]).toContain("printed nothing");
  });
});

describe("the switch that lets a run go on only when what a step says has changed", () => {
  const LABEL = "Go on only when this changes";
  const ENDS = "If it says the same as last time, the run ends here quietly.";
  const SAYS = "It goes on only when what it says changes.";
  const FIVE: AutomationStep[] = [
    { id: "check", kind: "command", argv: ["sh", "-lc", "df -h /"] },
    { id: "find", kind: "agentTurn", message: "Say what is filling the disk." },
    { id: "fix", kind: "mission", goal: "Free some room on the disk." },
    { id: "ok", kind: "approval", ask: "Tell the group?" },
    { id: "tell", kind: "systemEvent", text: "The disk was nearly full." },
  ];
  const [CHECK, FIND, FIX, OK, TELL] = FIVE as [AutomationStep, AutomationStep, AutomationStep, AutomationStep, AutomationStep];
  const shown = (steps: AutomationStep[], more: Record<string, { status: number; body: unknown }> = {}) => answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps } })), ...TWO_AGENTS, ...more });
  /** A step's editor opened, by its place. */
  async function open(host: HTMLElement, place: number): Promise<void> {
    labelled(host, `Edit step ${place}`).click();
    await eventually(() => host.querySelector(`[aria-label="Close step ${place}"]`) !== null, 2_000, `step ${place} opened`);
  }
  const sentSteps = (posts: { path: string; body: unknown }[]) => (posts[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps;

  test("is offered on a command, an agent's turn and a mission, off, with what it does under it; never on a wait or a message", async () => {
    shown(FIVE);
    const offered: Record<string, { on: boolean | null; line: string | null }> = {};
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      for (const [at, step] of FIVE.entries()) {
        await open(host, at + 1);
        offered[step.kind] = { on: toggle(host, LABEL)?.checked ?? null, line: lineOf(host, LABEL) };
      }
    });
    // A mission tells its chat how it went by itself, so its run's end is not called quiet.
    expect(offered).toEqual({ command: { on: false, line: ENDS }, agentTurn: { on: false, line: ENDS }, mission: { on: false, line: "If it says the same as last time, the run ends here." }, approval: { on: null, line: null }, systemEvent: { on: null, line: null } });
  });

  test("turned on, the step is saved with the mark the server reads and the rest of the list as it was, and its card says so", async () => {
    shown(FIVE);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { before: "", on: false, card: "", others: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      seen.before = stepCard(host, "check").textContent ?? "";
      await open(host, 1);
      toggle(host, LABEL)!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      seen.on = toggle(host, LABEL)!.checked;
      labelled(host, "Close step 1").click();
      await eventually(() => host.querySelector('[aria-label="Edit step 1"]') !== null, 2_000, "the card closed");
      seen.card = stepCard(host, "check").textContent ?? "";
      seen.others = ["find", "fix", "ok", "tell"].filter((id) => stepCard(host, id).textContent?.includes(SAYS));
      sent = await save(host);
    });
    expect(seen.before).not.toContain(SAYS);
    expect(seen.on).toBe(true);
    expect(seen.card).toContain(`No AI is used for this step. ${SAYS}`);
    expect(seen.others).toEqual([]);
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { payload: { kind: "steps", steps: [{ ...CHECK, onlyChanged: true }, FIND, FIX, OK, TELL] } } }]);
  });

  test("a step that has it shows it on, and turned off it is saved without the mark; put back on, there is nothing to save", async () => {
    shown([CHECK, { ...FIND, onlyChanged: true }, { ...FIX, onlyChanged: true }, OK, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { marked: [] as string[], on: null as boolean | null, back: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      seen.marked = FIVE.map((step) => step.id).filter((id) => stepCard(host, id).textContent?.includes(SAYS));
      await open(host, 2);
      seen.on = toggle(host, LABEL)?.checked ?? null;
      toggle(host, LABEL)!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      // Back on: the list is as the server holds it, and the bar goes.
      toggle(host, LABEL)!.click();
      await eventually(() => saveBar(host) === null, 2_000, "nothing to save");
      seen.back = saveBar(host) === null;
      toggle(host, LABEL)!.click();
      sent = await save(host);
    });
    expect(seen.marked).toEqual(["find", "fix"]);
    expect(seen.on).toBe(true);
    expect(seen.back).toBe(true);
    expect(sentSteps(sent)).toEqual([CHECK, FIND, { ...FIX, onlyChanged: true }, OK, TELL]);
    expect("onlyChanged" in sentSteps(sent)[1]!).toBe(false);
  });

  test("made another kind, the step keeps the mark where that kind can hold it, and a message is saved without it", async () => {
    shown([{ ...CHECK, onlyChanged: true }, FIND]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { asAgent: null as boolean | null, asMessage: true as boolean | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 2);
      await open(host, 1);
      await dropdown(host, "What it does").pick("Ask an agent");
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the agent's fields");
      seen.asAgent = toggle(host, LABEL)?.checked ?? null;
      await dropdown(host, "What it does").pick("Send a message");
      await eventually(() => host.textContent?.includes("Sent as written") === true, 2_000, "the message's fields");
      seen.asMessage = toggle(host, LABEL)?.checked ?? null;
      sent = await save(host);
    });
    expect(seen).toEqual({ asAgent: true, asMessage: null });
    expect(sentSteps(sent)).toEqual([{ id: "check", kind: "systemEvent", text: "df -h /" }, FIND]);
  });

  test("on an automation that does one thing, it is saved as a list of that one step; turned off again it is the one thing it was", async () => {
    answer({ [PAGE]: detail(automation({ payload: { kind: "command", argv: ["sh", "-lc", "df -h /"], then: "deliver" } })) });
    let sent: { path: string; body: unknown }[] = [];
    let back = false;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      await open(host, 1);
      toggle(host, LABEL)!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      toggle(host, LABEL)!.click();
      await eventually(() => saveBar(host) === null, 2_000, "nothing to save");
      back = saveBar(host) === null;
      toggle(host, LABEL)!.click();
      sent = await save(host);
    });
    expect(back).toBe(true);
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "df -h /"], onlyChanged: true }] } } }]);
  });

  test("where the step's path for nothing to say leads on, the line says the run takes that path", async () => {
    shown([{ ...CHECK, whenEmpty: { to: "tell" } }, FIND, TELL]);
    let line = "" as string | null;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 3);
      await open(host, 1);
      line = lineOf(host, LABEL);
    });
    expect(line).toBe('If it says the same as last time, the run goes where "When it has nothing to say" sends it.');
  });

  test("an account that only looks, and a reader of another person's, read the mark on the step's card and are offered no switch", async () => {
    const marked = [{ ...CHECK, onlyChanged: true as const }, FIND, FIX, OK, TELL];
    const seen: Record<string, { card: string; boxes: number; edits: number }> = {};
    for (const [name, who, one] of [
      ["viewer", AS_VIEWER, automation({ payload: { kind: "steps", steps: marked } })],
      ["reader", AS_OPERATOR, automation({ payload: { kind: "steps", steps: marked }, person: { key: "gading", name: "Gading" }, changeable: false })],
    ] as const) {
      answer({ ...TWO_AGENTS, ...who, [PAGE]: detail(one) });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host, 5);
        seen[name] = {
          card: stepCard(host, "check").textContent ?? "",
          // The head's own switch is a viewer's to see, off limits; nothing else on the page is a box to tick.
          boxes: host.querySelectorAll('main input[type="checkbox"]:not([role="switch"])').length,
          edits: host.querySelectorAll('main [aria-label^="Edit step"]').length,
        };
      });
    }
    for (const name of ["viewer", "reader"]) {
      expect({ name, says: seen[name]!.card.includes(SAYS), boxes: seen[name]!.boxes, edits: seen[name]!.edits }).toEqual({ name, says: true, boxes: 0, edits: 0 });
    }
  });
});

describe("the two switches where an automation reports", () => {
  const ONCE = "Tell me once, then turn off";
  const AT_ONCE = "Tell me at once, even in quiet hours";
  const TELLS = "Tell that chat how each run went";
  const HOURS = "/policy/quiet-hours";
  const NONE_SET = { [HOURS]: ok({ timeZone: "Asia/Jakarta", editable: true }) };
  const AT_NIGHT = { [HOURS]: ok({ from: "22:00", to: "07:00", timeZone: "Asia/Jakarta", editable: true }) };
  const who = (host: HTMLElement) => host.querySelector<HTMLElement>('main section[aria-label="Who and where"]')!;
  /** The card's fields opened by its Change. */
  async function change(host: HTMLElement): Promise<void> {
    ([...who(host).querySelectorAll("button")].find((button) => button.textContent === "Change") as HTMLElement).click();
    await eventually(() => toggle(host, AT_ONCE) !== null, 2_000, "the card's fields");
  }
  const marks = (host: HTMLElement) => who(host).querySelector("[data-marks]")?.textContent ?? null;

  test("are offered to whoever may change it, off, each with what it does; with no quiet hours set the second says so", async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, as] of [["admin", {}], ["operator", AS_OPERATOR]] as const) {
      answer({ ...as, ...NONE_SET, [PAGE]: detail(automation({ person: { key: "gading", name: "Gading" }, changeable: true })) });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        const before = marks(host);
        await change(host);
        await eventually(() => lineOf(host, AT_ONCE) === "Quiet hours are not set.", 2_000, "what the hours are");
        seen[name] = { before, once: toggle(host, ONCE)?.checked, onceLine: lineOf(host, ONCE), atOnce: toggle(host, AT_ONCE)?.checked, atOnceLine: lineOf(host, AT_ONCE) };
      });
    }
    const offered = { before: null, once: false, onceLine: "After the first run that tells you something, it turns itself off. A run you start by hand does not count.", atOnce: false, atOnceLine: "Quiet hours are not set." };
    expect(seen).toEqual({ admin: offered, operator: offered });
  });

  test("with quiet hours set, the second says which hours it overrides", async () => {
    answer({ ...AT_NIGHT, [PAGE]: detail(automation()) });
    let line = "" as string | null;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await change(host);
      await eventually(() => lineOf(host, AT_ONCE)?.startsWith("Quiet hours are 22:00") === true, 2_000, "what the hours are");
      line = lineOf(host, AT_ONCE);
    });
    expect(line).toBe("Quiet hours are 22:00 to 07:00. What it says then is sent at once, not kept for later.");
  });

  test("each is sent as the mark the server reads, with the rest of where it reports as it was, and the card says it", async () => {
    // It reports to another chat than its own, and already tells at once.
    const elsewhere = { mode: "announce", gatewayId: "discord:nix", chatId: "ops", atOnce: true } as const;
    answer({ ...AT_NIGHT, [PAGE]: detail(automation({ delivery: elsewhere })) });
    const sent: { path: string; body: unknown }[] = [];
    const seen = { before: "" as string | null, on: null as boolean | null, after: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.before = marks(host);
      await change(host);
      seen.on = toggle(host, AT_ONCE)!.checked;
      toggle(host, ONCE)!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      seen.after = marks(host);
      sent.push(...(await save(host)));
    });
    expect(seen).toEqual({ before: "It tells at once, even in quiet hours.", on: true, after: "It tells once, then turns itself off. It tells at once, even in quiet hours." });
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { delivery: { ...elsewhere, once: true } } }]);

    // The other switch, on one that tells once: on, and then off again from both.
    for (const [was, sends] of [
      [{ mode: "announce", once: true }, { mode: "announce", once: true, atOnce: true }],
      [{ mode: "announce", once: true, atOnce: true }, { mode: "announce", once: true }],
    ] as const) {
      answer({ ...AT_NIGHT, [PAGE]: detail(automation({ delivery: was })) });
      let posts: { path: string; body: unknown }[] = [];
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await change(host);
        toggle(host, AT_ONCE)!.click();
        posts = await save(host);
      });
      expect(posts).toEqual([{ path: "/cron/cron_e", body: { delivery: sends } }]);
    }
  });

  test("on one that sends its results to another app, the address the page has no field for is sent back with the mark", async () => {
    const toApp = { mode: "webhook", webhookUrl: "https://hooks.example.com/in" } as unknown as AutomationSummary["delivery"];
    answer({ ...NONE_SET, [PAGE]: detail(automation({ delivery: toApp })) });
    let posts: { path: string; body: unknown }[] = [];
    let tells = true;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await change(host);
      // Where it sends was set elsewhere and stays: there is no switch for telling its chat.
      tells = toggle(host, TELLS) !== null;
      toggle(host, ONCE)!.click();
      posts = await save(host);
    });
    expect(tells).toBe(false);
    expect(posts).toEqual([{ path: "/cron/cron_e", body: { delivery: { mode: "webhook", webhookUrl: "https://hooks.example.com/in", once: true } } }]);
  });

  test("telling once is not offered where it tells nobody, and is not sent with it; telling switched back on finds it as it was", async () => {
    answer({ ...AT_NIGHT, [PAGE]: detail(automation({ delivery: { mode: "announce", once: true } })) });
    let posts: { path: string; body: unknown }[] = [];
    const seen = { was: null as boolean | null, quiet: true, card: "" as string | null, atOnce: null as boolean | null, line: "" as string | null, back: null as boolean | null, bar: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await change(host);
      seen.was = toggle(host, ONCE)?.checked ?? null;
      toggle(host, TELLS)!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      seen.quiet = toggle(host, ONCE) !== null;
      seen.card = marks(host);
      // The other switch stays, and says it has nothing to do while no chat is told.
      seen.atOnce = toggle(host, AT_ONCE)?.checked ?? null;
      seen.line = lineOf(host, AT_ONCE);
      posts = await save(host);
    });
    expect(seen).toMatchObject({ was: true, quiet: false, card: null, atOnce: false, line: "It tells no chat, so nothing it says is kept for later." });
    expect(posts).toEqual([{ path: "/cron/cron_e", body: { delivery: { mode: "none" } } }]);

    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await change(host);
      toggle(host, TELLS)!.click();
      await eventually(() => toggle(host, ONCE) === null, 2_000, "telling off");
      toggle(host, TELLS)!.click();
      await eventually(() => toggle(host, ONCE) !== null, 2_000, "telling on again");
      seen.back = toggle(host, ONCE)!.checked;
      await eventually(() => saveBar(host) === null, 2_000, "nothing to save");
      seen.bar = saveBar(host) !== null;
    });
    expect(seen).toMatchObject({ back: true, bar: false });
  });

  test("a save the server refuses is said in its words, and the switch stays as it was set", async () => {
    answer({ ...NONE_SET, [PAGE]: detail(automation()) });
    const seen = { said: "", on: false, card: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await change(host);
      toggle(host, ONCE)!.click();
      const record = recordPosts({ "/cron/cron_e": { status: 400, body: { error: "a job that tells nobody cannot turn itself off once it has told: give it somewhere to report.", plain: "Nothing was saved. Check where it reports, and try again." } } });
      await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
      barButton(host, "Save")!.click();
      await eventually(() => saveBar(host)?.querySelector('[role="alert"]') !== null, 2_000, "the refusal");
      record.restore();
      seen.said = saveBar(host)?.querySelector('[role="alert"] p')?.textContent ?? "";
      seen.on = toggle(host, ONCE)!.checked;
      seen.card = marks(host);
    });
    expect(seen).toEqual({ said: "Nothing was saved. Check where it reports, and try again.", on: true, card: "It tells once, then turns itself off." });
  });

  test("a new automation is made with the marks set on it", async () => {
    answer({ ...TWO_AGENTS, ...NONE_SET });
    let posts: { path: string; body: unknown }[] = [];
    await renderPage("/automations/new", async (host) => {
      await eventually(() => host.textContent?.includes("Add the first step") === true, 3_000, "the empty flow");
      type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Build watch");
      ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add the first step")) as HTMLElement).click();
      const kinds = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Add a step"] button')];
      await eventually(() => kinds().length === 5, 2_000, "the picker");
      kinds().find((button) => button.querySelector("span span")?.textContent === "Ask an agent")!.click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the step's fields");
      type(field(host, "What to ask"), "Is the build done?");
      type(host.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement, "-100200");
      // The card that says where it reports is open on a new one.
      toggle(host, ONCE)!.click();
      toggle(host, AT_ONCE)!.click();
      const record = recordPosts({ "/cron": ok({ job: automation({ id: "cron_new" }) }) });
      await eventually(() => barButton(host, "Save automation")?.disabled === false, 2_000, "Save offered");
      barButton(host, "Save automation")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      posts = record.posts;
    });
    expect((posts[0]?.body as { delivery: unknown }).delivery).toEqual({ mode: "announce", once: true, atOnce: true });
  });

  test("an account that only looks, and a reader of another person's, read both marks on the card and are offered neither switch", async () => {
    const marked = { delivery: { mode: "announce", once: true, atOnce: true } } as const;
    const seen: Record<string, { card: string | null; change: number; boxes: number }> = {};
    for (const [name, as, one] of [
      ["viewer", AS_VIEWER, automation(marked)],
      ["reader", AS_OPERATOR, automation({ ...marked, person: { key: "gading", name: "Gading" }, changeable: false })],
    ] as const) {
      answer({ ...TWO_AGENTS, ...as, ...AT_NIGHT, [PAGE]: detail(one) });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        seen[name] = {
          card: marks(host),
          change: [...who(host).querySelectorAll("button")].filter((button) => button.textContent === "Change").length,
          boxes: host.querySelectorAll('main input[type="checkbox"]:not([role="switch"])').length,
        };
      });
    }
    const read = { card: "It tells once, then turns itself off. It tells at once, even in quiet hours.", change: 0, boxes: 0 };
    expect(seen).toEqual({ viewer: read, reader: read });
  });
});

describe("one that watches, as the server itself answers for it", () => {
  // The routes' own answers, written by the engine's contract test from an automation the scheduler ran: a camera's
  // webhook that told, read the same again, and told once more. Nothing here is made up, so a field the server
  // renames, or a word it changes, is red here and not only in a browser.
  const DOOR = WIRE["/automations/cron_6"] as { automation: AutomationSummary; runs: JobRunSummary[] };

  test("what the pages read is what the server wrote: off because it told, both marks, and the run that said the same", () => {
    expect(toldAndOff(DOOR.automation)).toBe(true);
    expect(marksWords(DOOR.automation.delivery)).toEqual(["It tells once, then turns itself off.", "It tells at once, even in quiet hours."]);
    const steps = (DOOR.automation.payload as unknown as { steps: AutomationStep[] }).steps;
    expect(steps.map((step) => step.onlyChanged === true)).toEqual([true, false]);
    // Three runs, newest first: it told, it read the same and ended at the script, it told.
    expect(DOOR.runs.map((run) => (run.steps ?? []).map(sameAsLastTime))).toEqual([[false, false], [true], [false, false]]);
  });

  test("its page says it told, in the colours of information, and its marked step says its mark", async () => {
    const seen = { off: whyOff(document.body), read: "", say: "" };
    await renderPage("/automations/cron_6", async (host) => {
      await flowDrawn(host, 2);
      seen.off = whyOff(host);
      seen.read = stepCard(host, "read").textContent ?? "";
      seen.say = stepCard(host, "say").textContent ?? "";
    });
    expect(seen.off).toEqual({ kind: "told", said: "It told you, and turned itself off. Turn it on to be told again.", info: true, warning: false, details: 0 });
    expect(seen.read).toContain("It goes on only when what it says changes.");
    expect(seen.say).not.toContain("It goes on only when what it says changes.");
  });

  test("its row in the list says it told, and the page says the hours the server holds", async () => {
    const seen = { word: "", hours: "" };
    await renderPage("/automations", async (host) => {
      await eventually(() => host.querySelector('[data-automation="cron_6"]') !== null, 3_000, "its row");
      seen.word = host.querySelector('[data-automation="cron_6"] footer [data-state]')?.textContent ?? "";
      await eventually(() => host.querySelector("[data-quiet-hours]") !== null, 3_000, "the hours");
      seen.hours = host.querySelector("[data-quiet-hours]")?.textContent ?? "";
    });
    expect(seen.word).toBe("Told you, now off");
    expect(seen.hours).toStartWith("Quiet hours: 22:00 to 07:00");
  });
});
