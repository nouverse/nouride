/**
 * "While an agent works" on Agent Settings (`agents/components/SteeringControl.tsx`): `[queue] steer_ack` beside
 * `steer_reply`, through the whole app. A switch that shows another value than the daemon's, or a save that sends
 * the other key, is what these catch.
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/agents/settings";
const STEERING = "/policy/steering";
const ok = (body: unknown) => ({ status: 200, body });
const card = (host: HTMLElement) => host.querySelector<HTMLElement>('section[aria-label="While an agent works"]');
const toggle = (host: HTMLElement, key: "ack" | "reply") => card(host)?.querySelector<HTMLInputElement>(`input[data-steering="${key}"]`) ?? null;
const save = (host: HTMLElement) => [...(card(host)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.trim() === "Save");

describe("While an agent works", () => {
  test("offers steer_ack beside steer_reply in plain words, as the daemon has them", async () => {
    answer({ [STEERING]: ok({ reply: true, ack: false, editable: true }) });
    const seen = { text: "", ack: true, reply: false };
    await renderPage(PAGE, async (host) => {
      await eventually(() => toggle(host, "ack") !== null, 3_000, "the card");
      seen.text = card(host)!.textContent ?? "";
      seen.ack = toggle(host, "ack")!.checked;
      seen.reply = toggle(host, "reply")!.checked;
    });
    expect(seen.text).toContain("Say \"Got it\" at once when a message arrives while the agent works");
    expect(seen).toMatchObject({ ack: false, reply: true });
  });

  test("turning \"Got it\" off sends steer_ack alone", async () => {
    answer({ [STEERING]: ok({ reply: true, ack: true, editable: true }) });
    const posted = recordPosts({ [STEERING]: ok({ ok: true, reply: true, ack: false }) });
    try {
      await renderPage(PAGE, async (host) => {
        await eventually(() => toggle(host, "ack") !== null, 3_000, "the card");
        expect(save(host)!.disabled).toBe(true);
        toggle(host, "ack")!.click();
        await eventually(() => save(host)?.disabled === false, 2_000, "Save offered");
        save(host)!.click();
        await eventually(() => posted.posts.some((post) => post.path === STEERING), 2_000, "the save");
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts.filter((post) => post.path === STEERING).map((post) => post.body)).toEqual([{ ack: false }]);
  });
});
