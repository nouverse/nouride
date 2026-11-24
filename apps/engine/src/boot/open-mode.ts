/**
 * An install that held `[security.access] mode = "open"`, everyone let in on every connection, is brought forward.
 *
 * `open` is one agent's now (`[agent] access`), and such an agent holds none of its pack's tools. An install's own
 * `open` cannot be read as that: with one agent, that agent is the orchestrator, which is never open; and a person's
 * own assistant set `open` for convenience would lose every tool it has. So the install becomes `pair`, and everyone
 * whose message an agent here already answered is let in by name, on the connection they wrote on: they go on
 * talking, and only a new sender meets a pairing code. Nobody is opened by this.
 *
 * In the order that locks nobody out: the senders first, then the file. Stopped between the two, the next start does
 * both again, and letting in somebody already let in changes nothing. A block is kept. The loader reads the old value
 * as `pair` already (`config/global/index.ts`), so the running daemon never holds it. The next minor deletes this file,
 * its call and that reading: an install reaches it through a release that ran this.
 */

import { parseToml } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { AccessStore } from "@/modules/access/access.store.ts";
import type { OpenModeStore } from "@/modules/access/open-mode.store.ts";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";

const log = createLogger("config.access");

/** Whether a config file still says the whole install is open. A file that does not parse says nothing: the loader refuses it. */
export function holdsOpenMode(text: string): boolean {
  try {
    const raw = parseToml<{ security?: { access?: { mode?: unknown } } }>(text);
    return raw.security?.access?.mode === "open";
  } catch {
    return false;
  }
}

/** What `config check` says of such a file before a start writes it. */
export const OPEN_MODE_NOTE = {
  message: '[security.access] mode = "open" is no longer taken: the next start writes mode = "pair", and lets in by name everyone an agent here has already answered',
  hint: "From then on a new sender is given a pairing code. To let anyone talk to one agent, open that agent to everyone on its Access page in the dashboard: it then answers with a few tools of Nouride's own, and none of its pack's.",
};

/** Let in everyone who already talks to the install, then write `pair`. Answers how many were let in, or null when the file never said `open`. */
export async function bringOpenModeForward(input: {
  configPath: string;
  config: GlobalConfig;
  source: string;
  senders: Pick<OpenModeStore, "senders">;
  access: Pick<AccessStore, "allowMany">;
}): Promise<{ letIn: number; already: number } | null> {
  if (!holdsOpenMode(input.source)) return null;
  // The connections of this install's own chat apps: not the dashboard's, whose senders are signed-in accounts, and not
  // one that was removed since, which nobody can write on.
  const own = new Set(input.config.gateways.map((gateway) => gateway.id));
  const byConnection = new Map<string, { senderId: string }[]>();
  for (const { gatewayId, senderId } of input.senders.senders()) {
    if (!own.has(gatewayId) || senderId === SYSTEM_SENDER) continue;
    byConnection.set(gatewayId, [...(byConnection.get(gatewayId) ?? []), { senderId }]);
  }
  let letIn = 0;
  let already = 0;
  for (const [gatewayId, senders] of byConnection) {
    const done = input.access.allowMany(gatewayId, senders, "upgrade");
    letIn += done.added;
    already += done.already;
  }
  const saved = await editDaemonConfig(input.configPath, input.config, (text) => upsertTomlTable(text, "security.access", { mode: "pair" }));
  if (!saved.ok) {
    // The daemon runs as `pair` either way, with everyone above let in: only the file still says the old word, and the
    // next start tries again.
    log.warn('could not write [security.access] mode = "pair" into config.toml', { config: input.configPath, error: saved.error });
    return { letIn, already };
  }
  log.info('[security.access] mode was "open", which is one agent\'s now: written as "pair", and everyone an agent here had answered let in by name', {
    let_in: letIn,
    already_in: already,
    hint: OPEN_MODE_NOTE.hint,
  });
  return { letIn, already };
}
