/**
 * Cursor's coding CLI, in its ACP mode. Seen on Linux with no account (2026.11.22-e9042b2): `cursor-agent acp`
 * answers its handshake with one sign-in, `cursor_login`, and refuses a session until it is told that one, as its own
 * refusal says; `cursor-agent login` prints a link to open on any device and waits for it. Its installer names its
 * command `agent`, which Grok Build's installer also takes, so it is started by its own name, `cursor-agent`. Not yet
 * run on an account: experimental. Its account's use is asked of Cursor's dashboard service with its kept token.
 */

import type { CliRow, CliUse, UseWindow } from "./row.ts";
import { field, numberOf, percent, timeOf } from "./read.ts";

/** `GetCurrentPeriodUsage`'s answer: the billing cycle, and the plan used in percent, split where Cursor splits it. */
export function cursorUse(answer: unknown): CliUse | null {
  const start = timeOf(field(answer, "billingCycleStart"));
  const end = timeOf(field(answer, "billingCycleEnd"));
  const window = (used: number | null): UseWindow | null =>
    used === null ? null : { usedPercent: percent(used), minutes: start && end && end > start ? Math.round((end - start) / 60_000) : null, resetsAt: end };
  const plan = (key: string) => window(numberOf(field(answer, "planUsage", key)));
  const limits = [
    { id: "total", label: "Plan", window: plan("totalPercentUsed") },
    { id: "auto", label: "Auto", window: plan("autoPercentUsed") },
    { id: "api", label: "Named models", window: plan("apiPercentUsed") },
  ].flatMap((limit) => (limit.window ? [{ id: limit.id, label: limit.label, windows: [limit.window] }] : []));
  return limits.length > 0 ? { limits } : null;
}

export const cursor: CliRow = {
  id: "cursor",
  name: "Cursor CLI",
  maker: "Cursor",
  experimental: true,
  ownKept: true,
  command: "cursor-agent",
  // Its own updater off, by its switch for it (read in its code; it takes it before any command): it is updated the way
  // it was installed. Seen accepted on `acp`, `login` and `--version` in a Linux container; not yet seen at an update.
  args: ["--disable-auto-update", "acp"],
  install: "nouride agents install cursor",
  // Its installer names it `agent` in `~/.local/bin`, a link into a folder of its version holding `cursor-agent` and
  // what it runs on: the whole folder is the CLI, linked by its own name (seen on Linux, 2026.11.22).
  script: { url: "https://cursor.com/install", binary: ".local/bin/agent", folder: true },
  versionArgs: ["--disable-auto-update", "--version"],
  // Its sign-in prints a link and waits, with no browser opened on the box.
  env: { NO_OPEN_BROWSER: "1" },
  instructionFile: "AGENTS.md",
  login: ["--disable-auto-update", "login"],
  loginNote: "Signs in with a Cursor account.",
  authenticate: ["cursor_login"],
  // Its sign-in on a box with no keyring, where its use reader reads the token too.
  signInFiles: [".config/cursor/auth.json"],
  readUse: {
    kind: "http",
    method: "POST",
    url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    token: [{ file: ".config/cursor/auth.json", path: ["accessToken"] }],
    headers: { "Content-Type": "application/json" },
    body: "{}",
    parse: (answer) => cursorUse(answer),
  },
};
