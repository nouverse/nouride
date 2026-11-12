/**
 * *Always for this job* on an automation's page (0.8.0): what a run's guards held is under that run in Recent runs,
 * with a button that allows it for the automation's runs, and what is allowed is in a card beside them, each taken
 * back with a press. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { automation, detail, flowDrawn, ok } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const MIRA = { keys: ["chat:telegram:nouva:5550001111"], label: "sends a message to the telegram one-to-one with Mira" };
const job = automation({ id: "j1", name: "Mail digest", allowed: [{ keys: ["host:hooks.example.com"], label: "posts to https://hooks.example.com/digest", by: "gading", at: 0 }] });
const run = { id: "r1", jobId: "j1", startedAt: 0, finishedAt: 1, status: "success" as const, result: "Done, but I could not tell Mira.", held: [{ ...MIRA, reason: "this run of a scheduled job sends to its own chat" }] };

describe("always for this job", () => {
  test("what is allowed is beside the runs, taken back with a press; what a run held is under it, allowed with one", async () => {
    answer({ "/automations/j1": detail(job, [run]) });
    let page = "";
    let sent: { path: string; body: unknown }[] = [];
    await renderPage("/automations/j1", async (host) => {
      await flowDrawn(host);
      await eventually(() => host.textContent?.includes("Always allowed for this job") === true && host.textContent.includes("Held:"), 2_000, "the allowances");
      page = host.textContent ?? "";
      const record = recordPosts({ "/cron/j1/allowed": ok({ job }) });
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Always allow for this job")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the allow");
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Take back")!.click();
      await eventually(() => record.posts.length > 1, 2_000, "the take back");
      record.restore();
      sent = record.posts;
    });
    expect(page).toContain("posts to https://hooks.example.com/digest (by gading)");
    expect(page).toContain("Held: sends a message to the telegram one-to-one with Mira (this run of a scheduled job sends to its own chat)");
    expect(sent).toEqual([
      { path: "/cron/j1/allowed", body: { add: MIRA } },
      { path: "/cron/j1/allowed", body: { remove: "host:hooks.example.com" } },
    ]);
  });
});
