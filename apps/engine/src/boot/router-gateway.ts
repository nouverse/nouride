/**
 * A Router install keeps its LLM gateway on, the first time it starts on the build that replaced Router.
 *
 * Router hosted the gateway unless `[nougate] in_process` said otherwise. The Community build it updates to carries
 * the same gateway, off until asked, so an install that ran it on Router's default would come back from the update
 * with it off, and every agent whose provider points at it with nothing answering. So the default it ran on is
 * written into its `config.toml` once: where the build carries the gateway, the file says nothing about it, and the
 * gateway's own data is there to show it ran here. A file that says `false` already meant it, and is left as it is.
 *
 * Only on the Community build, which is what a Router install updates to. Pro has hosted the gateway only when asked
 * since the gateway came to Pro, and wrote the key into the file of every install that ran it then; a Pro install with
 * the gateway's data and no key has it off on purpose, and switching it on would undo that. A source checkout ran it
 * only when its file said so.
 *
 * 0.9.0 deletes this file and its call: an install reaches 0.9 through a release that has run this.
 */

import { dirExists, join, listDir, parseToml } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { BuildEdition } from "@/commons/build.ts";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { gatewayHome } from "@/modules/gateways/nougate-inproc.ts";

const log = createLogger("nougate.router");

/**
 * Whether the gateway kept its state in this install: a database in `$NOUGATE_HOME/data`, where `nougate-inproc.ts`
 * has it put its files, and where only a gateway that ran here writes. Any `.db` there rather than its file by name:
 * that name is the marker the build looks for to prove a build carries the gateway, and naming it in the engine would
 * put it in a build that does not.
 */
function gatewayRanHere(dataDir: string, env: Record<string, string | undefined>): boolean {
  const data = join(gatewayHome(dataDir, env), "data");
  return dirExists(data) && listDir(data).some((entry) => entry.isFile && entry.name.endsWith(".db"));
}

/** Whether the file sets `[nougate] in_process` itself, either way and in any of TOML's spellings. */
function saysInProcess(text: string): boolean {
  const nougate = parseToml<{ nougate?: unknown }>(text).nougate;
  return typeof nougate === "object" && nougate !== null && "in_process" in nougate;
}

/**
 * Write `[nougate] in_process = true` where a Router install ran the gateway on its default — and the running config
 * with it, so it starts on this boot. Answers whether it wrote. A file that cannot be written is logged and left: the
 * daemon starts either way, with the gateway off, which the LLM Gateway page can turn back on.
 */
export async function keepRouterGatewayOn(input: {
  configPath: string;
  config: GlobalConfig;
  carried: boolean;
  edition: BuildEdition;
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  if (input.edition !== "basic" || !input.carried) return false;
  if (!gatewayRanHere(input.config.daemon.dataDir, env)) return false;
  let wrote = false;
  const saved = await editDaemonConfig(input.configPath, input.config, (text) => {
    if (saysInProcess(text)) return text;
    wrote = true;
    return upsertTomlTable(text, "nougate", { in_process: true });
  });
  if (!saved.ok) {
    log.warn("could not keep the LLM gateway on for this former Router install: it starts off", { config: input.configPath, error: saved.error });
    return false;
  }
  if (wrote) log.info("kept the LLM gateway on: it ran here on Router's default, which this build does not have", { config: input.configPath });
  return wrote;
}
