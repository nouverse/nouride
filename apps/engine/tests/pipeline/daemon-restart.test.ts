/**
 * `/daemon-restart`, through the pipeline as a platform delivers it: who may, what they are told, and what the
 * chat hears once the daemon is back.
 *
 * Everyone who reaches a command got through admission, and on an `open` connection that proves nothing — so
 * the command asks for an admin: paired or on an allowlist, and under People the same person as an admin's
 * dashboard account. And a `/daemon-restart` sent before this process started is the one that started it,
 * put back from the inbox or delivered twice: answering it again would never end.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DaemonRestart } from "@/modules/update/restart.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { cheapPasswords, envelope, eventually, FakeGateway } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function bench() {
  let users: UserStore | undefined;
  const startedAt = Date.now() - 1_000;
  const b = await pipelineBench({
    gateway: new FakeGateway("telegram:main"),
    // One attempt: the provider here is unreachable on purpose, and the real backoff is half a minute.
    maxAttempts: 1,
    configure: async (config, db) => {
      // A bot anyone can talk to, and the people the operator named.
      config.security.access.allowlist = ["operator", "colleague", "nobody"];
      // Who each of them is under People, and what their dashboard account may do.
      const store = new UserStore({ db, passwords: cheapPasswords });
      users = store;
      const account = async (username: string, role: "admin" | "operator") =>
        `web:${(await store.create({ username, role, createdBy: "test" })).id}`;
      config.people = [
        { key: "gading", ids: ["telegram:operator", await account("gading", "admin")], name: "Gading" },
        { key: "rani", ids: ["telegram:friend", await account("rani", "admin")], name: "Rani" },
        { key: "budi", ids: ["telegram:colleague", await account("budi", "operator")], name: "Budi" },
        { key: "sari", ids: ["telegram:outsider", await account("sari", "admin")], name: "Sari" },
      ];
    },
    deps: () => ({ users: users!, startedAt }),
  });
  cleanup.push(b.dispose);
  const { pipeline, gateway, access } = b;

  const restarts: number[] = [];
  const followUps: { kind?: string; text?: string; chatId: string }[] = [];
  pipeline.restart = new DaemonRestart({
    requestRestart: () => void restarts.push(Date.now()),
    supervisor: () => ({ kind: "systemd", restartsOnExit: true }),
    busy: () => false,
    cron: {
      create: (input) => {
        followUps.push({ ...(input.payload as { kind: string; text?: string }), chatId: input.target.chatId });
        return { id: `cron_${followUps.length}` } as never;
      },
      update: (id) => ({ id }) as never,
    },
    pacing: { beatMs: 5, pollMs: 5 },
  });
  pipeline.attach();

  /** One message in, the replies out. */
  const send = async (overrides: Parameters<typeof envelope>[0]) => {
    const before = gateway.sent.length;
    gateway.receive(envelope({ timestamp: Date.now(), gatewayId: "telegram:main", ...overrides }));
    await pipeline.idle();
    return gateway.sent.slice(before).map((message) => message.text);
  };
  return { pipeline, send, restarts, followUps, access, startedAt };
}

/** Polled rather than slept for; a refusal is said from `waiting` — nothing was asked for, so nothing will happen. */
const restarted = (restarts: number[]) => eventually(() => restarts.length === 1, 4_000, "the restart");

describe("/daemon-restart", () => {
  test("from an admin restarts once nothing else runs, and tells this chat when it is back", async () => {
    const b = await bench();
    const replies = await b.send({ senderId: "operator", chatId: "814", text: "/daemon-restart" });

    expect(replies.join("\n")).toContain("I'll say here when I'm back");
    await restarted(b.restarts);
    expect(b.followUps).toEqual([{ kind: "systemEvent", text: "✓ Restarted, I'm back.", chatId: "814" }]);
  });

  test("from an admin who was paired rather than listed, too", async () => {
    const b = await bench();
    const decision = b.access.check({ gatewayId: "telegram:main", senderId: "friend", chatId: "77", mode: "pair", staticAllowlist: [] });
    if (decision.action !== "pair") throw new Error("expected a pairing code");
    b.access.approveByCode(decision.code, "test");

    expect((await b.send({ senderId: "friend", chatId: "77", text: "/daemon-restart now" })).join("\n")).toContain("Restarting now");
    await restarted(b.restarts);
  });

  test("from anyone short of an admin is refused, and nothing restarts", async () => {
    const b = await bench();
    const refusals = [
      "stranger", //  not paired, not anybody under People
      "nobody", //    on the allowlist, but no person
      "colleague", // on the allowlist, and a person whose account is an operator's
      "outsider", //  an admin's person, but never paired with this open bot
    ];
    for (const senderId of refusals) {
      const replies = await b.send({ senderId, chatId: senderId, text: "/daemon-restart now" });
      expect({ senderId, reply: replies.join("\n") }).toEqual({ senderId, reply: expect.stringContaining("Only an admin can restart me") });
    }
    expect({ restarts: b.restarts, followUps: b.followUps, waiting: b.pipeline.restart!.waiting }).toEqual({ restarts: [], followUps: [], waiting: false });
  });

  test("sent before this process started is not answered with another restart", async () => {
    const b = await bench();
    // Against the bench's own start, not the clock: a laptop that sleeps between the two made "a minute
    // ago" later than the boot, and the stale message a fresh one.
    const replies = await b.send({ senderId: "operator", chatId: "814", text: "/daemon-restart", timestamp: b.startedAt - 60_000 });

    expect(replies.join("\n")).toContain("not restarting again");
    expect({ restarts: b.restarts, waiting: b.pipeline.restart!.waiting }).toEqual({ restarts: [], waiting: false });
  });

  test("answers Telegram's menu spelling, and shows only the hyphen in the command list", async () => {
    const b = await bench();
    expect((await b.send({ senderId: "operator", chatId: "814", text: "/daemon_restart" })).join("\n")).toContain("I'll say here when I'm back");

    const listed = b.pipeline.commands().map((command) => command.command);
    expect(listed).toContain("/daemon-restart");
    expect(listed).not.toContain("/daemon_restart");
  });
});
