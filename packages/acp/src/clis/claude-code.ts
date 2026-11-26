/**
 * Claude Code, through Anthropic's ACP connector, `claude-agent-acp`, which carries Claude Code itself.
 */

import type { CliRow, CliUse, UseLimit } from "./row.ts";
import { field, numberOf, percent, timeOf } from "./read.ts";

const WINDOWS: Readonly<Record<string, { label: string; minutes: number }>> = {
  five_hour: { label: "5-hour", minutes: 300 },
  seven_day: { label: "Weekly", minutes: 10_080 },
};

/** A limit by its key: one of the account's windows, or a model's own weekly one (`seven_day_opus`). */
function limitNamed(key: string): { label: string; minutes: number; models?: string[] } | null {
  const known = WINDOWS[key];
  if (known) return known;
  const model = key.startsWith("seven_day_") ? key.slice("seven_day_".length) : "";
  return model ? { label: `Weekly, ${model}`, minutes: 10_080, models: [model] } : null;
}

/**
 * What claude-agent-acp says of the account's use with every count of the context: each window of
 * `_meta["_claude/rateLimit"].unifiedWindows`, its share used from 0 to 1 and when it starts again in seconds.
 */
export function claudeSaid(update: unknown): CliUse | null {
  const windows = field(update, "_meta", "_claude/rateLimit", "unifiedWindows");
  const limits: UseLimit[] = [];
  for (const [key, value] of Object.entries(windows && typeof windows === "object" ? windows : {})) {
    const used = field(value, "utilization");
    const resets = field(value, "resetsAt");
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof resets !== "number" || !Number.isFinite(resets)) continue;
    const named = limitNamed(key);
    limits.push({ id: key, label: named?.label ?? key.replaceAll("_", " "), ...(named?.models ? { models: named.models } : {}), windows: [{ usedPercent: percent(used * 100), minutes: named?.minutes ?? null, resetsAt: resets * 1000 }] });
  }
  return limits.length > 0 ? { limits } : null;
}

/**
 * Anthropic's answer for a Claude subscription's use (`/api/oauth/usage`, what Claude Code's own `/usage` reads): each
 * window's share used in percent and its end, the weekly ones of a model beside the account's own, as keys
 * (`seven_day_opus`) or as entries of `limits` (`weekly_scoped`, the model named in its scope).
 */
export function claudeUse(answer: unknown): CliUse | null {
  const limits: UseLimit[] = [];
  const window = (value: unknown, minutes: number) => {
    const used = numberOf(field(value, "utilization"));
    return used === null ? null : { usedPercent: percent(used), minutes, resetsAt: timeOf(field(value, "resets_at")) };
  };
  for (const [key, value] of Object.entries(answer && typeof answer === "object" ? answer : {})) {
    const named = limitNamed(key);
    const said = named ? window(value, named.minutes) : null;
    if (named && said) limits.push({ id: key, label: named.label, ...(named.models ? { models: named.models } : {}), windows: [said] });
  }
  const scoped = field(answer, "limits");
  for (const limit of Array.isArray(scoped) ? scoped : []) {
    const model = field(limit, "scope", "model", "display_name");
    const used = numberOf(field(limit, "percent"));
    if (field(limit, "kind") !== "weekly_scoped" || typeof model !== "string" || used === null) continue;
    limits.push({ id: `weekly_${model.toLowerCase()}`, label: `Weekly, ${model}`, models: [model], windows: [{ usedPercent: percent(used), minutes: 10_080, resetsAt: timeOf(field(limit, "resets_at")) }] });
  }
  // Extra usage turned on: past a window it goes on, paid for, so a window at its end is not the account spent.
  const extra = field(answer, "extra_usage", "is_enabled") === true;
  return limits.length > 0 ? { limits, ...(extra ? { creditsLeft: true } : {}) } : null;
}

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
  use: claudeSaid,
  // 0.107.0, read in its own source on the box: every update of a subagent's carries
  // `_meta.claudeCode.parentToolUseId`, the `Agent` call that started it. With no word from the client that it reads
  // a subagent's work after a prompt, it keeps the prompt open until its background subagents end.
  helper: { meta: "claudeCode", parent: "parentToolUseId" },
  // 0.107.0, read in its own source on the box: the usage update it sends at a turn's result is the one that
  // carries `cost`; those between steps do not.
  ended: { usage: "cost" },
  loginNote: "Signs in with a Claude subscription.",
  // The account's use at any time, asked of Anthropic with the account's token: a shared one's, else the profile's own.
  readUse: {
    kind: "http",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    token: [{ env: "CLAUDE_CODE_OAUTH_TOKEN" }, { file: ".credentials.json", path: ["claudeAiOauth", "accessToken"] }],
    headers: { "anthropic-beta": "oauth-2025-04-20" },
    parse: (answer) => claudeUse(answer),
  },
};
