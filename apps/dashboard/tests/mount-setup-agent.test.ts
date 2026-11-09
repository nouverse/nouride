/**
 * The setup wizard's first agent, mounted (0.8.20): a Nourider named Nourider, its headline and personality filled in
 * from the Pilot's preset as the New Agent form fills a Pilot's, and sent as one. In a file of its own over the shared
 * harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

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
test("the setup wizard's model field starts empty, and its suggestions come once something is typed", async () => {
  // As on a phone: the provider step comes first and leaves the models it found in the cache (`setQueryData`), so the
  // agent step mounts with them at hand, which is when the first one was chosen for the person.
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
    const field = host.querySelector<HTMLInputElement>("#setup-model")!;
    const list = () => document.body.querySelector('[role="listbox"]');
    const rows = () => [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].map((row) => row.textContent ?? "");
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
