import { describe, expect, test } from "bun:test";
import { quietSchedule } from "@/modules/agents/components/JobQuietControl";

describe("the quiet-job schedule, as the card says it", () => {
  test("the wait, then doubling", () => {
    expect(quietSchedule(5)).toBe("5, 10, 20, 40… minutes");
    expect(quietSchedule(3)).toBe("3, 6, 12, 24… minutes");
  });

  test("0 is never", () => {
    expect(quietSchedule(0)).toBe("never");
  });
});
