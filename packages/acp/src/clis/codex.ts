/**
 * Codex, through OpenAI's ACP connector, `codex-acp`, which carries Codex itself.
 */

import type { CliRow } from "./row.ts";

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
};
