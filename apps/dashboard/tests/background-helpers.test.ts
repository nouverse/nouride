import { describe, expect, test } from "bun:test";
import { helpersSaid } from "@/modules/agents/components/AgentBackgroundHelpers";
import { systemHeading } from "@/commons/lib/turn-display";

describe("the background-helpers card, as it says the limit", () => {
  test("off, one, and more — said as the agent is told it", () => {
    expect(helpersSaid(0)).toBe("Off: it hands work to helpers only in the foreground, and waits for them.");
    expect(helpersSaid(1)).toContain("a task that takes a while goes to a helper, and the agent stays free for the person");
    expect(helpersSaid(2)).toBe("Up to 2 at once: one for a task that takes a while, more only for independent pieces.");
  });
});

describe("a turn an asked agent's answer started (0.7.19)", () => {
  test("names the agent asked, by how its work in the background ended", () => {
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "finished", asked: "nox" })).toBe("nox answered from the background");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "failed", asked: "nox" })).toBe("nox stopped short in the background");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "stopped", asked: "nox" })).toBe("nox's work in the background was stopped");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "interrupted", asked: "nox" })).toBe("nox's work in the background was interrupted");
  });
});

describe("a turn a helper's report started", () => {
  test("is headed as a helper's, and a command's job keeps its own heading", () => {
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "finished", helper: true })).toBe("a background helper finished");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "failed", helper: true })).toBe("a background helper stopped short");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "interrupted", helper: true })).toBe("a background helper was interrupted");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "failed" })).toBe("a background job failed");
    expect(systemHeading({ via: "job completion", job: "job_1", outcome: "finished" })).toBe("a background job finished");
  });
});
