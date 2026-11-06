/**
 * `/secret` (`modules/hooks/builtins/secrets.ts`): what a conversation holds, a message put back as written, a value
 * kept under a name, and the agent's secret guard — through the pipeline boot builds, with the people an operator names
 * and the store and packs boot holds. Keeping a value and turning the guard off are an admin's; the rest is anyone's.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretStore, TransientSecrets } from "@nouride/secrets";
import { secretKeepingFor } from "@/boot/secret-keeping.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { secretScope } from "@/modules/tools/held-secrets.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { cheapPasswords, conversationOf, envelope, eventually, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const TOKEN = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
const OTHER = `ghp_${"Pp4Rr7Tt2Ww9Yy3".repeat(3).slice(0, 36)}`;
const HANDLE = /\$TMP_SECRET_[0-9A-F]{12}/;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function bench(turns: { text: string }[] = []) {
  let users: UserStore | undefined;
  const held = new TransientSecrets();
  const audits: { action: string; details?: unknown }[] = [];
  let store: SecretStore | undefined;
  const b = await pipelineBench({
    turns,
    maxAttempts: 1,
    gateway: new FakeGateway("telegram:main"),
    configure: async (config, db) => {
      config.security.access.allowlist = ["operator", "colleague"];
      const accounts = new UserStore({ db, passwords: cheapPasswords });
      users = accounts;
      const account = async (username: string, role: "admin" | "operator") => `web:${(await accounts.create({ username, role, createdBy: "test" })).id}`;
      config.people = [
        { key: "gading", ids: ["telegram:operator", await account("gading", "admin")], name: "Gading" },
        { key: "budi", ids: ["telegram:colleague", await account("budi", "operator")], name: "Budi" },
      ];
    },
    deps: async (made) => {
      store = await SecretStore.open(made.dataDir, {});
      const audit = { record: (entry: { action: string; details?: unknown }) => void audits.push(entry) } as unknown as AuditPort;
      return { users: users!, heldSecrets: held, secretKeeping: secretKeepingFor({ secrets: store, audit, registry: made.registry }) };
    },
  });
  cleanup.push(b.dispose);
  b.pipeline.attach();
  /** One message from `sender`, and what came back. */
  const send = async (sender: string, text: string, id = `m${Date.now()}${Math.random()}`) => {
    const before = b.gateway.sent.length;
    b.gateway.receive(envelope({ id, timestamp: Date.now(), gatewayId: "telegram:main", chatId: "chat-1", senderId: sender, text }));
    await b.pipeline.idle();
    return b.gateway.sent.slice(before).map((message) => message.text).join("\n");
  };
  const disk = () => ["test.db", "test.db-wal"].map((file) => { try { return readFileSync(join(b.dataDir, file), "latin1"); } catch { return ""; } }).join("");
  const pack = () => readFileSync(join(b.agentsDir, "nouva", "config.toml"), "utf8");
  return { ...b, held, audits, store: () => store!, send, disk, pack };
}

describe("/secret", () => {
  test("says what this chat holds — each handle and what it was, never the value", async () => {
    const b = await bench([{ text: "ok" }]);
    await b.send("colleague", `pakai ${TOKEN}`);
    const reply = await b.send("colleague", "/secret");

    expect(reply).toMatch(HANDLE);
    expect(reply).toContain("a GitHub token");
    expect(reply).toMatch(/\d+ min left/);
    expect(reply).not.toContain(TOKEN);
  });

  test("undo: the message as it was written, read again by the agent — and its handle let go", async () => {
    const b = await bench([{ text: "ok" }, { text: "ok, as written" }]);
    await b.send("colleague", `the word is ${TOKEN} really`, "m1");
    const handle = b.turns.forChat("telegram:main", "chat-1")[0]?.prompt.match(HANDLE)?.[0];
    expect(handle).toBeDefined();

    expect(await b.send("colleague", "/secret undo")).toContain("Put back as you wrote it");
    await eventually(() => b.requests.length === 2, 4_000, "the message answered as written");
    await b.pipeline.idle();

    expect(JSON.stringify(conversationOf(b.requests[1]?.messages ?? []).at(-1))).toContain(TOKEN);
    expect(b.held.get(handle!, secretScope({ gatewayId: "telegram:main", chatId: "chat-1" }))).toBeUndefined();
    // Once.
    expect(await b.send("colleague", "/secret undo")).toContain("Nothing of yours was taken");
  });

  test("set: an admin keeps the value under a name; anyone else is refused, and the value is kept nowhere", async () => {
    const b = await bench();
    const refused = await b.send("colleague", `/secret set deploy_token ${TOKEN}`);
    expect(refused).toContain("Only an admin");
    expect(refused).not.toContain(TOKEN);
    expect(b.store().has("deploy_token")).toBe(false);

    const kept = await b.send("operator", `/secret set deploy_token ${TOKEN}`);
    expect(kept).toContain("Kept as `deploy_token`");
    expect(kept).toContain("gets it as $DEPLOY_TOKEN");
    expect(b.store().resolve("deploy_token")).toBe(TOKEN);
    // Handed to every command of the chat's agent, in its pack — and the agent reloaded with it.
    expect(b.pack()).toMatch(/\[security\.exec_secrets\][^[]*deploy_token = \[\s*"\*"\s*\]/);
    expect(b.registry.get("nouva")?.config.execSecrets).toContainEqual(expect.objectContaining({ name: "deploy_token", commands: ["*"] }));
    expect(await b.send("operator", `/secret set deploy_token ${OTHER}`)).toContain("already set");
    expect(b.store().resolve("deploy_token")).toBe(TOKEN);
    expect(await b.send("operator", `/secret replace deploy_token ${OTHER}`)).toContain("Replaced");
    expect(b.store().resolve("deploy_token")).toBe(OTHER);
    expect(b.audits.filter((entry) => entry.action === "secret_stored")).toHaveLength(2);

    // A value no pattern would take is taken all the same: the command says it is a secret.
    expect(await b.send("operator", "/secret set wifi_kantor rumah123")).toContain("Kept as `wifi_kantor`");
    expect(b.store().resolve("wifi_kantor")).toBe("rumah123");

    const disk = b.disk();
    for (const value of [TOKEN, OTHER, "rumah123"]) expect(disk).not.toContain(value);
  });

  test("the guard has no switch here since 0.8.0: it asks at every level but trusted", async () => {
    const b = await bench();
    expect(await b.send("operator", "/secret guard off")).toContain("No `/secret guard`");
    expect(b.pack()).not.toContain("secret_guard");
    expect(await b.send("colleague", "/secret")).not.toContain("Secret guard");
  });
});
