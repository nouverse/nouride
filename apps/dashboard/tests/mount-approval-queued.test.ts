/**
 * A pending approval its chat has not been asked yet (0.8.7). A chat is put one question at a time, and the dashboard
 * lists every pending one — so the ones still waiting their turn there read as prompts lost on the way to the chat.
 * The card says which they are. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const request = (id: string, command: string, queued?: true) => ({
  id,
  agentId: "nix",
  chatId: "8142",
  tool: "exec",
  params: { command },
  grantable: false,
  requestedAt: 0,
  timeoutMs: 60_000,
  ...(queued ? { queued } : {}),
});

test("Home marks the pending approval the chat has not been asked yet, and only that one", async () => {
  // Tool calls alone wait here: no step of an automation, which the engine's own fixture has one of.
  answer({ "/approvals": { status: 200, body: { pending: [request("apr_1", "git push"), request("apr_2", "ls /tmp", true)] } }, "/automations/waiting": { status: 200, body: { waiting: [] } } });
  let cards: { command: string; marked: boolean }[] = [];
  await renderPage("/", async (host) => {
    await eventually(() => host.textContent?.includes("ls /tmp") === true, 2_000, "the approvals");
    // Each card, by the tag every one of them carries.
    cards = [...host.querySelectorAll("[data-tag]")]
      .filter((tag) => tag.textContent === "Needs you")
      .map((tag) => tag.closest(".rounded-\\[22px\\]")!)
      .map((card) => ({
        command: card.textContent?.includes("ls /tmp") ? "ls /tmp" : "git push",
        marked: [...card.querySelectorAll("[data-tag]")].some((tag) => tag.textContent === "Not in the chat yet"),
      }));
  });
  expect(cards).toEqual([
    { command: "git push", marked: false },
    { command: "ls /tmp", marked: true },
  ]);
});
