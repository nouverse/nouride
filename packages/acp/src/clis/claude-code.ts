/**
 * Claude Code, through Anthropic's ACP connector, `claude-agent-acp`, which carries Claude Code itself.
 */

import type { CliRow } from "./row.ts";

export const claudeCode: CliRow = {
  id: "claude-code",
  name: "Claude Code",
  maker: "Anthropic",
  command: "claude-agent-acp",
  args: [],
  install: "npm i -g @agentclientprotocol/claude-agent-acp (Node 22 or later; it carries Claude Code itself)",
  package: "@agentclientprotocol/claude-agent-acp",
  // 0.95.0 answered the owner's agents on the box, and 0.100.0 the e2e VM's Claude, each the version there on 2026-11-08.
  // 0.107.0 on the box since: its handshake check passed, and a turn answered on its default model and on `fable`.
  tested: { lowest: "0.95.0", highest: "0.107.0" },
  // The SDK holds Claude Code's own binary, and says its version in a field of its own (0.3.323: "2.1.323").
  carries: { name: "Claude Code", package: "@anthropic-ai/claude-agent-sdk", field: "claudeCodeVersion" },
  versionArgs: ["--version"],
  profileEnv: "CLAUDE_CONFIG_DIR",
  // v1 pinned: the adapter also serves a draft v2 to a client that asks. No claude.ai connectors: a profile signed in
  // with a claude.ai account loaded that account's Gmail, Drive and Docs tools — reaching outside Nouride's gate and
  // audit, where an agent's MCP servers go through it (the live box, 0.8.1; the switch is Claude Code's own).
  env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1", DISABLE_AUTOUPDATER: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
  modes: { folder: "bypassPermissions", risky: "acceptEdits", all: "default" },
  steering: true,
  instructionFile: "CLAUDE.md",
  // CLAUDE_CONFIG_DIR/skills: its user skills, read in any folder — a mission's repository too.
  skillsDir: "skills",
  mcpEnvHeaders: true,
  // Prints a link; the browser cannot reach the box's callback, so it asks for the code the page then shows.
  login: ["--cli", "auth", "login", "--claudeai"],
  // Measured on the box (2026-10-26): exit 0 on a signed-in profile, 1 on one never signed in.
  status: ["--cli", "auth", "status"],
  // `claude setup-token`: Claude Code's own long-lived sign-in for a machine with no browser, read from the variable.
  sharedLogin: { args: ["--cli", "setup-token"], env: "CLAUDE_CODE_OAUTH_TOKEN", tokenPrefix: "sk-ant-oat01-" },
  // A real refusal of 0.107.0 at a model's limit: code -32603, data `{ "errorKind": "rate_limit" }`. A limit that
  // came with a rate-limit event of its turn adds `rateLimit`, whose `resetsAt` is in seconds; a model's own did not.
  limit: { key: "errorKind", value: "rate_limit", resets: "rateLimit.resetsAt" },
  // Every `usage_update` of 0.107.0, read on the box: `_meta["_claude/rateLimit"].unifiedWindows` holds
  // `five_hour` and `seven_day`, each `{ utilization: 0.44, resetsAt: 1794675000, status: "allowed" }`.
  use: { meta: "_claude/rateLimit", windows: "unifiedWindows", used: "utilization", resets: "resetsAt" },
  // 0.107.0, read in its own source on the box: every update of a subagent's carries
  // `_meta.claudeCode.parentToolUseId`, the `Agent` call that started it. With no word from the client that it reads
  // a subagent's work after a prompt, it keeps the prompt open until its background subagents end.
  helper: { meta: "claudeCode", parent: "parentToolUseId" },
  // 0.107.0, read in its own source on the box: the usage update it sends at a turn's result is the one that
  // carries `cost`; those between steps do not.
  ended: { usage: "cost" },
  loginNote: "Signs in with a Claude subscription.",
};
