/**
 * An install's one WhatsApp login, kept where it is when each connection is given a folder of its own.
 *
 * While a daemon held one WhatsApp number, a connection whose table named no `session_dir` kept its login in
 * `whatsapp` under the data folder, whatever the connection was called. Each connection has its own folder now, named
 * for it, so that connection would look in a new, empty one and ask for a scan again: an install broken by an update.
 * At the first start of this build the folder its login is in is written into its table, once, and from then on it is
 * read from the file and not worked out.
 *
 * Which connection the login is: the one that was running. A daemon opened one bridge, the first WhatsApp connection
 * it started, so it is the first one switched on whose table names no folder, or the first of any when none is on.
 * The login is never moved: the build before this one reads the same line, which is the way back.
 */

import { join, parseToml, statFile } from "@nouride/runtime";
import { createLogger, type GatewayInstanceConfig, type GlobalConfig } from "@nouride/shared";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { sharedLoginDir } from "@/modules/config/global/paths.ts";

const log = createLogger("config.whatsapp");

/** The tables of the file's WhatsApp connections that name a `session_dir` themselves. */
function namedInFile(source: string): Set<string> {
  try {
    const raw = parseToml<{ gateways?: { whatsapp?: Record<string, { session_dir?: unknown }> } }>(source);
    return new Set(Object.entries(raw.gateways?.whatsapp ?? {}).flatMap(([name, table]) => (typeof table?.session_dir === "string" && table.session_dir.trim() ? [name] : [])));
  } catch {
    return new Set();
  }
}

/**
 * The connection whose login is in the old shared folder, or null: no login is kept there, a connection already
 * names that folder, or no WhatsApp connection is left without a folder of its own in the file.
 */
function keeperOfSharedLogin(config: GlobalConfig, source: string): GatewayInstanceConfig | null {
  const shared = sharedLoginDir(config.daemon.dataDir);
  if (!statFile(join(shared, "creds.enc"))) return null;
  const numbers = config.gateways.filter((gateway) => gateway.platform === "whatsapp");
  if (numbers.some((gateway) => gateway.sessionDir === shared)) return null;
  const named = namedInFile(source);
  const unnamed = numbers.filter((gateway) => !named.has(gateway.name));
  return unnamed.find((gateway) => gateway.enabled) ?? unnamed[0] ?? null;
}

/** What `config check` says of it before a start does it. */
export function sharedLoginNote(config: GlobalConfig, source: string): { message: string; hint: string } | null {
  const keeper = keeperOfSharedLogin(config, source);
  if (!keeper) return null;
  return {
    message: `[gateways.whatsapp.${keeper.name}] names no session_dir, and its login is in ${sharedLoginDir(config.daemon.dataDir)}: the next start writes that folder into its table, so the number stays linked`,
    hint: "Each WhatsApp connection keeps its login in a folder of its own now. Nothing is moved, and no scan is needed.",
  };
}

/**
 * The folder as the file should say it: under the data folder as the file itself writes that, or as the default has
 * it where the file says nothing, so an install moved whole still finds its login; the whole path where something
 * else says where data lives (`NOURIDE_DATA_DIR` in a container), since the file's own word then leads elsewhere.
 * Whichever it is, it is what the loader reads back as the folder the login is in: asked of the loader itself.
 */
function asWritten(input: { configPath: string; source: string; table: string; name: string; shared: string }): string {
  let dataDir: unknown;
  try {
    dataDir = parseToml<{ daemon?: { data_dir?: unknown } }>(input.source).daemon?.data_dir;
  } catch {
    // A file that does not parse was not loaded, and this is not reached.
  }
  const written = join(typeof dataDir === "string" && dataDir.trim() ? dataDir : DEFAULT_CONFIG.daemon.dataDir, "whatsapp");
  try {
    const read = readConfigText(upsertTomlTable(input.source, input.table, { session_dir: written }), input.configPath);
    return read.gateways.find((gateway) => gateway.platform === "whatsapp" && gateway.name === input.name)?.sessionDir === input.shared ? written : input.shared;
  } catch {
    return input.shared;
  }
}

/**
 * Keep the install's login where it is: the running config is pointed at it before any connection opens, and the
 * file is told. Run again it does nothing, since a connection then names the folder. Returns the connection, or null.
 */
export async function keepSharedWhatsappLogin(input: { configPath: string; config: GlobalConfig; source: string }): Promise<{ id: string; dir: string } | null> {
  const keeper = keeperOfSharedLogin(input.config, input.source);
  if (!keeper) return null;
  const shared = sharedLoginDir(input.config.daemon.dataDir);
  // First, and whatever happens to the file: this run must open the login the number is linked by.
  keeper.sessionDir = shared;
  const table = `gateways.whatsapp.${keeper.name}`;
  const sessionDir = asWritten({ configPath: input.configPath, source: input.source, table, name: keeper.name, shared });
  const saved = await editDaemonConfig(input.configPath, input.config, (text) => upsertTomlTable(text, table, { session_dir: sessionDir }));
  if (!saved.ok) {
    // The daemon runs on the right folder either way: only the file does not say so yet, and the next start tries again.
    log.warn(`could not write [${table}] session_dir into config.toml`, { config: input.configPath, error: saved.error });
    return { id: keeper.id, dir: shared };
  }
  log.info("a WhatsApp connection's login is kept where it is, and its folder written into config.toml", { gateway: keeper.id, session_dir: sessionDir });
  return { id: keeper.id, dir: shared };
}
