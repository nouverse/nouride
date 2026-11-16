/**
 * Background work while it runs (`JobStrip`): its line folds the list away and opens it again, as a finished job's steps
 * fold. Several long commands took the conversation's screen for as long as they ran, with no way to put them aside.
 */

import { describe, expect, test } from "bun:test";
import type { RunningJob } from "@nouride/wire";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const jobs = [
  { id: "job_1", kind: "exec", command: "bun run build", startedAt: Date.now() - 65_000 },
  { id: "job_2", kind: "helper", command: "read the four logs", startedAt: Date.now() - 5_000 },
] as unknown as RunningJob[];

describe("background jobs, while they run", () => {
  test("open at first; their line folds them away and opens them again", async () => {
    // Brought in here, once the page is there: React reads the document as it loads.
    const { createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { JobStrip } = await import("@/commons/components/chat/Jobs");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const seen: { expanded: string | null; commands: number }[] = [];
    const look = () => {
      const line = host.querySelector("button")!;
      seen.push({ expanded: line.getAttribute("aria-expanded"), commands: [...host.querySelectorAll("span")].filter((span) => /bun run build|read the four logs/.test(span.textContent ?? "")).length });
    };
    try {
      root.render(createElement(JobStrip, { jobs }));
      await eventually(() => host.querySelector("button") !== null, 2_000, "the jobs' line");
      look();
      await act(async () => host.querySelector("button")!.click());
      look();
      await act(async () => host.querySelector("button")!.click());
      look();
      expect((host.textContent ?? "").includes("2 background jobs running")).toBe(true);
    } finally {
      root.unmount();
      host.remove();
    }
    expect(seen).toEqual([
      { expanded: "true", commands: 2 },
      { expanded: "false", commands: 0 },
      { expanded: "true", commands: 2 },
    ]);
  });
});
