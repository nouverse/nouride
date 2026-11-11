/**
 * A step of an automation that waits for a person is among what waits for you: listed on Work's first tab and on Home
 * with the automation's name, the question, what the step before said, Continue and Stop, and a way to the automation,
 * and counted in the menu's badge. Over the engine's own answer (`fixtures/wire.json`): one such step.
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, ok } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** Nothing else waits, so what is counted and listed is the step alone. */
const ONLY_STEPS = { "/approvals": ok({ pending: [] }), "/missions": ok({ missions: [] }) };
const card = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("main div")].find((one) => one.querySelector(":scope > a")?.textContent?.includes("Open the automation")) ?? null;
const badge = (host: HTMLElement) => host.querySelector('nav[aria-label="Menu"] a[href="/dashboard/work"] .badge')?.textContent ?? null;
/** The same count on a phone's tab bar, which is drawn beside the menu and shown below a laptop's width. */
const tabBadge = (host: HTMLElement) => host.querySelector('nav[aria-label="Tabs"] a[href="/dashboard/work"] .badge')?.textContent ?? null;
/** How many things Home's greeting says need you. */
const needs = (host: HTMLElement) => Number(/(\d+) things? needs? you/.exec(host.querySelector("main")?.textContent ?? "")?.[1] ?? 0);

describe("Waiting for you", () => {
  test("lists the step: whose automation, the question, what came before it, the two answers, and the way to it", async () => {
    answer(ONLY_STEPS);
    const seen = { text: "", folded: false, link: "", labels: [] as string[] };
    await renderPage("/work", async (host) => {
      await eventually(() => card(host) !== null, 3_000, "the step");
      const step = card(host)!;
      seen.text = step.textContent ?? "";
      seen.folded = step.querySelector("details") !== null && !step.querySelector("details")!.hasAttribute("open");
      seen.link = step.querySelector(":scope > a")?.getAttribute("href") ?? "";
      seen.labels = [...step.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
    });
    expect(seen.text).toContain("Needs you");
    expect(seen.text).toContain("Shop health check · Nouva");
    expect(seen.text).toContain("Send what was found to the group?");
    expect(seen.text).toContain("The payment service was restarting after its update.");
    expect(seen.folded).toBe(true);
    expect(seen.link).toBe("/dashboard/automations/cron_1");
    expect(seen.labels).toEqual(["Continue", "Stop"]);
  });

  test("Continue and Stop are sent as the answer to that run, and say what happened", async () => {
    answer(ONLY_STEPS);
    const sent: { path: string; body: unknown }[] = [];
    const said: string[] = [];
    for (const label of ["Continue", "Stop"]) {
      await renderPage("/work", async (host) => {
        await eventually(() => card(host) !== null, 3_000, "the step");
        const record = recordPosts({ "/automations/runs/run_1/answer": ok({ ok: true }) });
        ([...card(host)!.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLElement).click();
        await eventually(() => record.posts.length === 1, 2_000, "the answer");
        const word = label === "Continue" ? "Continued" : "Stopped";
        await eventually(() => host.textContent?.includes(word) === true, 2_000, "the toast");
        said.push(word);
        record.restore();
        sent.push(...record.posts);
      });
    }
    expect(sent).toEqual([{ path: "/automations/runs/run_1/answer", body: { go: true } }, { path: "/automations/runs/run_1/answer", body: { go: false } }]);
    expect(said).toEqual(["Continued", "Stopped"]);
  });

  test("it is counted in the menu's badge, with whatever else waits; with nothing waiting the page says so and the badge is gone", async () => {
    answer(ONLY_STEPS);
    const counted: (string | null)[] = [];
    const phone: (string | null)[] = [];
    await renderPage("/work", async (host) => {
      await eventually(() => badge(host) !== null, 3_000, "the badge");
      counted.push(badge(host));
      phone.push(tabBadge(host));
    });
    expect(phone).toEqual(["1"]);

    answer({ ...ONLY_STEPS, "/automations/waiting": ok({ waiting: [] }) });
    let text = "";
    await renderPage("/work", async (host) => {
      await eventually(() => host.textContent?.includes("Nothing is waiting for you") === true, 3_000, "nothing waiting");
      counted.push(badge(host));
      text = host.querySelector("main")?.textContent ?? "";
    });
    expect(counted).toEqual(["1", null]);
    expect(text).not.toContain("Open the automation");
  });

  test("an account that only looks is shown the question and no answer to give", async () => {
    answer({ ...ONLY_STEPS, ...AS_VIEWER });
    let seen = { labels: [] as string[], text: "" };
    await renderPage("/work", async (host) => {
      await eventually(() => card(host) !== null, 3_000, "the step");
      seen = { labels: [...card(host)!.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? ""), text: card(host)!.textContent ?? "" };
    });
    expect(seen.labels).toEqual([]);
    expect(seen.text).toContain("Send what was found to the group?");
    expect(seen.text).toContain("Someone who may change automations can answer this.");
  });
});

test("Home lists it among what needs you, answered there too, and counts it in its greeting", async () => {
  answer(ONLY_STEPS);
  let sent: { path: string; body: unknown }[] = [];
  const seen = { text: "", needs: 0 };
  await renderPage("/", async (host) => {
    await eventually(() => card(host) !== null, 4_000, "the step on Home");
    seen.text = card(host)!.textContent ?? "";
    seen.needs = needs(host);
    const record = recordPosts({ "/automations/runs/run_1/answer": ok({ ok: true }) });
    ([...card(host)!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Continue") as HTMLElement).click();
    await eventually(() => record.posts.length === 1, 2_000, "the answer");
    record.restore();
    sent = record.posts;
  });
  expect(seen.text).toContain("Shop health check · Nouva");
  expect(seen.text).toContain("Send what was found to the group?");
  // Counted once in what needs you: one more than the same Home with no step waiting.
  let without = -1;
  answer({ ...ONLY_STEPS, "/automations/waiting": ok({ waiting: [] }) });
  await renderPage("/", async (host) => {
    await eventually(() => needs(host) > 0, 4_000, "the greeting");
    without = needs(host);
  });
  expect(seen.needs).toBe(without + 1);
  expect(sent).toEqual([{ path: "/automations/runs/run_1/answer", body: { go: true } }]);
});
