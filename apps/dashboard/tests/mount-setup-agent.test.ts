/**
 * The setup wizard's first agent, mounted (0.8.20): a Nourider named Nourider, its headline and personality filled in
 * from the Pilot's preset as the New Agent form fills a Pilot's, and sent as one. In a file of its own over the shared
 * harness (`mount-harness.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { answer, dom, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();
// A test that makes the window a phone's leaves it one for the tests after it.
afterEach(() => {
  dom.happyDOM.setViewport({ width: 1024, height: 768 });
});

// The owner, 2026-11-06: the wizard's first agent is the Nourider template, named Nourider, its headline and SOUL.md
// filled in as the New Agent form fills a Pilot's. It had "My First Agent" and a generic prompt of its own.
test("the setup wizard's first agent is a Nourider named Nourider, the Nourider's headline and personality filled in", async () => {
  answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: true, hasAgent: false } } });
  const pilot = (WIRE["/setup/presets"] as { presets: { id: string; headline: string; soul: string }[] }).presets.find((preset) => preset.id === "nourider")!;
  const record = recordPosts({ "/setup/agent": { status: 200, body: { ok: true, id: "nourider", provider: "default" } } });
  try {
    await renderPage("/setup", async (host) => {
      const field = (label: string) => [...host.querySelectorAll("label")].find((element) => element.textContent?.includes(label))?.querySelector<HTMLInputElement>("input") ?? null;
      await eventually(() => host.querySelector<HTMLTextAreaElement>("textarea")?.value === pilot.soul, 2_000, "the Pilot's personality filled in");
      expect(field("Display Name")?.value).toBe("Nourider");
      expect(field("Agent ID")?.value).toBe("nourider");
      expect(host.querySelector<HTMLInputElement>("#setup-headline")?.value).toBe(pilot.headline);
      type(host.querySelector<HTMLInputElement>("#setup-model")!, "model-one");
      await enabled(host, "Complete Setup & Enter Dashboard");
      press(host, "Complete Setup & Enter Dashboard");
      await eventually(() => record.posts.some((post) => post.path === "/setup/agent"), 2_000, "the agent sent");
    });
    expect(record.posts.find((post) => post.path === "/setup/agent")?.body).toMatchObject({ id: "nourider", display_name: "Nourider", system_prompt: pilot.soul, headline: pilot.headline, preset: "nourider" });
  } finally {
    record.restore();
  }
});

// Nouride Home's first open of the dashboard (2026-11-07): an unfinished install opened at Overview drew Overview for a
// moment, then went to the setup wizard. The page asked for is not drawn while the redirect is on its way.
test("an unfinished install opened at Overview goes to the setup wizard without drawing Overview first", async () => {
  answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false } } });
  let drewOverview = false;
  const observer = new MutationObserver(() => {
    if ((document.body.textContent ?? "").includes("Overview")) drewOverview = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    const html = await renderPage("/", async (host, app) => {
      await eventually(() => app.location() === "/dashboard/setup" || app.location() === "/setup", 2_000, "sent to the setup wizard");
      await eventually(() => (host.textContent ?? "").includes("Set up Nouride"), 2_000, "the wizard drawn");
    });
    expect(html).toContain("Set up Nouride");
  } finally {
    observer.disconnect();
  }
  expect(drewOverview).toBe(false);
});

// The owner, 2026-11-07, on a phone: the model picker chose the first model for them, and its list opened on focus and
// jumped as the keyboard came up and with every keystroke. The field starts empty, and suggestions come as they type.
/** The wizard at its agent step, with the models the provider step left in the cache, as it leaves them. */
async function atTheAgentStep(run: (field: HTMLInputElement, list: () => Element | null, rows: () => string[]) => Promise<void>): Promise<void> {
  answer({
    "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false } },
    "/setup/models": { status: 200, body: { ok: true, models: ["model-one", "model-two", "other-three"] } },
  });
  await renderPage("/setup", async (host, app) => {
    await eventually(() => (host.textContent ?? "").includes("Set up Nouride"), 2_000, "the wizard drawn");
    app.queryClient.setQueryData(["models"], ["model-one", "model-two", "other-three"]);
    answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: true, hasAgent: false } } });
    await app.queryClient.invalidateQueries({ queryKey: ["setup"] });
    await eventually(() => host.querySelector("#setup-model") !== null, 2_000, "the agent step");
    const list = () => document.body.querySelector('[role="listbox"]');
    const rows = () => [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].map((row) => row.textContent ?? "");
    await run(host.querySelector<HTMLInputElement>("#setup-model")!, list, rows);
  });
}

test("on a phone the setup wizard's model field starts empty, and its suggestions come once something is typed", async () => {
  // The keyboard a focus brings up there moved a list opened on it under the finger, and with every keystroke after.
  dom.happyDOM.setViewport({ width: 390, height: 844 });
  await atTheAgentStep(async (field, list, rows) => {
    expect(field.value).toBe("");
    // React draws what a focus does before focus() returns: a list opened on it would be there now.
    field.focus();
    await eventually(() => field.ownerDocument.activeElement === field, 2_000, "the field focused");
    expect(list()).toBeNull();
    type(field, "model");
    await eventually(() => list() !== null, 2_000, "suggestions once typed");
    expect(rows().some((row) => row.includes("model-one"))).toBe(true);
    expect(rows().some((row) => row.includes("other-three"))).toBe(false);
    type(field, "");
    await eventually(() => list() === null, 2_000, "none for an emptied field");
  });
});

test("in a wide window the model field, still empty, lists every model as it takes the focus, and one is picked from it", async () => {
  // Nobody making their first agent knows a model's name to type: with nothing listed there was nothing to pick from.
  await atTheAgentStep(async (field, list, rows) => {
    expect(field.value).toBe("");
    expect(list()).toBeNull();
    field.focus();
    await eventually(() => list() !== null, 2_000, "the list on focus");
    expect(rows()).toHaveLength(3);
    expect(["model-one", "model-two", "other-three"].every((model) => rows().some((row) => row.includes(model)))).toBe(true);
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"] button')].find((option) => option.textContent?.includes("model-two"))!.click();
    await eventually(() => field.value === "model-two", 2_000, "the model picked");
    // Emptied again, the whole list is back: what there is to pick from is never a keystroke away.
    type(field, "");
    await eventually(() => rows().length === 3, 2_000, "the whole list for an emptied field");
  });
});
