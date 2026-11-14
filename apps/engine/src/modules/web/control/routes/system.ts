/**
 * The System page: what the machine is using, and how large the data folder is. The folder's files are
 * `system-files.ts`'s, registered from here since both read the same folder.
 *
 * An admin's, each route, and asked first: the data folder holds every person's files and chats, as the logs hold
 * their every line.
 */

import type { SystemFolderSizes, SystemOverview } from "@nouride/wire";
import { commandsMemory, dirname, diskSpace, processHeldBytes, readMachine, readMemoryUse } from "@nouride/runtime";
import { VERSION } from "@/commons/version.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { listFolder } from "../system-files.ts";
import { FolderSizes } from "../system-usage.ts";
import { ADMINS_ONLY, registerSystemFileRoutes } from "./system-files.ts";

export function registerSystemRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The folder the config file is in: `.nouride`, where agents, workspaces and the data all live by default. Worked
   * out when a route is first asked, not as they are registered: a context a test wires holds less than a config.
   */
  let folder: { root: string; sizes: FolderSizes } | null = null;
  const at = () => (folder ??= ((root) => ({ root, sizes: new FolderSizes(root) }))(deps.ctx.configSource ? dirname(deps.ctx.configSource) : dirname(deps.ctx.config.daemon.dataDir)));

  control.get("/system", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const memory = readMemoryUse();
    const { root } = at();
    return c.json({
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.ctx.startedAt) / 1000),
      cores: (deps.ctx.machine ?? readMachine()).cores,
      memory: {
        // Counted as what is in use is counted, without the file pages a kernel drops and reads again.
        daemonBytes: processHeldBytes(),
        commands: commandsMemory(),
        usedBytes: memory.usedBytes,
        totalBytes: memory.totalBytes > 0 ? memory.totalBytes : null,
        limited: memory.limited,
        machineBytes: memory.machineBytes > 0 ? memory.machineBytes : null,
      },
      disk: diskSpace(root),
      folder: root,
    } satisfies SystemOverview);
  });

  control.get("/system/folder-sizes", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json(ADMINS_ONLY, 403);
    const { root, sizes } = at();
    const read = sizes.read();
    // By name only what Files lists: what is left out there is in the total and nowhere else.
    const listed = listFolder(root, "", Number.MAX_SAFE_INTEGER);
    const kinds = new Map(listed.ok ? listed.entries.map((entry) => [entry.name, entry.kind]) : []);
    return c.json({ ...read, entries: read.entries.flatMap((entry) => (kinds.has(entry.name) ? [{ ...entry, kind: kinds.get(entry.name)! }] : [])) } satisfies SystemFolderSizes);
  });

  registerSystemFileRoutes(control, deps, () => at().root);
}
