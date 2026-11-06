/**
 * Boot advisories are said at warn while new and at info once said (`boot/advisories.ts`), and a default chosen on
 * purpose is not a warning at all. A fresh install warned about its own defaults on every boot, which taught its
 * operator to skim the warn lines — the channel the exec and credential warnings share.
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "@nouride/shared";
import { groupAdvisories, openAdvisories, readAdvisories } from "@/boot/advisories.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { lintConfig } from "@/modules/config/schema.ts";
import { stateRows } from "../helpers.ts";

function boot(rows: StateRows, say: (advise: (message: string, data?: Record<string, unknown>) => void) => void) {
  const lines: string[] = [];
  const log = { warn: (m: string) => void lines.push(`warn ${m}`), info: (m: string) => void lines.push(`info ${m}`) } as unknown as Logger;
  const advisories = openAdvisories(rows, log);
  say(advisories.advise);
  advisories.save();
  return lines;
}

describe("a boot advisory", () => {
  test("is a warning the first time, a note the next, and a warning again when what it says changes", () => {
    const rows = stateRows();
    const noCredential = (agent: string) => (advise: (m: string, d?: Record<string, unknown>) => void) =>
      advise("agent has no usable credential — it will fail on its first message", { agent_id: agent });

    expect(boot(rows, noCredential("nouva"))).toEqual(["warn agent has no usable credential — it will fail on its first message"]);
    expect(boot(rows, noCredential("nouva"))).toEqual(["info agent has no usable credential — it will fail on its first message"]);
    expect(boot(rows, noCredential("nexa"))).toEqual(["warn agent has no usable credential — it will fail on its first message"]);
  });
});

describe("the set the last boot said", () => {
  const quiet = { warn: () => {}, info: () => {} } as unknown as Logger;

  test("keeps what was said, about whom, and since when — a second boot keeps the date, and drops what it no longer says", () => {
    const rows = stateRows();
    const first = openAdvisories(rows, quiet, () => 1_000);
    first.advise("exec_secrets.github_token is unscoped", { agent_id: "nouva" });
    first.advise("[alerts] has no gateway or chat_id", { hint: "point it at a chat you read" });
    first.save();
    expect(readAdvisories(rows.get("advisories"))).toEqual([
      { message: "exec_secrets.github_token is unscoped", data: { agent_id: "nouva" }, since: 1_000 },
      { message: "[alerts] has no gateway or chat_id", data: { hint: "point it at a chat you read" }, since: 1_000 },
    ]);

    const second = openAdvisories(rows, quiet, () => 9_000);
    second.advise("exec_secrets.github_token is unscoped", { agent_id: "nouva" });
    second.advise("agent has no usable credential", { agent_id: "nix" });
    second.save();
    expect(readAdvisories(rows.get("advisories"))).toEqual([
      { message: "exec_secrets.github_token is unscoped", data: { agent_id: "nouva" }, since: 1_000 },
      { message: "agent has no usable credential", data: { agent_id: "nix" }, since: 9_000 },
    ]);
  });

  test("one line per thing said, with every agent it was said about — six agents and one secret is one finding", () => {
    const lines = groupAdvisories([
      { message: "exec_secrets.github_token is unscoped", data: { agent_id: "nouva" }, since: 2_000 },
      { message: "exec_secrets.github_token is unscoped", data: { agent_id: "nix" }, since: 1_000 },
      { message: "[alerts] has no gateway or chat_id", data: { hint: "point it at a chat you read" }, since: 3_000 },
    ]);
    expect(lines).toEqual([
      { message: "exec_secrets.github_token is unscoped", agents: ["nouva", "nix"], since: 1_000 },
      { message: "[alerts] has no gateway or chat_id", agents: [], hint: "point it at a chat you read", since: 3_000 },
    ]);
  });
});

describe("the config's own advisories", () => {
  test("no alert channel is said only once there is a chat gateway to send one to", () => {
    const messages = (raw: Record<string, unknown>) => lintConfig(parseConfig(raw)).map((lint) => lint.message);
    expect(messages({}).join("\n")).not.toContain("[alerts]");
    expect(messages({ gateways: { telegram: { bot: { enabled: true, token: "telegram_bot" } } } }).join("\n")).toContain("[alerts] has no gateway or chat_id");
  });

  test("no spend cap is a default chosen on purpose: still said when asked, at info at boot", () => {
    const caps = lintConfig(parseConfig({})).find((lint) => lint.message.startsWith("[llm.limits] neither"));
    expect(caps).toMatchObject({ level: "warn", deliberate: true });
  });
});
