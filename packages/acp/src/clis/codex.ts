/**
 * Codex, through OpenAI's ACP connector, `codex-acp`, which carries Codex itself.
 */

import type { CliRow, CliUse, UseWindow } from "./row.ts";
import { field, numberOf, percent, timeOf } from "./read.ts";

/**
 * OpenAI's answer for a ChatGPT plan's Codex use (`/backend-api/wham/usage`, what Codex's own status reads): the short
 * window and the weekly one, each's share used and its end, and whether credits beyond them are left.
 */
export function codexUse(answer: unknown): CliUse | null {
  const limit = field(answer, "rate_limit");
  const window = (value: unknown): UseWindow | null => {
    const used = numberOf(field(value, "used_percent"));
    if (used === null) return null;
    const seconds = numberOf(field(value, "limit_window_seconds"));
    return { usedPercent: percent(used), minutes: seconds === null ? null : Math.round(seconds / 60), resetsAt: timeOf(field(value, "reset_at")) };
  };
  const windows = [window(field(limit, "primary_window")), window(field(limit, "secondary_window"))].filter((one): one is UseWindow => one !== null);
  if (windows.length === 0) return null;
  const credits = field(answer, "credits", "has_credits");
  return { limits: [{ id: "codex", label: "Codex", windows }], ...(typeof credits === "boolean" ? { creditsLeft: credits } : {}) };
}

export const codex: CliRow = {
  id: "codex",
  name: "Codex",
  maker: "OpenAI",
  command: "codex-acp",
  args: [],
  install: "npm i -g @agentclientprotocol/codex-acp (it carries Codex itself)",
  package: "@agentclientprotocol/codex-acp",
  // 2.3.0 on the box, and 2.5.0 the e2e VM's Codex, each the version there on 2026-11-08.
  // 2.6.0 on the box since: its handshake check passed, and an agent on it answered a turn and one that ran a command.
  tested: { lowest: "2.3.0", highest: "2.6.0" },
  carries: { name: "Codex", package: "@openai/codex", field: "version" },
  versionArgs: ["--version"],
  // The folder must exist before it starts, or the handshake itself fails.
  profileEnv: "CODEX_HOME",
  profileFiles: { "config.toml": 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n' },
  modes: { folder: "agent-full-access", risky: "agent", all: "read-only" },
  steering: true,
  instructionFile: "AGENTS.md",
  // A person's own override file beside it is read in its place, as Codex's documentation says.
  profileInstructionFile: "AGENTS.md",
  // CODEX_HOME/skills: its user skills (its own binary reads them there, 0.164); its `.system` folder is its own.
  skillsDir: "skills",
  // A link and a one-time code; device-code sign-in has to be switched on in the ChatGPT account's security settings.
  login: ["cli", "login", "--device-auth"],
  loginNote: "Signs in with ChatGPT. Turn on device-code sign-in in your ChatGPT security settings first.",
  // The account's use at any time, asked of OpenAI with the profile's own sign-in and its account.
  // Its ChatGPT sign-in, `codex login` writes in CODEX_HOME.
  signInFiles: ["auth.json"],
  readUse: {
    kind: "http",
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    token: [{ file: "auth.json", path: ["tokens", "access_token"] }],
    fileHeaders: { "ChatGPT-Account-Id": { file: "auth.json", path: ["tokens", "account_id"] } },
    parse: (answer) => codexUse(answer),
  },
};
