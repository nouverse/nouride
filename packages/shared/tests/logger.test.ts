/**
 * The turn a line was written in: lifted out of the line's context like the agent and the chat, so a journal
 * can be filtered by it and the log table keeps it.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { addLogSink, configureLogger, createLogger, holding, holdLines, isLogLevel, type LogEntry } from "../src/logger.ts";
import { sleep } from "./wait.ts";

describe("where the lines go", () => {
  test("stdout for the daemon's journal, stderr for a CLI whose stdout is its answer", () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      configureLogger({ stream: "stderr" });
      createLogger("db.backup").info("database backed up");
      expect(out).not.toHaveBeenCalled();
      expect(String(err.mock.calls[0]?.[0])).toContain('"message":"database backed up"');

      configureLogger({ stream: "stdout" });
      createLogger("daemon").info("starting");
      expect(String(out.mock.calls[0]?.[0])).toContain('"message":"starting"');
    } finally {
      configureLogger({ stream: "stdout" });
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("held: a warn line is handed back rather than written, whatever the floor; info goes, an error still goes out", () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    const sunk: string[] = [];
    addLogSink((entry) => void sunk.push(entry.message));
    try {
      // The floor a CLI user can set: what a caller lists from a load must not depend on it.
      configureLogger({ level: "error" });
      const log = createLogger("config");
      const { value, held } = holding(() => {
        log.info("read as the new name");
        log.warn("unknown config key ignored", { key: "security.foo" });
        log.error("could not write");
        return 7;
      });
      expect(value).toBe(7);
      expect(held.map(({ level, component, message, data }) => ({ level, component, message, data }))).toEqual([
        { level: "warn", component: "config", message: "unknown config key ignored", data: { key: "security.foo" } },
      ]);
      expect(out.mock.calls.map((call) => JSON.parse(String(call[0])).message)).toEqual(["could not write"]);
      expect(err).not.toHaveBeenCalled();
      expect(sunk).toEqual(["could not write"]);

      // And after it, a line is written as before.
      configureLogger({ level: "info" });
      log.warn("said");
      expect(String(out.mock.calls[1]?.[0])).toContain('"message":"said"');
    } finally {
      configureLogger({ level: "info", stream: "stdout" });
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("held for a command's report: warn and error kept across an await, info dropped, nothing written until released", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      configureLogger({ level: "error" });
      const log = createLogger("agents.registry");
      const release = holdLines();
      log.info("agents loaded");
      // A pack load is asynchronous: what it logs after an await is held as well.
      await sleep(1);
      log.error("agent pack failed to load", { agent_id: "e2e", error: "two servers named echo" });
      log.warn("USER.md is no longer read", { agent_id: "nouva" });
      const held = release();
      expect(held.map(({ level, message, agent_id }) => ({ level, message, agent_id }))).toEqual([
        { level: "error", message: "agent pack failed to load", agent_id: "e2e" },
        { level: "warn", message: "USER.md is no longer read", agent_id: "nouva" },
      ]);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();

      // Released, a line is written again.
      log.error("written");
      expect(String(out.mock.calls[0]?.[0])).toContain('"message":"written"');
    } finally {
      configureLogger({ level: "info", stream: "stdout" });
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("a level is one of the four, and nothing else is taken for one", () => {
    expect(["debug", "info", "warn", "error"].every(isLogLevel)).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel("toString")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe("a log line written during a turn", () => {
  test("carries the turn's id beside the agent's, out of the free-form data", () => {
    const seen: LogEntry[] = [];
    addLogSink((entry) => void (entry.message === "turn complete" && seen.push(entry)));

    createLogger("pipeline.turn", { agent_id: "ren" }).info("turn complete", { turn_id: "turn_abc", iterations: 2 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent_id: "ren", turn_id: "turn_abc", data: { iterations: 2 } });
    expect(seen[0]!.data).not.toHaveProperty("turn_id");
  });

  test("and none when the caller knew none", () => {
    const seen: LogEntry[] = [];
    addLogSink((entry) => void (entry.message === "no turn here" && seen.push(entry)));

    createLogger("daemon").info("no turn here", { turn_id: undefined });

    expect(seen[0]).not.toHaveProperty("turn_id");
  });
});
