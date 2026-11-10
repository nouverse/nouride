/**
 * `nouride update` reports. `nouride update --start` acts.
 *
 * It used to be the other way round, on the argument that a short command typed by mistake should
 * be the harmless one — which had the risk backwards. `update` is the verb people type to *find
 * out*, so the keystroke somebody reaches for by reflex was the one that replaced the binary and
 * ended the process. `--then` caught it, but a required flag is a seatbelt, not a reason to point
 * the car at the wall.
 *
 * What these hold is the property that matters and is invisible from the output: whether anything
 * was *posted*. A version of this command that printed the same report and also swapped the binary
 * would look identical in a terminal.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { update } from "@/cli/commands/update.ts";

/** A daemon that is behind and can take the update, so every branch below is reachable. */
const BEHIND = {
  supported: true,
  install: {
    version: "0.4.2",
    edition: "basic",
    installDir: "/srv/nouride",
    supervisor: "systemd",
    compiled: true,
    platform: "linux",
    arch: "arm64",
    musl: false,
  },
  check: {
    current: "0.4.2",
    latest: "v0.4.4",
    newer: true,
    publishedAt: null,
    notesUrl: null,
    plan: { can: true, from: "0.4.2", to: "v0.4.4", artifact: "nouride-linux-arm64" },
  },
};

function fakeClient(): Client & { posts: string[]; bodies: unknown[] } {
  const posts: string[] = [];
  const bodies: unknown[] = [];
  return {
    posts,
    bodies,
    get: async <T>() => BEHIND as T,
    post: async <T>(path: string, body?: unknown) => {
      posts.push(path);
      bodies.push(body);
      return { note: "swapped", to: "v0.4.4", wake_in_seconds: 20 } as T;
    },
  } as unknown as Client & { posts: string[]; bodies: unknown[] };
}

const AIMED = ["--then", "check it", "--agent", "ren", "--gateway", "telegram:ren", "--chat", "1"];

describe("nouride update", () => {
  test("posts nothing when told nothing", async () => {
    const client = fakeClient();
    await update(client, []);
    expect(client.posts).toEqual([]);
  });

  test("posts nothing with --check either, which is the same command said out loud", async () => {
    const client = fakeClient();
    await update(client, ["--check"]);
    expect(client.posts).toEqual([]);
  });

  test("posts nothing for a flag it does not know, rather than treating it as consent", async () => {
    // The old rule was "act unless `--check`", so an unrecognised word fell on the acting side.
    const client = fakeClient();
    await update(client, ["--yes"]);
    expect(client.posts).toEqual([]);
  });

  test("a follow-up on its own is not consent — this is the old spelling, and it must not act", async () => {
    /**
     * The mutation that exposed this test file's first gap. Under the old rule the acting branch was
     * "not `--check`", so `--then` alone was enough — and every script, doc line and transcript from
     * before this change says exactly that. If `--start` were ignored, this is the call that would
     * quietly keep replacing binaries, and none of the other cases here would notice.
     */
    const client = fakeClient();
    await update(client, AIMED);
    expect(client.posts).toEqual([]);
  });

  test("--start with a follow-up is the one thing that acts", async () => {
    const client = fakeClient();
    await update(client, ["--start", ...AIMED]);
    expect(client.posts).toEqual(["/update/apply"]);
  });

  test("--start --no-then acts for a person watching, and aims no follow-up anywhere", async () => {
    /**
     * `--no-then` is the escape hatch for someone at the terminal. It passed the first check and then
     * still demanded --agent, --gateway and --chat — so from a shell it could never act at all, and
     * the only way to update a box by hand was the dashboard. Found updating the first box to v0.6.0.
     */
    const saved = { agent: process.env.NOURIDE_AGENT_ID, gateway: process.env.NOURIDE_GATEWAY_ID, chat: process.env.NOURIDE_CHAT_ID };
    delete process.env.NOURIDE_AGENT_ID;
    delete process.env.NOURIDE_GATEWAY_ID;
    delete process.env.NOURIDE_CHAT_ID;
    try {
      const client = fakeClient();
      await update(client, ["--start", "--no-then"]);
      expect(client.posts).toEqual(["/update/apply"]);
      // None of the three: the daemon reads that as the watched case, and schedules no turn.
      expect(client.bodies[0]).toEqual({});
    } finally {
      if (saved.agent !== undefined) process.env.NOURIDE_AGENT_ID = saved.agent;
      if (saved.gateway !== undefined) process.env.NOURIDE_GATEWAY_ID = saved.gateway;
      if (saved.chat !== undefined) process.env.NOURIDE_CHAT_ID = saved.chat;
    }
  });

  test("an agent's --start without a follow-up says what to do, exits 2, and posts nothing", async () => {
    // `--then` stays required of an agent: the turn that reports whether it worked has to exist before
    // the daemon goes away, and the conversation it was asked from goes with it. Exit 2, not 0: the `nouride` tool
    // marks a result as an error only on a non-zero exit, and this read to the model as an update under way.
    await withEnv({ NOURIDE_AGENT_ID: "ren", NOURIDE_GATEWAY_ID: "telegram:ren", NOURIDE_CHAT_ID: "1" }, async () => {
      const client = fakeClient();
      const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(update(client, ["--start"])).rejects.toThrow("exit 2");
      } finally {
        exit.mockRestore();
        error.mockRestore();
      }
      expect(client.posts).toEqual([]);
    });
  });

  test("a person's --start is the whole command: it acts, watched, and aims no follow-up", async () => {
    /**
     * No `NOURIDE_AGENT_ID` means no agent's tool ran this — a person typed it, and is watching. They
     * had to add `--no-then` to a command whose only other reading was "print the usage and do nothing",
     * which made `nouride update --start` the one documented spelling that never updated anything.
     */
    await withEnv({}, async () => {
      const client = fakeClient();
      await update(client, ["--start"]);
      expect(client.posts).toEqual(["/update/apply"]);
      expect(client.bodies[0]).toEqual({});
    });
  });
});

/** Run with exactly these of the three caller variables set, and put back whatever was there. */
async function withEnv(vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const keys = ["NOURIDE_AGENT_ID", "NOURIDE_GATEWAY_ID", "NOURIDE_CHAT_ID"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
