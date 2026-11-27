/**
 * Antigravity, Google's coding CLI (`agy`), in its own ACP mode. Seen on Linux with no account (agy 1.5.18): `agy acp`
 * answers its handshake and offers its sign-ins (`oauth-personal` among them), and refuses a session until signed in;
 * `agy acp --login` prints a Google link and asks for the code pasted back. Run on an account on the live box: it
 * answered, and wrote and edited files in its folder unasked on Free in its folder. A Google AI Pro or Ultra plan is what
 * it answers on.
 */

import type { CliRow } from "./row.ts";

export const antigravity: CliRow = {
  id: "antigravity",
  name: "Antigravity",
  maker: "Google",
  ownKept: true,
  command: "agy",
  args: ["acp"],
  install: "nouride agents install antigravity",
  // Its installer leaves one file, `~/.local/bin/agy` (seen on Linux, 1.5.18).
  script: { url: "https://antigravity.google/cli/install.sh", binary: ".local/bin/agy" },
  versionArgs: ["--version"],
  // Its own updater off: it is updated the way it was installed, by running the install again.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  // The modes its sessions offer (seen on the live box, 1.5.18): `default` asks before edits and commands, `accept-edits`
  // makes edits in the workspace unasked, `auto` makes edits and safe commands unasked and asks before what it cannot
  // undo, which Free in its folder answers itself. Its unasked-for-everything is a start flag, not a mode.
  modes: { folder: "auto", risky: "accept-edits", all: "default" },
  instructionFile: "AGENTS.md",
  // A Google link, then the code from the page it lands on, pasted back.
  login: ["acp", "--login"],
  loginNote: "Signs in with a Google account on a Google AI Pro or Ultra plan.",
  authenticate: ["oauth-personal"],
  // What its sign-in wrote that is the sign-in (seen on the live box, 1.5.18, with no keyring): the Google token, and
  // which sign-in it is. Beside them it wrote its log, which names the Google account, and its conversations' database.
  signInFiles: [".gemini/antigravity-cli/antigravity-oauth-token", ".gemini/antigravity-cli/cache/acp-auth-state.json"],
};
