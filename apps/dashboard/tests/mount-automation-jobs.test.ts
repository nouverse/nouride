/**
 * What the Schedule and Webhooks pages did for a job, on its automation's page: Run now says how it went (a refusal
 * came back as a 200 and read as success, and a run longer than the request's wait went quiet), a switch that failed
 * says so, a chat is named and not a bare id, a webhook says whether a call from outside can arrive and takes a test,
 * and a run that started a mission links to it.
 */

import { describe, expect, test } from "bun:test";
import { answer, buttons, errors, press, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { automation, detail, flowDrawn, labelled, ok, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const runNow = (host: HTMLElement) => ([...host.querySelectorAll("header button")].find((button) => button.textContent?.trim() === "Run now") as HTMLElement).click();
const view = (host: HTMLElement) => host.querySelector("[data-flow]")?.getAttribute("data-flow");

describe("Run now", () => {
  test("a refusal is said, not taken for success, and the page stays on the steps", async () => {
    answer({ [PAGE]: detail(automation()), "/cron/cron_e/run": ok({ outcome: { status: "unavailable", result: "that job is already running" } }) });
    let seen = { text: "", view: "" as string | null | undefined };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      runNow(host);
      await eventually(() => host.textContent?.includes("did not start") === true, 2_000, "the refusal");
      seen = { text: host.textContent ?? "", view: view(host) };
    });
    expect(seen.text).toContain("Shop check did not start");
    expect(seen.text).toContain("that job is already running");
    expect(seen.view).toBe("edit");
  });

  test("a run that outlasts the wait says it is still going, and the page draws the run to follow it", async () => {
    const running = { id: "run_1", jobId: "cron_e", startedAt: Date.now(), status: "running" as const, steps: [{ id: "check", kind: "command" as const, status: "running" as const, startedAt: Date.now() }] };
    answer({ [PAGE]: detail(automation()), "/cron/cron_e/run": { status: 202, body: { outcome: { status: "running" } } } });
    let seen = { text: "", view: "" as string | null | undefined, chip: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      // The run is there by the time the page asks again.
      answer({ [PAGE]: detail(automation(), [running]), "/cron/cron_e/run": { status: 202, body: { outcome: { status: "running" } } } });
      runNow(host);
      await eventually(() => view(host) === "run", 3_000, "the run drawn");
      seen = { text: host.textContent ?? "", view: view(host), chip: stepCard(host, "check").querySelector("[data-tone]")?.textContent ?? "" };
    });
    expect(seen.text).toContain("Shop check is still running");
    expect(seen.view).toBe("run");
    expect(seen.chip).toBe("Working");
  });

  test("a step that waits says so; an outcome is said with its result; and a switch that failed says so", async () => {
    answer({ [PAGE]: detail(automation()), "/cron/cron_e/run": ok({ outcome: { status: "success", result: "backed up 3 files" } }), "/cron/cron_e/disable": { status: 500, body: { error: "the store is locked" } } });
    let text = "";
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      runNow(host);
      await eventually(() => host.textContent?.includes("Shop check ran") === true, 2_000, "the outcome");
      (host.querySelector('header [role="switch"]') as HTMLElement).click();
      await eventually(() => host.textContent?.includes("Could not turn Shop check off") === true, 2_000, "the failure");
      text = host.textContent ?? "";
    });
    expect(text).toContain("backed up 3 files");
    expect(text).toContain("the store is locked");
  });

  test("with changes unsaved it is not offered: it would run what is saved, not what is on the page", async () => {
    answer({ [PAGE]: detail(automation()) });
    let seen = { disabled: false, why: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      labelled(host, "More for step 1").click();
      const item = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="menu"] button')].find((button) => button.textContent?.trim() === "Move down");
      await eventually(() => item() !== undefined, 2_000, "the menu");
      item()!.click();
      const run = () => [...host.querySelectorAll<HTMLButtonElement>("header button")].find((button) => button.textContent?.trim() === "Run now")!;
      await eventually(() => run().disabled, 2_000, "Run now held");
      seen = { disabled: run().disabled, why: run().getAttribute("title") };
    });
    expect(seen).toEqual({ disabled: true, why: "Save or discard your changes first" });
  });
});

test("one that keeps failing says so at its head, with where to look; one that runs well says nothing", async () => {
  const failed = { id: "r1", jobId: "cron_e", startedAt: 1, finishedAt: 2, status: "error" as const, result: "exit 1" };
  const said: (string | null)[] = [];
  for (const failStreak of [3, 1, 0]) {
    answer({ [PAGE]: detail(automation({ failStreak }), [failed]) });
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      said.push(host.querySelector('main header [role="status"]')?.textContent ?? null);
    });
  }
  expect(said).toEqual(["Its last 3 runs failed. Last run shows which step, and why.", "Its last run failed. Last run shows which step, and why.", null]);
});

