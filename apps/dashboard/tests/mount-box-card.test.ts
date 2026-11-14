/**
 * "Your box", at the sidebar's foot: all of it one way to the Update page, a newer version out or not. It opened
 * Settings unless an update was waiting, and a press on the version to see what there was to update landed on a list
 * of everything else.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, RESPONSES, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const UPDATE = RESPONSES["/update"] as { check: object } & Record<string, unknown>;
const card = (host: HTMLElement) => [...host.ownerDocument.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Your box"));
const said = (host: HTMLElement) => (card(host)?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the box's card", () => {
  test("with a newer version out: one link to the Update page, the news inside it", async () => {
    answer({});
    await renderPage("/", async (host, app) => {
      await eventually(() => said(host).includes("is out"), 3_000, "the card with its news");
      expect(card(host)!.getAttribute("href")).toBe("/dashboard/update");
      expect(said(host)).toContain("0.7.10 is out");
      // The whole card is the link: nothing inside it leads anywhere else, Settings least of all.
      expect(card(host)!.querySelectorAll("a")).toHaveLength(0);
      expect(card(host)!.parentElement!.querySelectorAll('a[href="/dashboard/settings"]')).toHaveLength(0);
      card(host)!.click();
      await eventually(() => app.location() === "/update", 3_000, "the Update page");
    });
  });

  test("with nothing newer: the same link, and no news", async () => {
    answer({ "/update": { status: 200, body: { ...UPDATE, check: { ...UPDATE.check, latest: "0.7.9", newer: false } } } });
    await renderPage("/", async (host, app) => {
      await eventually(() => said(host).includes("v0.7.9"), 3_000, "the card with its version");
      expect(card(host)!.getAttribute("href")).toBe("/dashboard/update");
      expect(said(host)).not.toContain("is out");
      expect(said(host)).not.toContain("Update ready");
      card(host)!.click();
      await eventually(() => app.location() === "/update", 3_000, "the Update page");
    });
  });

  test("where the update check does not answer: still the way to its page, which says why", async () => {
    answer({ "/update": { status: 503, body: { error: "unreachable" } } });
    await renderPage("/", async (host) => {
      await eventually(() => card(host) !== undefined, 3_000, "the card");
      expect(card(host)!.getAttribute("href")).toBe("/dashboard/update");
    });
  });
});
