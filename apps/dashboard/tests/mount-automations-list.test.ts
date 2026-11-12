/**
 * The Automations list, mounted over the engine's own answers (`fixtures/wire.json`): one list for everything that
 * runs on its own, whatever starts it, where Schedule and Webhooks were two pages. Its rows, the one dropdown that
 * narrows it by how a thing starts, the search, its empty and loading states, and the old addresses landing on it.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "@nouride/wire";
import { answer, dropdown, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const LIST = WIRE["/automations"] as { automations: AutomationSummary[]; timezone: string };
const cards = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-automation]")];
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-automation="${id}"]`)!;
const listed = (host: HTMLElement) => eventually(() => cards(host).length > 0, 3_000, "the rows");
const me = WIRE["/auth/me"] as { user: Record<string, unknown> };
const asViewer = { "/auth/me": ok({ ...me, role: "viewer", user: { ...me.user, role: "viewer" } }) };

describe("the tabs and the old addresses", () => {
  test("Work's tabs are Waiting for you, Automations, Missions, Helpers, and the menu marks Work on the list and on one automation", async () => {
    const seen = { tabs: [] as string[], current: [] as string[], one: [] as string[] };
    const current = (host: HTMLElement) => [...host.querySelectorAll('nav[aria-label="Menu"] a[aria-current="page"]')].map((a) => a.querySelector("span")?.textContent?.trim() ?? "");
    await renderPage("/automations", async (host) => {
      await listed(host);
      seen.tabs = [...host.querySelectorAll("main a")].filter((a) => /\/dashboard\/(work|automations|missions|jobs|schedule|webhooks)$/.test(a.getAttribute("href") ?? "")).map((a) => a.textContent?.trim() ?? "");
      seen.current = current(host);
    });
    await renderPage("/automations/cron_1", async (host) => {
      await eventually(() => host.textContent?.includes("Who and where") === true, 3_000, "the automation");
      seen.one = current(host);
    });
    expect(seen.tabs).toEqual(["Waiting for you", "Automations", "Missions", "Helpers"]);
    expect(seen.current).toEqual(["Work"]);
    expect(seen.one).toEqual(["Work"]);
  });

  test("Schedule's address lands on the list, its link to one job on that automation, and Webhooks' on the list narrowed to webhooks", async () => {
    const landed: Record<string, string> = {};
    for (const path of ["/schedule", "/schedule?job=cron_1", "/webhooks", "/schedule?job=../x"]) {
      await renderPage(path, async (host, app) => {
        await eventually(() => app.location().startsWith("/automations") && (host.querySelector("main")?.textContent ?? "").length > 100, 3_000, `${path} landing`);
        landed[path] = `${app.location()} ${JSON.stringify(app.search())}`;
      });
    }
    expect(landed).toEqual({
      "/schedule": "/automations {}",
      "/schedule?job=cron_1": "/automations/cron_1 {}",
      "/webhooks": '/automations {"start":"webhook"}',
      // A value that is not an id is dropped: the list opens.
      "/schedule?job=../x": "/automations {}",
    });
  });
});

describe("the rows", () => {
  test("each automation is a card that opens its page: its name, how it starts in words, its steps drawn, its agent, its state and its last run", async () => {
    let seen: Record<string, string> = {};
    let hrefs: (string | null)[] = [];
    let previews: (string | null)[] = [];
    await renderPage("/automations", async (host) => {
      await listed(host);
      seen = Object.fromEntries(cards(host).map((one) => [one.dataset.automation!, one.textContent?.replace(/\s+/g, " ").trim() ?? ""]));
      hrefs = cards(host).map((one) => one.querySelector("h2 a")?.getAttribute("href") ?? null);
      previews = cards(host).map((one) => one.querySelector("ol")?.getAttribute("aria-label") ?? null);
    });
    // A change an agent suggested to an automation (cron_2) is not a row of its own: the automation says it waits.
    expect(Object.keys(seen)).toEqual(["cron_3", "cron_1", "cron_4", "cron_5", "cron_6"]);
    expect(seen.cron_3).toStartWith("Morning briefStarts every day at 07:00");
    // One that does a single thing says what, beside its icon; one of several steps draws them and no more.
    expect(seen.cron_3).toContain("Sum up what came in overnight, in five lines.");
    expect(seen.cron_1).not.toContain("Find out why");
    expect(seen.cron_3).toContain("NouvaOn");
    expect(seen.cron_3).toMatch(/, done in 0\.0 s/);
    expect(seen.cron_1).toContain("Waiting for you");
    expect(seen.cron_1).toMatch(/, waiting for you/);
    expect(seen.cron_4).toStartWith("New orderStarts when its address is called");
    expect(seen.cron_4).toContain("Has not run yet");
    expect(seen.cron_5).toStartWith("Backup checkStarts when you press Run now");
    expect(seen.cron_5).toContain("Suggested by Nouva");
    // One that tells once and has told: off, and said so, not as one somebody paused.
    expect(seen.cron_6).toStartWith("Door cameraStarts when its address is called");
    expect(seen.cron_6).toContain("Told you, now off");
    // The server's own line for a start ("cron `0 7 * * *`", "every 10m") is never what a person reads.
    expect(Object.values(seen).join(" ")).not.toMatch(/cron|\d+m\b/);
    expect(hrefs).toEqual(["/dashboard/automations/cron_3", "/dashboard/automations/cron_1", "/dashboard/automations/cron_4", "/dashboard/automations/cron_5", "/dashboard/automations/cron_6"]);
    expect(previews).toEqual(["1 step", "4 steps", "1 step", "2 steps", "2 steps"]);
  });

  test("the steps' drawing holds six kinds, then how many more; a failing one and a paused one say so", async () => {
    const [first] = LIST.automations;
    const steps = Array.from({ length: 9 }, (_, n) => ({ id: `s${n + 1}`, kind: "systemEvent", text: "x" }));
    answer({ "/automations": ok({ ...LIST, automations: [{ ...first!, payload: { kind: "steps", steps } }, { ...first!, id: "cron_f", name: "Sync", failStreak: 2 }, { ...first!, id: "cron_p", name: "Report", enabled: false }] }) });
    const seen = { icons: 0, more: "", label: "", states: [] as string[] };
    await renderPage("/automations", async (host) => {
      await listed(host);
      const preview = card(host, "cron_3").querySelector("ol")!;
      seen.icons = preview.querySelectorAll("li svg").length;
      seen.more = preview.querySelector("li:last-child")?.textContent ?? "";
      seen.label = preview.getAttribute("aria-label") ?? "";
      seen.states = cards(host).map((one) => one.querySelector("footer [data-state]")?.textContent ?? "");
    });
    expect(seen).toEqual({ icons: 6, more: "+3", label: "9 steps", states: ["On", "Failing", "Paused"] });
  });

  test("its switch turns it off and on from the list, and a proposal is turned on where it stands", async () => {
    let sent: { path: string; body: unknown }[] = [];
    let offered: string[] = [];
    await renderPage("/automations", async (host) => {
      await listed(host);
      // A proposal has never run: it has no switch, and the one a change waits on keeps its own.
      offered = cards(host).map((one) => (one.querySelector('[role="switch"]') ? "switch" : [...one.querySelectorAll("button")].map((b) => b.textContent?.trim()).join("+")));
      const record = recordPosts({ "/cron/cron_3/disable": ok({ job: LIST.automations[0] }), "/cron/cron_5/enable": ok({ job: LIST.automations[4] }) });
      (card(host, "cron_3").querySelector('[role="switch"]') as HTMLElement).click();
      await eventually(() => record.posts.length === 1, 2_000, "the switch");
      ([...card(host, "cron_5").querySelectorAll("button")].find((b) => b.textContent?.trim() === "Turn on") as HTMLElement).click();
      await eventually(() => record.posts.length === 2, 2_000, "the turn on");
      record.restore();
      sent = record.posts;
    });
    expect(offered).toEqual(["switch", "switch", "switch", "Turn on+Discard", "switch"]);
    expect(sent).toEqual([{ path: "/cron/cron_3/disable", body: null }, { path: "/cron/cron_5/enable", body: null }]);
  });

  test("an account that only looks is offered no New automation, and its switches take no press", async () => {
    answer(asViewer);
    const seen = { create: true, switches: [] as boolean[] };
    await renderPage("/automations", async (host) => {
      await listed(host);
      seen.create = [...host.querySelectorAll("main a")].some((a) => a.textContent?.includes("New automation"));
      seen.switches = [...host.querySelectorAll<HTMLInputElement>('main [role="switch"]')].map((one) => one.disabled);
    });
    expect(seen).toEqual({ create: false, switches: [true, true, true, true] });
  });
});

describe("narrowing the list", () => {
  test("one dropdown, All, Scheduled, Webhooks and Manual, each with how many: a short list with no field, and its choice is the address's", async () => {
    const seen = { options: [] as string[], counts: [] as string[], field: true, selects: -1, held: "", after: [] as string[], search: {} as Record<string, unknown>, back: 0 };
    await renderPage("/automations", async (host, app) => {
      await listed(host);
      const starts = dropdown(host, "Starts");
      seen.held = starts.button()?.textContent ?? "";
      seen.options = await starts.open();
      seen.counts = [...host.ownerDocument.body.querySelectorAll('[role="listbox"][aria-label="Starts"] [role="option"]')].map((row) => row.textContent ?? "");
      seen.field = host.ownerDocument.body.querySelector('[role="combobox"]') !== null;
      seen.selects = host.querySelectorAll("main select").length;
      await starts.pick("Webhooks");
      await eventually(() => cards(host).length === 2, 2_000, "the webhooks alone");
      seen.after = cards(host).map((one) => one.dataset.automation!);
      seen.search = app.search();
      await starts.pick("All");
      await eventually(() => cards(host).length === 5, 2_000, "all of them again");
      seen.back = Object.keys(app.search()).length;
    });
    expect(seen).toEqual({ options: ["All", "Scheduled", "Webhooks", "Manual"], counts: ["All5", "Scheduled2", "Webhooks2", "Manual1"], field: false, selects: 0, held: "Starts: All", after: ["cron_4", "cron_6"], search: { start: "webhook" }, back: 0 });
  });

  test("the search keeps what holds each word: in a name, an agent, or what a step says; and says when nothing does", async () => {
    const seen = { name: [] as string[], step: [] as string[], none: "" };
    await renderPage("/automations", async (host) => {
      await listed(host);
      const box = host.querySelector('input[aria-label="Find an automation"]') as HTMLInputElement;
      type(box, "order");
      await eventually(() => cards(host).length === 1, 2_000, "one left");
      seen.name = cards(host).map((one) => one.dataset.automation!);
      type(box, "health failed");
      await eventually(() => cards(host)[0]?.dataset.automation === "cron_1", 2_000, "the one a step names");
      seen.step = cards(host).map((one) => one.dataset.automation!);
      type(box, "zebra");
      await eventually(() => cards(host).length === 0, 2_000, "none left");
      seen.none = host.querySelector("main")?.textContent ?? "";
    });
    expect(seen.name).toEqual(["cron_4"]);
    expect(seen.step).toEqual(["cron_1"]);
    expect(seen.none).toContain("Nothing matches “zebra”");
  });
});

describe("with nothing to list, and before it knows", () => {
  const cats = (html: string) => html.slice(html.indexOf("<main")).split("/mascot/").length - 1;

  test("none yet: the cat with its calendar, and how to make the first; one cat, and none beside the title", async () => {
    answer({ "/automations": ok({ automations: [], timezone: "UTC" }) });
    const html = await renderPage("/automations", async (host) => {
      await eventually(() => host.textContent?.includes("No automations yet") === true, 3_000, "the empty list");
    });
    expect(html).toContain("09-schedule");
    expect(cats(html)).toBe(1);
    expect(html.slice(html.indexOf("<header", html.indexOf("<main")), html.indexOf("</header>", html.indexOf("<main")))).not.toContain("/mascot/");
    // Nothing to narrow or to search: neither is drawn.
    expect(html).not.toContain("Find an automation");
  });

  test("none of one kind: what that kind is, each with its own cat, and still one cat", async () => {
    answer({ "/automations": ok({ ...LIST, automations: LIST.automations.filter((one) => one.start === "scheduled") }) });
    const hooks = await renderPage("/automations?start=webhook", async (host) => {
      await eventually(() => host.textContent?.includes("No webhooks yet") === true, 3_000, "no webhooks");
    });
    expect(hooks).toContain("06-sent");
    expect(cats(hooks)).toBe(1);
    const manual = await renderPage("/automations?start=manual", async (host) => {
      await eventually(() => host.textContent?.includes("Nothing to start by hand yet") === true, 3_000, "nothing by hand");
    });
    expect(manual).toContain("03-scooter-lean");
    expect(cats(manual)).toBe(1);
  });

  test("while it loads it is the shape of its cards, never its empty list; and with rows the cat is beside the title", async () => {
    answer({ "/automations": { status: 200, body: {}, hold: true } });
    const loading = await renderPage("/automations", async (host) => {
      await eventually(() => host.querySelector('main [aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(loading).toContain("animate-pulse");
    expect(loading).toContain("md:grid-cols-2");
    expect(loading).not.toContain("No automations yet");
    answer({});
    const html = await renderPage("/automations", async (host) => {
      await eventually(() => host.querySelector("main header img") !== null, 3_000, "the title's cat");
    });
    expect(cats(html)).toBe(1);
  });

  test("not turned on is said only when the server says so; a server still starting is an error, said as one", async () => {
    answer({ "/automations": { status: 501, body: { error: "the scheduler is not enabled" } } });
    const off = await renderPage("/automations", async (host) => {
      await eventually(() => host.textContent?.includes("not turned on") === true, 3_000, "not turned on");
    });
    expect(off).toContain("Automations are not turned on for this server.");
    answer({ "/automations": { status: 503, body: { error: "nouride is starting: opening the database" } } });
    const starting = await renderPage("/automations", async (host) => {
      await eventually(() => host.textContent?.includes("nouride is starting") === true, 6_000, "the error");
    });
    expect(starting).not.toContain("not turned on");
  });
});
