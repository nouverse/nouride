/**
 * The spawned CLI sees the test's install and nothing of the shell that ran the test — `cli-harness.ts` says why.
 */

import { expect, test } from "bun:test";
import { cliEnv } from "../cli-harness.ts";

test("the child's environment is an allowlist, the test's config and its log floor — no NOURIDE_* from this process", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    NOURIDE_DATA_DIR: "/srv/real/data",
    NOURIDE_AGENTS_DIR: "/srv/real/agents",
    NOURIDE_AGENT_ID: "nouva",
    NOURIDE_TOKEN: "t",
    NOURIDE_URL: "http://real",
    PORT: "18254",
    LOG_LEVEL: "debug",
  };
  expect(cliEnv("/tmp/t/config.toml", {}, shell)).toEqual({ PATH: "/usr/bin", HOME: "/home/x", NOURIDE_CONFIG: "/tmp/t/config.toml", LOG_LEVEL: "error" });
  expect(cliEnv("/tmp/t/config.toml", { LOG_LEVEL: "info" }, shell).LOG_LEVEL).toBe("info");
});
