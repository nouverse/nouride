/**
 * The install's `.env`, read by the daemon itself — for `nouride start` only.
 *
 * The compiled binary used to load a `.env` and a `bunfig.toml` from whatever directory it ran in, which Bun does
 * unless told not to. A `bunfig.toml` preload is code: one in the install directory — which the service user owns,
 * and agents can write — ran inside the daemon at its next start, and inside anything root ran from there. A `.env`
 * in a web project fed `PORT` and `NOURIDE_*` to every CLI command run inside it. The build now turns both off
 * (`scripts/build/core.ts`), and this puts back the one part an install relies on: its own `.env`, for the daemon,
 * where systemd's `EnvironmentFile=` is not there to read it — launchd, and a daemon started by hand.
 *
 * The environment wins, as it did: a variable already set is never replaced, so `EnvironmentFile=` and compose's
 * `env_file` stay what decides under a supervisor.
 */

import { join, readTextFileSync, statFile } from "@nouride/runtime";

/**
 * `KEY=value` lines, as a `.env` writes them: `export ` allowed in front, `#` starting a comment, a value in single
 * quotes kept as written, one in double quotes with `\n` read as a newline, a bare one trimmed and cut at ` #`.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match as unknown as [string, string, string];
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      const end = rest.indexOf(quote, 1);
      const inner = end > 0 ? rest.slice(1, end) : rest.slice(1);
      out[key] = quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
    } else {
      out[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return out;
}

/** Sets, from `<root>/.env`, each variable the environment does not already have. Which names it set. */
export function loadInstallEnv(root: string, env: Record<string, string | undefined> = process.env): string[] {
  if (!root) return [];
  const path = join(root, ".env");
  if (statFile(path)?.isDirectory !== false) return [];
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(readTextFileSync(path)))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    set.push(key);
  }
  return set;
}

/**
 * The port the daemon of the install whose data directory is `dataDir` answers on, from that install's own `.env` — or
 * null where it sets none, or the data directory is not `<install>/.nouride/data`.
 *
 * The daemon takes `PORT` from there over its config file (`loadInstallEnv`, or the unit's `EnvironmentFile=`), and
 * `install.sh --port` writes it there. The CLI reads no `PORT` from its environment — any web project's `.env` sets one
 * (`applyEnvOverrides`) — so it knocked on the config's port, 18254 on a fresh install, and said the daemon on 18299 was
 * not running. The install's own file is not a stranger's.
 */
export function installEnvPort(dataDir: string): number | null {
  const parts = dataDir.replace(/\/+$/, "").split("/");
  if (parts.length < 3 || parts.at(-1) !== "data" || parts.at(-2) !== ".nouride") return null;
  const path = join(parts.slice(0, -2).join("/") || "/", ".env");
  if (statFile(path)?.isDirectory !== false) return null;
  try {
    const port = Number.parseInt(parseDotEnv(readTextFileSync(path)).PORT ?? "", 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    // Not this account's to read: the config's port, as before.
    return null;
  }
}
