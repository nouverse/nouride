/**
 * The daemon's own `config.toml`, as the settings change it: through the one checked, locked write
 * (`config/config-file.ts`), so a save the next boot would refuse is refused instead, two saves at once both land, and
 * the running daemon's config is what the loader makes of the file afterwards (`config/follow.ts`) — never what a
 * setter guessed it would be.
 */

import { editDaemonConfig, holdingConfig, type ConfigEdit, type HeldConfig } from "@/modules/config/config-file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

/** All these use. Asking for the whole deps would make the config path look load-bearing on the secret store. */
type ConfigFileDeps = Pick<SettingsDeps, "config" | "configPath">;

/**
 * Change the file with `edit`, and the running copy with it. A refusal is a `SaveResult` the caller hands straight back:
 * the file's, about no one field of a form.
 */
export async function editConfigFile(
  deps: ConfigFileDeps,
  edit: ConfigEdit,
): Promise<{ ok: true; changed: boolean } | Extract<SaveResult<never>, { ok: false }>> {
  return await editDaemonConfig(deps.configPath, deps.config, edit);
}

/** Hold the file for a writer whose checks read what it then changes — see `holdingConfig`. */
export function holdingConfigFile<T>(deps: ConfigFileDeps, fn: (file: HeldConfig) => Promise<T>): Promise<T> {
  return holdingConfig(deps.configPath, deps.config, fn);
}
