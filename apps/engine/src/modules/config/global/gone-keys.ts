/**
 * Keys 0.8.0 took out of `config.toml`, and what a file that still writes one gets.
 *
 * Two answers, and one rule picks between them: a removed key whose absence would *loosen* what the
 * daemon does is refused at boot, naming the fix (`LOOSER`); one whose absence keeps or tightens it is ignored, with a
 * warning naming the key and what took its place. Never translated: 0.8.0 reads no old form.
 *
 * Two kinds are ignored:
 *
 * - **Fixed values** (`FIXED`) — nobody tuned them, so their values are constants in the code that reads them now: the
 *   heartbeat and its two thresholds (`boot/maintenance.ts`, `web/health.ts`), the scheduler's longest sleep
 *   (`cron/scheduler.ts`), the window a repeated message id is ignored in (`@nouride/queue`), and a gateway's reconnect
 *   pacing (each adapter in `@nouride/gateways`, warned about where gateways are read, `open-sections.ts`).
 * - **The exec knobs the approval levels took** (`INTO_LEVELS`) — `mode`, `ask`, `ask_fallback`, `sensitive_paths`
 *   and the editable allowlist, each a guess at which command is dangerous.
 */

import { ConfigError, createLogger } from "@nouride/shared";
import { isPlainObject } from "./merge.ts";

const log = createLogger("config");

/** What the warning for a fixed value says, and the hint that goes with it — one wording for every fixed key. */
export const FIXED_KEY_IGNORED = "config key is a fixed value since 0.8.0 and ignored";
export const FIXED_KEY_HINT = "remove the line: the value is fixed in the code";

/** A whole section that became fixed, or one key of a section. */
const FIXED: readonly { section: string; key?: string }[] = [
  { section: "health" },
  { section: "cron", key: "tick_interval_ms" },
  { section: "queue", key: "dedup_window_ms" },
];

const CAREFUL = 'choose approvals = "careful" in [security], or in an agent\'s [agent]';

/** `[security.exec]` values that asked more than any level asks without them. */
const LOOSER: readonly { key: string; value: string; refusal: string }[] = [
  { key: "mode", value: "deny", refusal: "take exec out of [tools] enabled in each agent's config.toml that should run no commands" },
  { key: "mode", value: "allowlist", refusal: `${CAREFUL}, which asks before every new command` },
  { key: "ask", value: "always", refusal: `${CAREFUL}, which asks before every new command and remembers only what a person says always to` },
  { key: "sensitive_paths", value: "hardline", refusal: `${CAREFUL}; where each agent runs as its own user these paths are closed to it anyway` },
];

/** The `[security.exec]` keys whose absence keeps or tightens what runs, with what replaced each. */
const INTO_LEVELS: readonly { key: string; note: string }[] = [
  { key: "mode", note: "any command may run, and how much asks is [security] approvals" },
  { key: "ask", note: "how much asks is [security] approvals (careful, balanced or trusted)" },
  { key: "ask_fallback", note: "what would ask is refused when nobody can be asked, at every level" },
  { key: "sensitive_paths", note: "a credential path asks once under careful, and its output is masked at every level" },
  { key: "allowlist", note: "the everyday programs that never ask are a fixed list" },
];

/** Refuse a removed value that would loosen what runs, naming each. */
export function refuseLooserExec(raw: Record<string, unknown>): void {
  const exec = execTable(raw);
  if (!exec) return;
  const found = LOOSER.filter((entry) => exec[entry.key] === entry.value);
  if (found.length === 0) return;
  throw new ConfigError(
    found.map((entry) => `config.toml [security.exec] ${entry.key} = "${entry.value}" is gone in 0.8.0: ${entry.refusal}`).join("\n"),
  );
}

/**
 * `raw` without the keys 0.8.0 took out, each one present named in a warning — before the merge, which would call it
 * unknown. A copy where something was dropped, since the parsed file is not the loader's to change; `raw` itself where
 * nothing was.
 */
export function withoutGoneKeys(raw: Record<string, unknown>): Record<string, unknown> {
  let out = raw;
  for (const { section, key } of FIXED) {
    const table = out[section];
    if (table === undefined) continue;
    if (key === undefined) {
      const { [section]: _dropped, ...rest } = out;
      const named = isPlainObject(table) ? Object.keys(table) : [];
      for (const name of named.length > 0 ? named : [""]) {
        log.warn(FIXED_KEY_IGNORED, { key: name ? `[${section}] ${name}` : `[${section}]`, hint: FIXED_KEY_HINT });
      }
      out = rest;
      continue;
    }
    if (!isPlainObject(table) || !(key in table)) continue;
    const { [key]: _dropped, ...kept } = table;
    log.warn(FIXED_KEY_IGNORED, { key: `[${section}] ${key}`, hint: FIXED_KEY_HINT });
    out = { ...out, [section]: kept };
  }
  const exec = execTable(out);
  const gone = exec ? INTO_LEVELS.filter((entry) => entry.key in exec) : [];
  if (gone.length === 0) return out;
  for (const entry of gone) {
    log.warn(`config.toml [security.exec] ${entry.key} is gone in 0.8.0 and ignored: ${entry.note}`, { key: `security.exec.${entry.key}` });
  }
  const kept = Object.fromEntries(Object.entries(exec!).filter(([key]) => !gone.some((entry) => entry.key === key)));
  const security = out.security as Record<string, unknown>;
  return { ...out, security: { ...security, exec: kept } };
}

function execTable(raw: Record<string, unknown>): Record<string, unknown> | null {
  return isPlainObject(raw.security) && isPlainObject(raw.security.exec) ? raw.security.exec : null;
}
