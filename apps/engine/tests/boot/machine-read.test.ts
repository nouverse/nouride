/**
 * The machine as boot reads it (`machineFor`): its size, and the system under it in words, which is what an agent's
 * prompt says of it. Read on this machine, so only its shape is held: a name, an architecture, and how it is run.
 */

import { describe, expect, test } from "bun:test";
import { machineFor } from "@/boot/commands-cgroup.ts";

describe("the machine boot reads", () => {
  test("carries the system in words: its name on its architecture, then how it is kept running", () => {
    const machine = machineFor({ isolated: false, systemd: false, reason: "a test" } as never);
    expect(machine.cores).toBeGreaterThanOrEqual(1);
    expect(machine.system).toMatch(/^.+ on [\w-]+, (run by|in a container|kept running|started with no service manager)/);
  });
});
