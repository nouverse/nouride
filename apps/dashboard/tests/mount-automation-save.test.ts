/**
 * What an automation's page saves, and when. One made before lists is drawn as a single step and saved as the one
 * thing it is, and becomes a list when a second step is added; a new one is made through the door its start needs; a
 * refusal marks the step it names. And the head of the page: its name, its switch, Run now, Delete.
 */

import { describe, expect, test } from "bun:test";
import { answer, buttons, dropdown, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { STEPS, TWO_AGENTS, addStep, automation, barButton, detail, drawn, field, flowDrawn, labelled, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";
import { READS_OUTPUT } from "@/modules/automations/lib/draft";

useMountHarness();

const PAGE = "/automations/cron_e";
const job = ok({ job: automation() });

async function save(host: HTMLElement, label = "Save", answers: Record<string, { status: number; body: unknown }> = { "/cron/cron_e": job }) {
  const record = recordPosts(answers);
  await eventually(() => barButton(host, label)?.disabled === false, 2_000, `${label} offered`);
  barButton(host, label)!.click();
  await eventually(() => record.posts.length > 0, 2_000, "the save");
  record.restore();
  return record.posts;
}

describe("one thing, and a list", () => {
  test("one made before lists is a single step, and saves as the one thing it is", async () => {
    answer({ [PAGE]: detail(automation({ payload: { kind: "agentTurn", message: "Sum up the mail." }, session: "isolated" })) });
    let sent: { path: string; body: unknown }[] = [];
    let card = "";
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      card = stepCard(host, "s1").textContent ?? "";
      // One step has nothing to be moved among: no handle.
      expect(host.querySelector('[aria-label^="Move step"]')).toBeNull();
      labelled(host, "Edit step 1").click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "its fields");
      type(field(host, "What to ask"), "Sum up the news.");
      sent = await save(host);
    });
    expect(card).toContain("Step 1 · Nouva works on itSum up the mail.");
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { payload: { kind: "agentTurn", message: "Sum up the news." } } }]);
  });

  test("a second step turns it into a list: a command that woke its agent is the command and a step for the agent, and its chat's history is left behind, both said before the save", async () => {
    answer({ [PAGE]: detail(automation({ payload: { kind: "command", argv: ["sh", "-lc", "ls backups"], then: "agentTurn" }, session: "chat" })) });
    let sent: { path: string; body: unknown }[] = [];
    const seen = { then: "", note: "", order: [] as string[], agent: "", notes: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      labelled(host, "Edit step 1").click();
      await eventually(() => dropdown(host, "After it runs").button() !== undefined, 2_000, "what its output is worth");
      seen.then = dropdown(host, "After it runs").holds() ?? "";
      seen.note = stepCard(host, "s1").textContent ?? "";
      await addStep(host, "Add a step at the end", "Wait for your OK");
      await flowDrawn(host, 3);
      seen.order = drawn(host);
      seen.agent = stepCard(host, "s3").textContent ?? "";
      // Among other steps what reads a command's output is the next step: the choice is gone from the command.
      expect(dropdown(host, "After it runs").button()).toBeUndefined();
      type(field(host, "Question"), "Is it there?");
      seen.notes = saveBar(host)?.textContent ?? "";
      sent = await save(host);
    });
    expect(seen.then).toBe("Hand what it printed to Nouva");
    // While it was the one thing, its card said who reads what it prints.
    expect(seen.note).toContain("Then Nouva reads what it printed and reports.");
    // The agent's step right after the command it reads, before the step just added.
    expect(seen.order).toEqual(["s1", "s3", "s2"]);
    expect(seen.agent).toContain(READS_OUTPUT);
    expect(seen.notes).toContain("Its command handed what it printed to the agent. That is a step of its own now, after the command.");
    expect(seen.notes).toContain("It read its chat's history. With more than one step, each run starts clean instead.");
    expect(sent).toEqual([
      {
        path: "/cron/cron_e",
        body: {
          payload: { kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh", "-lc", "ls backups"] }, { id: "s3", kind: "agentTurn", message: READS_OUTPUT }, { id: "s2", kind: "approval", ask: "Is it there?" }] },
          session: "fresh",
        },
      },
    ]);
  });

  test("the start changed for a start by hand sends that and nothing else; a webhook keeps its start", async () => {
    answer({ [PAGE]: detail(automation()) });
    let sent: { path: string; body: unknown }[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      ([...host.querySelectorAll('[aria-label="Start"] button')].find((button) => button.textContent === "Change") as HTMLElement).click();
      await eventually(() => host.querySelector('[role="radiogroup"]') !== null, 2_000, "the start's choices");
      // Made as it is: a webhook is chosen only when an automation is made.
      expect([...host.querySelectorAll('[role="radio"]')].map((choice) => choice.querySelector("span")?.textContent)).toEqual(["Scheduled", "Manual"]);
      ([...host.querySelectorAll<HTMLElement>('[role="radio"]')][1]!).click();
      await eventually(() => host.querySelector('[aria-label="Start"]')?.textContent?.includes("when you press Run now") === true, 2_000, "by hand");
      sent = await save(host);
    });
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { manual: true } }]);

    const hook = automation({ start: "webhook", trigger: { kind: "webhook" }, hook: { webhookToken: "t", path: "/hooks/t", url: "https://box.example.com/hooks/t", urlGuessed: false, reach: { state: "internet", why: "A test arrived." } } });
    answer({ [PAGE]: detail(hook) });
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const start = host.querySelector('[aria-label="Start"]')!;
      // Its address, to copy; whether a call can arrive; and no way to make it anything but a webhook.
      expect(start.textContent).toContain("https://box.example.com/hooks/t");
      expect(start.textContent).toContain("Reachable from the internet");
      ([...start.querySelectorAll("button")].find((button) => button.textContent === "Change") as HTMLElement).click();
      await eventually(() => start.textContent?.includes("A webhook stays a webhook") === true, 2_000, "why it stays");
      expect(start.querySelector('[role="radiogroup"]')).toBeNull();
    });
  });
});

