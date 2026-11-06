/**
 * A turn the daemon started is headed by why it did (`systemHeading`, `commons/lib/turn-display.ts`). It was headed by matching
 * the wake-up message's wording, so rewording one sentence in the engine changed what the chat said had happened.
 */

import { describe, expect, test } from "bun:test";
import { systemHeading } from "@/commons/lib/turn-display";

describe("a turn the daemon started", () => {
  test("is headed by how the job that woke it ended", () => {
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "finished" })).toBe("a background job finished");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "failed" })).toBe("a background job failed");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "stopped" })).toBe("a background job was stopped");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "interrupted" })).toBe("a background job was interrupted");
    expect(systemHeading({ via: "job quiet", job: "job_1" })).toBe("a background job is still running");
  });

  test("one its coding CLI's own words woke says so (0.8.6)", () => {
    expect(systemHeading({ via: "cli own words" })).toBe("its coding CLI went on by itself");
    expect(systemHeading({ via: "cli stopped" })).toBe("a restart stopped a command its coding CLI had left running");
  });

  test("a scheduled job's own run says so (0.7.11)", () => {
    expect(systemHeading({ via: "schedule", job: "job_1" })).toBe("a scheduled job ran");
  });

  test("and one that gives no reason — from before 0.7.8, or a reason this page does not know — claims none", () => {
    expect(systemHeading(undefined)).toBe("Nouride started this turn");
    expect(systemHeading({ via: "something newer" })).toBe("Nouride started this turn");
  });
});
