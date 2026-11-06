/**
 * `/approve` in a room, through the pipeline as a platform delivers it (S8): the person who asked may answer, an
 * admin by People may, and another member of the room may not — however the id reached them.
 */

import { afterEach, expect, test } from "bun:test";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { envelope, FakeGateway, sleep } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

test("in a room, someone else's request is answered by the person who asked or an admin, never by another member", async () => {
  let users!: UserStore;
  let approvals!: SqliteApprovalGate;
  const gateway = new FakeGateway("telegram:main");
  const { pipeline, db } = await pipelineBench({
    gateway,
    maxAttempts: 1,
    configure: async (config, db) => {
      config.security.access.allowlist = ["alice", "bob", "operator"];
      users = new UserStore({ db });
      config.people = [{ key: "gading", ids: ["telegram:operator", `web:${(await users.create({ username: "gading", role: "admin", createdBy: "test" })).id}`], name: "Gading" }];
    },
    deps: ({ db }) => {
      approvals = new SqliteApprovalGate({ db, timeoutMs: 60_000 });
      return { users, approvals };
    },
  }).then((bench) => (cleanup.push(bench.dispose), bench));
  cleanup.push(() => approvals.shutDown());
  pipeline.attach();

  const room = { gatewayId: "telegram:main", chatId: "room-1" };
  const ask = async () => {
    void approvals
      .request({ agentId: "nouva", ...room, gateway: "telegram", senderId: "alice", tool: "exec", params: { command: ["make", "deploy"] }, grantable: true, autoCoverable: true, reason: "first time" })
      .catch(() => {});
    await sleep(5);
    return approvals.pendingForChat("nouva", room.gatewayId, room.chatId).at(-1)!.id;
  };
  const say = async (senderId: string, text: string) => {
    const before = gateway.sent.length;
    // Addressed, as a command in a room is: by a tag on the agent.
    gateway.receive(envelope({ id: `m${gateway.sent.length}-${senderId}-${text}`, ...room, chatType: "group", senderId, text, mentions: ["nouva"], timestamp: Date.now() }));
    await pipeline.idle();
    return gateway.sent.slice(before).map((message) => message.text).join("\n");
  };
  const status = (id: string) => (db.prepare<{ status: string }>("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status;

  const first = await ask();
  expect(await say("bob", `/approve ${first} always`)).toContain("asked for by someone else here");
  expect(await say("bob", "/approve all")).toContain("asked for by someone else here");
  expect(status(first)).toBe("pending");
  expect(await say("operator", `/approve ${first}`)).toContain(`Approved \`${first}\``);

  const second = await ask();
  expect(await say("alice", `/deny ${second}`)).toContain(`Denied \`${second}\``);
  expect([status(first), status(second)]).toEqual(["approved", "denied"]);
});