describe("who and where", () => {
  test("where it reports is a chat by name, a one-to-one and with whom, not a bare id; a mission always tells its chat", async () => {
    const chats = [
      { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: ["Gading"], lastActive: 2 },
      { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: ["Gading"], lastActive: 1 },
    ];
    answer({ [PAGE]: detail(automation({ payload: { kind: "mission", goal: "Sum up the week's mail." }, target: { gatewayId: "telegram:nouva", chatId: "5550001111" } })), "/chats": ok({ chats }) });
    const seen = { head: "", who: "", step: "", offered: "", quiet: false, hint: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      await eventually(() => host.textContent?.includes("DM · Gading") === true, 2_000, "the chat's name");
      seen.head = host.querySelector("main header")?.textContent ?? "";
      const who = host.querySelector<HTMLElement>('[aria-label="Who and where"]')!;
      seen.who = who.textContent ?? "";
      seen.step = stepCard(host, "s1").textContent ?? "";
      ([...who.querySelectorAll("button")].find((button) => button.textContent === "Change") as HTMLElement).click();
      await eventually(() => who.querySelector('input[placeholder="Pick a chat, or type its id"]') !== null, 2_000, "the picker");
      (who.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement).focus();
      // The list is drawn on the page's body, over every card.
      await eventually(() => host.ownerDocument.body.querySelector('[role="listbox"]')?.textContent?.includes("DM · Gading") === true, 2_000, "the list");
      seen.offered = host.ownerDocument.body.querySelector('[role="listbox"]')?.textContent ?? "";
      const quiet = who.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      seen.quiet = quiet.disabled && quiet.checked;
      seen.hint = who.textContent ?? "";
    });
    expect(seen.head).toContain("Reports to DM · Gading.");
    expect(seen.who).toContain("Nouva runs it and tells DM · Gading how each run went.");
    expect(seen.step).toContain("Step 1 · Start a missionSum up the week's mail.");
    // Narrowed to what the field holds: the chat it reports to now, by its name.
    expect(seen.offered).toContain("DM · Gading5550001111");
    expect(seen.quiet).toBe(true);
    expect(seen.hint).toContain("A mission tells its chat when it is done or needs someone, so this stays on.");
  });
});

describe("a webhook", () => {
  const hook = (reach: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    automation({ id: "cron_e", name: "CI failures", start: "webhook", trigger: { kind: "webhook" }, payload: { kind: "agentTurn", message: "look at it" }, hook: { webhookToken: "tok", path: "/hooks/tok", url: "https://box.example.com/hooks/tok", urlGuessed: false, reach: reach as never, ...over } });

  test("says whether a call from outside can arrive, shows the address it is handed out under, and Send a test goes to its test route", async () => {
    answer({ [PAGE]: detail(hook({ state: "unknown", why: "Not tested yet. Send a test to find out." })) });
    let page = "";
    let sent: { path: string; body: unknown }[] = [];
    let tests = 0;
    await renderPage(PAGE, async (host) => {
      await eventually(() => host.textContent?.includes("Reach unknown") === true, 3_000, "the webhook");
      page = host.querySelector('[aria-label="Start"]')?.textContent ?? "";
      tests = buttons(host).filter((label) => label === "Send a test").length;
      const record = recordPosts({ "/webhooks/cron_e/test": ok({ webhook: {} }) });
      press(host, "Send a test");
      await eventually(() => record.posts.length > 0, 2_000, "the test");
      record.restore();
      sent = record.posts;
    });
    expect(page).toContain("when its address is called");
    // The public address: what a service outside is handed, and what the test goes through.
    expect(page).toContain("https://box.example.com/hooks/tok");
    expect(page).toContain("Anyone with this address can start it");
    expect(page).toContain("How to call it");
    expect(tests).toBe(1);
    expect(sent).toEqual([{ path: "/webhooks/cron_e/test", body: {} }]);
    expect(errors.filter((line) => /Error|Cannot read/.test(line))).toEqual([]);
  });

  test("one only this network reaches says so and what would change it, with nothing to test through", async () => {
    answer({ [PAGE]: detail(hook({ state: "local", why: "No public address is set, so only this network can call it." }, { url: "http://localhost:18254/hooks/tok", urlGuessed: true })) });
    let page = "";
    let tests = 0;
    await renderPage(PAGE, async (host) => {
      await eventually(() => host.textContent?.includes("Local network only") === true, 3_000, "the webhook");
      page = host.querySelector('[aria-label="Start"]')?.textContent ?? "";
      tests = buttons(host).filter((label) => label === "Send a test").length;
    });
    expect(page).toContain("No public address is set");
    expect(page).toContain("this server needs an address the internet can reach");
    // The browser's own address: the server knows only what it bound to.
    expect(page).toContain("http://localhost/hooks/tok");
    expect(tests).toBe(0);
  });

  test("a run that started a mission links to it", async () => {
    const one = hook({ state: "unknown", why: "Not tested yet." });
    answer({ [PAGE]: detail({ ...one, payload: { kind: "mission", goal: "Look into the new issue." } }, [{ id: "r1", jobId: "cron_e", startedAt: 1, finishedAt: 2, status: "success", result: "started mission msn_1a2b" }]) });
    let links: string[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Last run") as HTMLElement).click();
      await eventually(() => host.textContent?.includes("started mission") === true, 2_000, "the run");
      links = [...host.querySelectorAll("main a")].map((a) => a.getAttribute("href") ?? "").filter((href) => href.includes("msn_"));
    });
    expect(links).toEqual([expect.stringContaining("/missions/msn_1a2b")]);
  });
});
