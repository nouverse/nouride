/**
 * What a killed foreground command tells the agent, given what it was doing when it died.
 *
 * Live, 2026-10-12: Claude Code's installer printed nothing while it downloaded 257 MB, was killed at
 * 30 s and then at 60 s under `bash -x`, and finished only the third time, in the background. The
 * advice had nothing to go on but the program's name — and the name it read was `bash`.
 */

import { describe, expect, test } from "bun:test";
import { foregroundWait, timeoutAdvice } from "@/modules/tools/builtins/exec-timeout.ts";

const installer = ["bash", "-lc", "curl -fsSL https://claude.ai/install.sh | bash"];

describe("measured", () => {
  test("data moving with nothing printed is work in progress, and it says to go to the background", () => {
    const text = timeoutAdvice(30_000, installer, { quietForMs: 30_000, bytesMoved: 57 * 1024 ** 2, cpuSeconds: 3.1 });
    expect(text).toContain("read and written 57 MB and used 3.1 s of CPU");
    expect(text).toContain("it printed nothing at all");
    expect(text).toContain("work in progress, not a hang");
    expect(text).toContain("run it again with `background: true`");
  });

  test("CPU alone counts as work: a compile moves little data", () => {
    const text = timeoutAdvice(30_000, ["make"], { quietForMs: 500, bytesMoved: 2048, cpuSeconds: 28 });
    expect(text).toContain("work in progress");
    expect(text).toContain("it was still printing");
  });

  test("nothing moving is a wait, and both kinds of wait are named — a sleep is one on purpose", () => {
    const text = timeoutAdvice(30_000, ["bash", "-lc", "sleep 45; gh run view 1"], { quietForMs: 30_000, bytesMoved: 9000, cpuSeconds: 0 });
    expect(text).toContain("read and written almost nothing and used no CPU to speak of");
    expect(text).toContain("It was waiting");
    expect(text).toContain("If the wait is the point");
    expect(text).toContain("background: true");
    expect(text).toContain("--connect-timeout");
    expect(text).toContain("changes nothing");
    expect(text).not.toContain("work in progress");
  });

  test("a follow inside a script is still a follow, whatever was measured", () => {
    const text = timeoutAdvice(30_000, ["bash", "-lc", "journalctl -u nouride -f"], { quietForMs: 0, bytesMoved: 5 * 1024 ** 2, cpuSeconds: 2 });
    expect(text).toContain("never exits on its own");
    expect(text).not.toContain("run it again with `background: true`");
  });
});

describe("CPU alone — a command run as its agent's own user, whose I/O the daemon cannot read", () => {
  test("busy is still working, and nothing is said about bytes that were not seen", () => {
    const text = timeoutAdvice(30_000, ["make"], { quietForMs: 500, bytesMoved: null, cpuSeconds: 28 });
    expect(text).toContain("When it was killed it had used 28.0 s of CPU; it was still printing.");
    expect(text).toContain("That is work in progress, not a hang");
    expect(text).not.toContain("read and written");
  });

  test("idle is waiting", () => {
    const text = timeoutAdvice(30_000, ["bash", "-lc", "sleep 45; gh run view 1"], { quietForMs: 30_000, bytesMoved: null, cpuSeconds: 0 });
    expect(text).toContain("It was waiting");
  });
});

describe("not measured — a host without /proc", () => {
  test("a download inside a `bash -lc` script is recognised by the program it runs, not by bash", () => {
    const text = timeoutAdvice(30_000, installer, { quietForMs: 30_000, bytesMoved: null, cpuSeconds: null });
    expect(text).toContain("an installer that fetches one");
    expect(text).toContain("background: true");
  });

  test("anything else gets the general advice", () => {
    const text = timeoutAdvice(30_000, ["make"]);
    expect(text).toContain("If it genuinely needs longer");
    expect(text).toContain("changes nothing");
  });
});

describe("how long a foreground command waits", () => {
  test("what it asked for, from a second to 240 seconds — the default when it asked for nothing", () => {
    expect(foregroundWait(undefined, 120_000)).toBe(120_000);
    expect(foregroundWait(10, 120_000)).toBe(1000);
    expect(foregroundWait(90_000, 120_000)).toBe(90_000);
    expect(foregroundWait(600_000, 120_000)).toBe(240_000);
  });

  test("past 240 seconds only where its context allows more — a helper working in the background", () => {
    expect(foregroundWait(600_000, 120_000, 1_800_000)).toBe(600_000);
    expect(foregroundWait(3_600_000, 120_000, 1_800_000)).toBe(1_800_000);
    expect(foregroundWait(undefined, 120_000, 1_800_000)).toBe(120_000);
  });
});

describe("said to an agent another one asked (0.8.8)", () => {
  test("a job's end goes to the agent that asked, not to it — every road to `background: true` says so", () => {
    // An asked agent is never woken for a job it starts (`job-wakes.ts` `reportsTo`): "you are woken" was a promise it
    // passed on as "I'll follow up", and the result reached the agent that asked it instead.
    const working = timeoutAdvice(30_000, ["make"], { quietForMs: 500, bytesMoved: 2048, cpuSeconds: 28 }, "nix");
    // A measured wait — what a Linux box reports for a `sleep` killed at its timeout; the CI runner found this one.
    const waiting = timeoutAdvice(30_000, ["bash", "-lc", "sleep 45"], { quietForMs: 30_000, bytesMoved: 9000, cpuSeconds: 0 }, "nix");
    const network = timeoutAdvice(30_000, ["curl", "https://x"], undefined, "nix");
    const other = timeoutAdvice(30_000, ["make"], undefined, "nix");
    for (const text of [working, waiting, network, other]) {
      expect(text).toContain("its end is reported to nix, which asked you, not to you. Say so in your answer, with its id");
      expect(text).not.toContain("woken when it finishes");
    }
    expect(timeoutAdvice(30_000, ["make"])).toContain("you get a job id at once and are woken when it finishes");
  });
});
