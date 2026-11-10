/**
 * The install's config.toml, as every command reads it: quietly — what the file's notes say is the daemon's to say, and
 * `doctor`'s — and a file this user may not read said in one line.
 *
 * An agent's own user cannot read the service's config. `connect()` said so in one line from 0.8.8, while the commands
 * that read the config themselves — `db`, `doctor`, `stop` — still printed the read's stack trace and then the same
 * error after the ✗. So every command reads it here.
 */

import { loadGlobalConfig, type LoadedConfig } from "@/modules/config/global/index.ts";
import { fail } from "@nouride/cli-kit";

/**
 * Exit 1 with the line on a config this user may not read — or, `soft`, throw it, for a caller that says it its own way
 * or goes on without the config: `connect({ soft: true })`'s (`acp`, `service status`), and `pkg`. `client`: the CLI
 * talking to a daemon (`applyEnvOverrides`). Any other failure is thrown as it was.
 */
export async function loadConfig(options: { client?: boolean; soft?: boolean } = {}): Promise<LoadedConfig> {
  try {
    return await loadGlobalConfig(undefined, { quiet: true, ...(options.client ? { client: true } : {}) });
  } catch (err) {
    const line = unreadableConfig(err);
    if (!line) throw err;
    if (options.soft) throw new Error(line);
    return fail(line);
  }
}

/** What to say for a file the runtime refused to read for its permissions, naming it — or null for any other failure. */
export function unreadableConfig(err: unknown): string | null {
  const { code, path } = (err ?? {}) as { code?: unknown; path?: unknown };
  if (code !== "EACCES" || typeof path !== "string") return null;
  return `Cannot read ${path}: permission denied. An agent sees its own missions, jobs and approvals with its \`work\` tool.`;
}