describe("a refusal", () => {
  test("marks the step it names with the server's everyday words, and keeps what was typed", async () => {
    answer({ [PAGE]: detail(automation()) });
    const seen = { state: "", card: "", bar: "", details: "", name: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Shop watch");
      await save(host, "Save", { "/cron/cron_e": { status: 400, body: { error: "step 2: an agent turn needs a message.", plain: "Nothing was saved. Check the steps, and try again." } } });
      await eventually(() => stepCard(host, "find").dataset.state === "failed", 2_000, "the step marked");
      seen.state = stepCard(host, "find").dataset.state ?? "";
      seen.card = stepCard(host, "find").querySelector('[role="alert"]')?.textContent ?? "";
      seen.bar = saveBar(host)?.querySelector('[role="alert"] p')?.textContent ?? "";
      seen.details = saveBar(host)?.querySelector("details")?.textContent ?? "";
      seen.name = (host.querySelector('input[aria-label="Name"]') as HTMLInputElement).value;
      // No other step is marked.
      expect(STEPS.filter((step) => stepCard(host, step.id).dataset.state === "failed").map((step) => step.id)).toEqual(["find"]);
    });
    expect(seen.state).toBe("failed");
    expect(seen.card).toBe("Nothing was saved. Check the steps, and try again.");
    expect(seen.bar).toBe("Nothing was saved. Check the steps, and try again.");
    // The route's own words, which name the step, are for whoever runs the server.
    expect(seen.details).toContain("step 2: an agent turn needs a message.");
    expect(seen.name).toBe("Shop watch");
  });
});

