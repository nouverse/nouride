/**
 * The turn that comes after the restart, and the value that never gets written down.
 *
 * Two mechanisms, one reason: a capability was previously withheld because its consequence could not
 * be handled. `restart` ended the conversation that asked for it, so the prompt forbade it. A
 * credential could only reach a command through `argv`, which is kept forever in three places, so
 * storing one was left to a browser. Both are now possible, and both are only safe because of the
 * behaviour pinned here.
 */

import { describe, expect, test } from "bun:test";
import { parseWakeUp, wakeUpUsage } from "@/cli/wake-up.ts";
import { auditableArgs } from "@/modules/tools/audited.ts";

describe("reading --then", () => {
  const target = ["--gateway", "telegram:nouva", "--chat", "12345", "--agent", "nouva"];

  test("absent means absent, so the caller can refuse", () => {
    // The flag is not optional on a command that ends the conversation, and the refusal lives in the
    // command rather than here — this only has to say "nothing was asked for".
    expect(parseWakeUp([...target], "restarting")).toBeNull();
  });

  test("carries the message, the target and a default delay", () => {
    const wake = parseWakeUp(["--then", "check the gateways", ...target], "restarting the daemon");
    expect(wake).toMatchObject({
      message: "check the gateways",
      gatewayId: "telegram:nouva",
      chatId: "12345",
      agentId: "nouva",
      delaySeconds: 10,
      because: "restarting the daemon",
    });
  });

  test("`--in` overrides the delay", () => {
    expect(parseWakeUp(["--then", "x", "--in", "45", ...target], "r")?.delaySeconds).toBe(45);
  });

  test("the usage text says why the flag is required, not just that it is", () => {
    /**
     * A refusal that only states a rule invites working around it. This one carries the mechanism:
     * the follow-up is created *before* the restart, which is the whole reason the capability can
     * exist at all.
     */
    const text = wakeUpUsage("nouride restart", "nouride restart --then \"check\"");
    expect(text).toContain("ends the conversation");
    expect(text).toContain("created BEFORE the restart");
  });
});

describe("what the audit log keeps of a tool call", () => {
  test("`stdin` is never recorded, and its absence is not silent", () => {
    /**
     * The single rule this whole path exists for. `stdin` carries the value that must not be written
     * down; the audit table, the exec grant and the daemon's log table all keep what they are given,
     * permanently. Recording it would make `--value-stdin` a slower way of doing the thing it
     * replaced.
     *
     * Marked rather than dropped: "there was a value and it was deliberately not kept" is a
     * different fact from "no value was passed", and an investigation needs to tell them apart.
     */
    const kept = auditableArgs({ args: ["secret", "set", "discord_nox_token"], stdin: "MTIzNDU2.abc" });
    expect(kept.stdin).toBe("[not recorded]");
    expect(kept.args).toEqual(["secret", "set", "discord_nox_token"]);
    expect(JSON.stringify(kept)).not.toContain("MTIzNDU2");
  });

  test("a credential pasted into the arguments anyway is redacted", () => {
    // Belt and braces. The agent has been told not to; this is what stops it being permanent when
    // it does it regardless.
    const kept = auditableArgs({
      command: ["curl", "-H", "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    });
    expect(JSON.stringify(kept)).not.toContain("sk-ant-api03-AAAA");
  });

  test("everything else survives, because a command line is the useful part of the row", () => {
    const kept = auditableArgs({ command: ["ls", "-la", "/srv/nouride"], timeout_ms: 5000 });
    expect(kept.command).toEqual(["ls", "-la", "/srv/nouride"]);
    expect(kept.timeout_ms).toBe(5000);
  });
});
