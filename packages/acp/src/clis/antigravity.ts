/**
 * Antigravity, Google's coding CLI (`agy`), in its own ACP mode. Seen on Linux with no account (agy 1.5.18): `agy acp`
 * answers its handshake and offers its sign-ins (`oauth-personal` among them), and refuses a session until signed in;
 * `agy acp --login` prints a Google link and asks for the code pasted back. Not yet run on an account: experimental.
 * A Google AI Pro or Ultra plan is what it answers on.
 */

import type { CliRow } from "./row.ts";

export const antigravity: CliRow = {
  id: "antigravity",
  name: "Antigravity",
  maker: "Google",
  experimental: true,
  command: "agy",
  args: ["acp"],
  install: "nouride agents install antigravity",
  // Its installer leaves one file, `~/.local/bin/agy` (seen on Linux, 1.5.18).
  script: { url: "https://antigravity.google/cli/install.sh", binary: ".local/bin/agy" },
  versionArgs: ["--version"],
  // Its own updater off: it is updated the way it was installed, by running the install again.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  instructionFile: "AGENTS.md",
  // A Google link, then the code from the page it lands on, pasted back.
  login: ["acp", "--login"],
  loginNote: "Signs in with a Google account on a Google AI Pro or Ultra plan.",
  authenticate: ["oauth-personal"],
};