describe("a new automation", () => {
  const made = { "/cron": ok({ job: automation({ id: "cron_new" }) }), "/webhooks": ok({ webhook: { ...automation({ id: "cron_hook" }), webhookToken: "t", path: "/hooks/t", url: "http://x/hooks/t", urlGuessed: true, reach: { state: "unknown", why: "" } } }) };

  async function written(host: HTMLElement) {
    await eventually(() => host.textContent?.includes("Add the first step") === true, 3_000, "the empty flow");
    type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Morning brief");
    ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add the first step")) as HTMLElement).click();
    const kinds = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Add a step"] button')];
    await eventually(() => kinds().length === 5, 2_000, "the picker");
    kinds().find((button) => button.querySelector("span span")?.textContent === "Ask an agent")!.click();
    await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the step's fields");
    type(field(host, "What to ask"), "Sum up the mail.");
    type(host.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement, "-100200");
  }

  test("says what it still lacks, one thing at a time, and saves as a scheduled one with exactly what was written", async () => {
    answer(TWO_AGENTS);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { lacks: [] as string[], who: "", went: "" };
    await renderPage("/automations/new", async (host, app) => {
      await eventually(() => saveBar(host) !== null, 3_000, "the bar");
      seen.lacks.push(saveBar(host)?.querySelector("p")?.textContent ?? "");
      expect(barButton(host, "Save automation")?.disabled).toBe(true);
      type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Morning brief");
      await eventually(() => saveBar(host)?.textContent?.includes("Pick the chat") === true, 2_000, "the next thing");
      seen.lacks.push(saveBar(host)?.querySelector("p")?.textContent ?? "");
      // The card that lacks it says so too.
      seen.who = host.querySelector('[aria-label="Who and where"]')?.textContent ?? "";
      await written(host);
      sent = await save(host, "Save automation", made);
      await eventually(() => app.location() === "/automations/cron_new", 3_000, "its own page");
      seen.went = app.location();
    });
    expect(seen.lacks).toEqual(["Give it a name.", "Pick the chat it reports to."]);
    expect(seen.who).toContain("Pick the chat it reports to.");
    expect(sent).toEqual([{ path: "/cron", body: { agentId: "nouva", name: "Morning brief", payload: { kind: "agentTurn", message: "Sum up the mail." }, target: { gatewayId: "telegram:nouva", chatId: "-100200" }, delivery: { mode: "announce" }, every: "15m" } }]);
    expect(seen.went).toBe("/automations/cron_new");
  });

  test("started by hand it is sent as that; started by its address it is made through the webhooks' door, with no time", async () => {
    answer(TWO_AGENTS);
    const body = { agentId: "nouva", name: "Morning brief", payload: { kind: "agentTurn", message: "Sum up the mail." }, target: { gatewayId: "telegram:nouva", chatId: "-100200" }, delivery: { mode: "announce" } };
    const sent: { path: string; body: unknown }[] = [];
    for (const start of ["Manual", "Webhook"]) {
      await renderPage("/automations/new", async (host) => {
        await written(host);
        ([...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((choice) => choice.querySelector("span")?.textContent === start) as HTMLElement).click();
        await eventually(() => host.querySelector('[role="radio"][aria-checked="true"] span')?.textContent === start, 2_000, `${start} chosen`);
        sent.push(...(await save(host, "Save automation", made)));
      });
    }
    expect(sent).toEqual([{ path: "/cron", body: { ...body, manual: true } }, { path: "/webhooks", body }]);
  });
});

describe("the head of the page", () => {
  test("its switch turns it off, Run now runs it and draws the run, and Delete asks first", async () => {
    answer({ [PAGE]: detail(automation(), [{ id: "run_1", jobId: "cron_e", startedAt: 1, finishedAt: 2, status: "success", result: "The shop was down.", steps: [{ id: "check", kind: "command", status: "done", startedAt: 1, ms: 400 }] }]) });
    const seen = { labels: [] as string[], view: "", ask: "" };
    let sent: { path: string; body: unknown }[] = [];
    const deleted: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(new URL(String(input), "http://localhost").pathname.replace("/api/control", ""));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, id: "cron_e" }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      await renderPage(PAGE, async (host, app) => {
        await flowDrawn(host);
        seen.labels = buttons(host).filter((label) => ["Run now", "Turn on", "Discard"].includes(label));
        const record = recordPosts({ "/cron/cron_e/disable": job, "/cron/cron_e/run": ok({ outcome: { status: "success", result: "The shop was down." } }) });
        (host.querySelector('header [role="switch"]') as HTMLElement).click();
        await eventually(() => record.posts.length === 1, 2_000, "the switch");
        ([...host.querySelectorAll("header button")].find((button) => button.textContent?.trim() === "Run now") as HTMLElement).click();
        await eventually(() => record.posts.length === 2, 2_000, "the run");
        await eventually(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Last run", 2_000, "the run drawn");
        seen.view = host.querySelector("[data-flow]")?.getAttribute("data-flow") ?? "";
        record.restore();
        sent = record.posts;
        labelled(host, "More for Shop check").click();
        const item = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="menu"] button')].find((button) => button.textContent?.trim() === "Delete");
        await eventually(() => item() !== undefined, 2_000, "the menu");
        item()!.click();
        await eventually(() => host.querySelector("dialog[open]") !== null, 2_000, "the question");
        seen.ask = host.querySelector("dialog[open]")?.textContent ?? "";
        expect(deleted).toEqual([]);
        ([...host.querySelectorAll("dialog[open] button")].find((button) => button.textContent?.trim() === "Delete") as HTMLElement).click();
        await eventually(() => app.location() === "/automations", 3_000, "back on the list");
      });
    } finally {
      globalThis.fetch = spy;
    }
    expect(seen.labels).toEqual(["Run now"]);
    expect(sent).toEqual([{ path: "/cron/cron_e/disable", body: null }, { path: "/cron/cron_e/run", body: null }]);
    expect(seen.view).toBe("run");
    expect(seen.ask).toContain('Delete "Shop check"?');
    expect(seen.ask).toContain("It stops running, and its runs go with it.");
    expect(deleted).toEqual(["/cron/cron_e"]);
  });

  test("one an agent proposed is turned on or discarded, with no switch and no Run now, and its steps are only read", async () => {
    answer({ [PAGE]: detail(automation({ enabled: false, proposal: { by: "nouva", at: 1 } })) });
    const seen = { labels: [] as string[], head: "", edits: -1 };
    let sent: { path: string; body: unknown }[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.labels = buttons(host).filter((label) => ["Run now", "Turn on", "Discard"].includes(label));
      seen.head = host.querySelector("main header")?.textContent ?? "";
      seen.edits = host.querySelectorAll('[aria-label^="Edit step"], [aria-label^="Add a step"], header [role="switch"]').length;
      const record = recordPosts({ "/cron/cron_e/enable": job });
      ([...host.querySelectorAll("header button")].find((button) => button.textContent?.trim() === "Turn on") as HTMLElement).click();
      await eventually(() => record.posts.length === 1, 2_000, "the answer");
      record.restore();
      sent = record.posts;
    });
    expect(seen.labels).toEqual(["Turn on", "Discard"]);
    expect(seen.head).toContain("Suggested by Nouva");
    expect(seen.head).toContain("It stays off until somebody turns it on.");
    expect(seen.edits).toBe(0);
    expect(sent).toEqual([{ path: "/cron/cron_e/enable", body: null }]);
  });

  test("a missing one says so, with the way back; a server that does not run them says that", async () => {
    answer({ "/automations/cron_gone": { status: 404, body: { error: "no such job" } } });
    const gone = await renderPage("/automations/cron_gone", async (host) => {
      await eventually(() => host.textContent?.includes("No such automation") === true, 3_000, "not found");
    });
    expect(gone).toContain('href="/dashboard/automations"');
    expect(gone).toContain("13-lost");
    answer({ [PAGE]: { status: 501, body: { error: "the scheduler is not enabled" } } });
    const off = await renderPage(PAGE, async (host) => {
      await eventually(() => host.textContent?.includes("not turned on") === true, 3_000, "not turned on");
    });
    expect(off).toContain("Automations are not turned on for this server.");
  });
});
