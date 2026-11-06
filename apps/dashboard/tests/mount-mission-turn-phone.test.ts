/**
 * A mission's turn on a phone (0.8.12), from the owner's iPhone and the coordinator's look at the fix:
 * - the timeline's rail and its column sat beside the turn's own border inside the Turns card, a seventh of the width
 *   gone before a step's command had any. Below `sm` a turn is a block the card's width, its point small at the start of
 *   its head; from `sm` up the rail is as it was;
 * - its meta lines wrap between words: `break-all` cut a model call's "20 out" into "20 o / ut";
 * - a coding CLI's turn, recorded with 0 tokens, says no "0 in / 0 out tokens" above its model call's real figure.
 * In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const shown = WIRE["/sessions/ses_1/turns"] as Record<string, unknown>;
const command = "getent group nr-agents; id nr-nexa 2>&1; S=/srv/nouride/.nouride/workspace/shared/nouride-demo";
const turn = {
  id: "turn_1",
  agentId: "nouva",
  chatId: "msn_1",
  sessionId: "ses_msn_1",
  status: "done",
  prompt: "MISSION msn_1 — turn 1\nGoal: fix it\nWhy this turn: continue with the next step.\nChecklist: none yet.",
  reply: "",
  model: "Claude Code · Opus 5.5",
  toolCalls: 1,
  iterations: 1,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_060_000,
  durationMs: 60_000,
  steps: [
    { seq: 1, at: 0, kind: "tool", text: command, ms: 0 },
    { seq: 2, at: 1, kind: "tool_done", text: `${command.split(" ")[0]} Bash ok: nr-agents:x:997:`, ms: 40 },
  ],
};

test("a turn on a phone: no rail, its steps the card's width, its meta wrapping between words, no zero tokens", async () => {
  answer({
    "/sessions/ses_msn_1/turns": { status: 200, body: { ...shown, session: { ...(shown.session as object), id: "ses_msn_1", gatewayId: "web:mission", chatId: "msn_1" }, turns: [turn] } },
    "/turns/turn_1": {
      status: 200,
      body: { turn: { id: "turn_1", agentId: "nouva", status: "done", prompt: turn.prompt, reply: "" }, calls: [{ at: 1_760_000_030_000, agentId: "nouva", model: "Opus 5.5", inputTokens: 3_207_215, outputTokens: 55_013, stopReason: "stop" }], steps: [] },
    },
  });
  const seen = { li: "", rail: "", hrs: [] as string[], inline: "", meta: "", call: "", callLines: [] as string[], text: "" };
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("ul.timeline > li") !== null, 2_000, "the timeline");
    ([...host.querySelectorAll("button")].find((b) => /1 step/.test(b.textContent ?? "")) as HTMLElement).click();
    await eventually(() => host.textContent?.includes("3,207,215 in") === true, 2_000, "the turn's record");
    const li = host.querySelector("ul.timeline > li")!;
    seen.li = li.getAttribute("class") ?? "";
    seen.rail = li.querySelector(".timeline-middle")?.getAttribute("class") ?? "";
    seen.hrs = [...li.querySelectorAll("hr")].map((hr) => hr.getAttribute("class") ?? "");
    seen.inline = li.querySelector(".timeline-end span.sm\\:hidden")?.textContent ?? "";
    const meta = [...li.querySelectorAll("div")].find((div) => div.firstElementChild?.textContent?.startsWith("model: "));
    seen.meta = meta?.getAttribute("class") ?? "";
    const call = [...li.querySelectorAll("p")].find((p) => p.textContent?.includes("3,207,215 in"));
    seen.call = `${call?.getAttribute("class") ?? ""} | ${call?.closest("div.max-w-xl")?.getAttribute("class") ?? ""}`;
    seen.callLines = [...(meta?.querySelectorAll("p") ?? [])].map((p) => p.getAttribute("class") ?? "");
    seen.text = li.textContent ?? "";
  });
  // The rail is drawn from sm up only; on a phone the turn is a block and its point is in its head.
  expect(seen.li.split(" ")).toContain("max-sm:block");
  expect(seen.rail.split(" ")).toContain("max-sm:hidden");
  for (const hr of seen.hrs) expect(hr.split(" ")).toContain("max-sm:hidden");
  expect(seen.inline).toContain("ended");
  // Meta wraps between words; `break-all` is for a step's command and a path, not these lines.
  expect(seen.meta).toContain("[overflow-wrap:anywhere]");
  expect(seen.call).toContain("[overflow-wrap:anywhere]");
  expect(seen.call).not.toContain("break-all");
  for (const line of seen.callLines) expect(line).not.toContain("break-all");
  expect(seen.text).toContain("1 tool call · 1 model round trip");
  expect(seen.text).not.toContain("0 in / 0 out tokens");
});
