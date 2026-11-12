/**
 * A change an agent suggested to an automation, on that automation's page: a banner that says who suggests it and what
 * it would do, Accept and Discard, and the steps drawn as they run now or as they would be, with what would be added,
 * changed and removed marked. Nothing changes until Accept.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep } from "@nouride/wire";
import { answer, buttons, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, STEPS, automation, detail, drawn, flowDrawn, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const [CHECK, , , TELL] = STEPS as [AutomationStep, AutomationStep, AutomationStep, AutomationStep];
/** The agent's version: the second step asks something else, the wait for a person is gone, and a step is added at the end. */
const SUGGESTED: AutomationStep[] = [CHECK, { id: "find", kind: "agentTurn", message: "Find out why, and how long it was down." }, TELL, { id: "log", kind: "command", name: "Note it down", argv: ["sh", "-lc", "date >> outages.log"] }];
const current = automation({ suggested: "cron_s" });
const change = automation({ id: "cron_s", enabled: false, payload: { kind: "steps", steps: SUGGESTED }, proposal: { by: "nouva", at: 1, replaces: "cron_e" } });
const banner = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Suggested change"]');
const tags = (host: HTMLElement) => Object.fromEntries(drawn(host).map((id) => [id, stepCard(host, id).querySelector("[data-tag]")?.textContent ?? ""]));
const side = (host: HTMLElement, label: string) => ([...banner(host)!.querySelectorAll("button")].find((button) => button.textContent === label) as HTMLElement).click();

describe("a suggested change", () => {
  test("the banner says who suggests it and what it would do, and the steps as they run now are marked with what would change and go", async () => {
    answer({ [PAGE]: detail(current, [], change) });
    const seen = { text: "", labels: [] as string[], tags: {} as Record<string, string>, states: {} as Record<string, string | undefined>, editable: false };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.text = banner(host)?.textContent ?? "";
      seen.labels = [...banner(host)!.querySelectorAll("button")].map((button) => button.textContent ?? "");
      seen.tags = tags(host);
      seen.states = Object.fromEntries(drawn(host).map((id) => [id, stepCard(host, id).dataset.state]));
      // It runs as it is until then, and is still the person's to change.
      seen.editable = host.querySelector('[aria-label="Edit step 1"]') !== null;
    });
    expect(seen.text).toContain("Nouva suggests a change");
    expect(seen.text).toContain("Adds step 4. Changes step 2. Removes step 3 of the ones it runs now. Nothing changes until you accept it.");
    expect(seen.labels).toEqual(["Accept", "Discard", "Current", "Suggested"]);
    expect(seen.tags).toEqual({ check: "", find: "Would change", ok: "Would be removed", tell: "" });
    expect(seen.states).toEqual({ check: undefined, find: undefined, ok: "leaving", tell: undefined });
    expect(seen.editable).toBe(true);
  });

  test("Suggested draws the steps as they would be, the new one marked, and only to be read", async () => {
    answer({ [PAGE]: detail(current, [], change) });
    const seen = { order: [] as string[], tags: {} as Record<string, string>, added: "", words: "", edits: -1, pressed: [] as (string | null)[], back: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      side(host, "Suggested");
      await eventually(() => drawn(host).includes("log"), 2_000, "the suggested steps");
      seen.order = drawn(host);
      seen.tags = tags(host);
      seen.added = stepCard(host, "log").dataset.state ?? "";
      seen.words = stepCard(host, "find").textContent ?? "";
      seen.edits = host.querySelectorAll('[aria-label^="Edit step"], [aria-label^="Add a step"], [aria-label^="Move step"]').length;
      seen.pressed = [...banner(host)!.querySelectorAll('[role="group"] button')].map((button) => button.getAttribute("aria-pressed"));
      side(host, "Current");
      await eventually(() => drawn(host).includes("ok"), 2_000, "the steps as they run");
      seen.back = drawn(host);
    });
    expect(seen.order).toEqual(["check", "find", "tell", "log"]);
    expect(seen.tags).toEqual({ check: "", find: "Would change", tell: "", log: "Suggested" });
    expect(seen.added).toBe("suggested");
    expect(seen.words).toContain("Find out why, and how long it was down.");
    expect(seen.edits).toBe(0);
    expect(seen.pressed).toEqual(["false", "true"]);
    expect(seen.back).toEqual(["check", "find", "ok", "tell"]);
  });

  test("Accept turns the suggestion on, and Discard deletes it: each is sent for the suggestion, never for the automation", async () => {
    answer({ [PAGE]: detail(current, [], change) });
    let posted: { path: string; body: unknown }[] = [];
    const deleted: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(new URL(String(input), "http://localhost").pathname.replace("/api/control", ""));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, id: "cron_s" }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    const said: string[] = [];
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        const record = recordPosts({ "/cron/cron_s/enable": ok({ job: current }) });
        ([...banner(host)!.querySelectorAll("button")].find((button) => button.textContent === "Accept") as HTMLElement).click();
        await eventually(() => record.posts.length === 1, 2_000, "the accept");
        await eventually(() => host.textContent?.includes("You accepted Nouva's change") === true, 2_000, "what was said");
        said.push("accepted");
        record.restore();
        posted = record.posts;
      });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        ([...banner(host)!.querySelectorAll("button")].find((button) => button.textContent === "Discard") as HTMLElement).click();
        await eventually(() => deleted.length === 1, 2_000, "the discard");
        await eventually(() => host.textContent?.includes("You discarded Nouva's change") === true, 2_000, "what was said");
        said.push("discarded");
      });
    } finally {
      globalThis.fetch = spy;
    }
    expect(posted).toEqual([{ path: "/cron/cron_s/enable", body: null }]);
    expect(deleted).toEqual(["/cron/cron_s"]);
    expect(said).toEqual(["accepted", "discarded"]);
  });

  test("with changes of your own unsaved it waits for them, and says why; an account that only looks is offered neither answer", async () => {
    answer({ [PAGE]: detail(current, [], change) });
    const seen = { disabled: [] as boolean[], why: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Shop watch");
      await eventually(() => saveBar(host) !== null, 2_000, "the bar");
      seen.disabled = [...banner(host)!.querySelectorAll<HTMLButtonElement>("button")].filter((button) => ["Accept", "Discard"].includes(button.textContent ?? "")).map((button) => button.disabled);
      seen.why = banner(host)?.textContent ?? "";
    });
    expect(seen.disabled).toEqual([true, true]);
    expect(seen.why).toContain("Save or discard your own changes first.");

    answer({ [PAGE]: detail(current, [], change), ...AS_VIEWER });
    let labels: string[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      labels = buttons(host).filter((label) => ["Accept", "Discard", "Current", "Suggested"].includes(label));
    });
    expect(labels).toEqual(["Current", "Suggested"]);
  });

  test("the engine's own answer: an automation with a change waiting names it, and the change adds its step", async () => {
    let seen = { text: "", order: [] as string[] };
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      // Its newest run waits for a person, so the page opens on the run; the change is over the steps.
      expect(banner(host)).toBeNull();
      ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Steps") as HTMLElement).click();
      await eventually(() => banner(host) !== null, 2_000, "the banner");
      side(host, "Suggested");
      await eventually(() => drawn(host).includes("log"), 2_000, "the suggested steps");
      seen = { text: banner(host)?.textContent ?? "", order: drawn(host) };
    });
    expect(seen.text).toContain("Adds step 5.");
    expect(seen.order).toEqual(["check", "find", "ok", "tell", "log"]);
  });
});
