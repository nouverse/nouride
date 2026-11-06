/**
 * *Always for this job* on the Schedule page (0.8.0): what a run's guards held is under that run, with a button that
 * allows it for the job's runs — and what is allowed is on the job's card, each taken back with a press. In a file of
 * its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const MIRA = { keys: ["chat:telegram:nouva:5550001111"], label: "sends a message to the telegram one-to-one with Mira" };
const job = {
  id: "j1", agentId: "nouva", name: "Mail digest", enabled: true, trigger: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "Sum up the mail." },
  delivery: { mode: "announce" }, target: { gatewayId: "telegram:nouva", chatId: "1" }, session: "fresh", createdBy: "tester",
  createdAt: 0, runCount: 1, failCount: 0, failStreak: 0, describes: "every day at 09:00",
  allowed: [{ keys: ["host:hooks.example.com"], label: "posts to https://hooks.example.com/digest", by: "gading", at: 0 }],
};

describe("always for this job", () => {
  test("what is allowed is on the card, taken back with a press; what a run held is under it, allowed with one", async () => {
    answer({
      "/cron": ok({ jobs: [job], timezone: "UTC" }),
      "/cron/j1": ok({ job, runs: [{ id: "r1", jobId: "j1", startedAt: 0, finishedAt: 1, status: "success", result: "Done, but I could not tell Mira.", held: [{ ...MIRA, reason: "this run of a scheduled job sends to its own chat" }] }], timezone: "UTC" }),
    });
    let card = "";
    let runs = "";
    let sent: { path: string; body: unknown }[] = [];
    await renderPage("/schedule", async (host) => {
      await eventually(() => host.textContent?.includes("Always allowed for this job") === true, 2_000, "the card");
      card = host.textContent ?? "";
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Show execution runs"))!.click();
      await eventually(() => host.textContent?.includes("Held:") === true, 2_000, "the runs");
      runs = host.textContent ?? "";
      const record = recordPosts({ "/cron/j1/allowed": ok({ job }) });
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Always allow for this job")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the allow");
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Take back")!.click();
      await eventually(() => record.posts.length > 1, 2_000, "the take back");
      record.restore();
      sent = record.posts;
    });
    expect(card).toContain("posts to https://hooks.example.com/digest (by gading)");
    expect(runs).toContain("Held: sends a message to the telegram one-to-one with Mira (this run of a scheduled job sends to its own chat)");
    expect(sent).toEqual([
      { path: "/cron/j1/allowed", body: { add: MIRA } },
      { path: "/cron/j1/allowed", body: { remove: "host:hooks.example.com" } },
    ]);
  });
});
