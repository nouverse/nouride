/**
 * Grok Build, xAI's coding CLI (`grok`), in its ACP mode. Seen on Linux with no account (grok 1.0.92): `grok agent
 * stdio` answers its handshake and refuses a session with "no auth method id provided" until it is told how its kept
 * sign-in is read; `grok login --device-code` prints a link and a code to confirm. Not yet run on an account:
 * experimental. Its use is asked over the protocol while it runs, as xAI's own clients ask it.
 */

import type { CliRow, CliUse } from "./row.ts";
import { field, numberOf, percent, timeOf } from "./read.ts";

/** A plan's credits used this period, in percent: said outright, or as cents used of a monthly limit. */
function creditsUsed(config: unknown): number | null {
  const said = numberOf(field(config, "creditUsagePercent"));
  if (said !== null) return percent(said);
  const limit = numberOf(field(config, "monthlyLimit", "val"));
  const used = numberOf(field(config, "used", "val")) ?? 0;
  return limit && limit > 0 ? percent((used / limit) * 100) : null;
}

/** `_x.ai/billing`'s answer: the plan's period and how much of its credits is used. */
export function grokUse(answer: unknown): CliUse | null {
  const config = field(answer, "config");
  const used = creditsUsed(config);
  if (used === null) return null;
  const start = timeOf(field(config, "currentPeriod", "start"));
  const end = timeOf(field(config, "currentPeriod", "end"));
  return {
    limits: [{ id: "credits", label: "Plan credits", windows: [{ usedPercent: used, minutes: start && end && end > start ? Math.round((end - start) / 60_000) : null, resetsAt: end }] }],
  };
}

export const grok: CliRow = {
  id: "grok",
  name: "Grok Build",
  maker: "xAI",
  experimental: true,
  ownKept: true,
  command: "grok",
  args: ["--no-auto-update", "agent", "stdio"],
  install: "nouride agents install grok",
  // Its installer leaves `~/.grok/bin/grok`, a link to the one file beside it (seen on Linux, 1.0.92).
  script: { url: "https://x.ai/cli/install.sh", binary: ".grok/bin/grok" },
  // Its own updater off for every command it is started with, its version and its sign-in too.
  versionArgs: ["--no-auto-update", "--version"],
  profileEnv: "GROK_HOME",
  instructionFile: "AGENTS.md",
  // A link and a code to confirm on any device.
  login: ["--no-auto-update", "login", "--device-code"],
  loginNote: "Signs in with a Grok account on a SuperGrok or X Premium+ plan.",
  // Its sign-in kept by `grok login` first, an API key next, the Grok sign-in it offers when it has neither.
  authenticate: ["cached_token", "xai.api_key", "grok.com"],
  readUse: { kind: "acp", method: "_x.ai/billing", parse: (answer) => grokUse(answer) },
};
