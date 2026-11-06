import { describe, expect, test } from "bun:test";
import { DEFAULT_RESILIENCE, backoffDelay } from "../src/types/gateway.ts";

describe("backoffDelay", () => {
  test("grows exponentially from the base delay", () => {
    const at = (attempt: number) => backoffDelay(attempt, DEFAULT_RESILIENCE, () => 1);
    expect(at(0)).toBe(1000);
    expect(at(1)).toBe(2000);
    expect(at(2)).toBe(4000);
  });

  test("caps at reconnectBackoffMaxMs", () => {
    // Attempt 20 would be 1000 * 2^20 ≈ 17 minutes without the cap.
    expect(backoffDelay(20, DEFAULT_RESILIENCE, () => 1)).toBe(60_000);
  });

  test("jitters between half and full of the capped delay", () => {
    // Full jitter is what stops every gateway that dropped in the same outage from
    // reconnecting in lockstep, so the spread is the behaviour under test.
    const low = backoffDelay(3, DEFAULT_RESILIENCE, () => 0);
    const high = backoffDelay(3, DEFAULT_RESILIENCE, () => 1);
    expect(low).toBe(4000);
    expect(high).toBe(8000);

    for (let i = 0; i < 50; i++) {
      const delay = backoffDelay(3, DEFAULT_RESILIENCE);
      expect(delay).toBeGreaterThanOrEqual(low);
      expect(delay).toBeLessThanOrEqual(high);
    }
  });
});
