/**
 * A provider profile on a known endpoint gets what the endpoint needs written into its `config.toml`, the first time
 * this build starts on it (`modules/config/known-endpoints.ts`).
 *
 * OpenAI's own API refuses `max_tokens` for its newer models. Setup now writes `max_tokens_field` for a profile on it;
 * one written before that says nothing, so every reply and every compaction on such a model failed with a 400 until
 * somebody edited the file. Brought forward on disk, and in the running config, so the update is all it takes. The
 * same for `identify` on the two vendors' own APIs: a profile made before setup wrote it sends no cache key, and
 * its conversations' requests are not kept on the cache their prefix is in.
 *
 * Safe for the way back: the release before this one warns about a provider key it does not know and loads the file,
 * so going back to it still starts. A profile that names the key either way is left as it is, `identify = false`
 * included; one on any other endpoint is never touched. The next minor deletes this file and its call: an install reaches it through a release
 * that ran this.
 */

import { createLogger, type GlobalConfig } from "@nouride/shared";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { profilesBehind } from "@/modules/config/known-endpoints.ts";

const log = createLogger("config.providers");

/** Write what each profile on a known endpoint lacks, through the one config writer. Answers the profiles it wrote. */
export async function bringEndpointKeysForward(input: { configPath: string; config: GlobalConfig }): Promise<string[]> {
  let written: ReturnType<typeof profilesBehind> = [];
  const saved = await editDaemonConfig(input.configPath, input.config, (text) => {
    written = profilesBehind(text);
    return written.reduce((next, behind) => upsertTomlTable(next, `providers.${behind.profile}`, behind.set), text);
  });
  if (!saved.ok) {
    // The daemon starts either way; a profile on that endpoint fails as it did before, and the line says why.
    log.warn("could not write what a provider profile's endpoint needs into config.toml", { config: input.configPath, error: saved.error });
    return [];
  }
  for (const behind of written) {
    log.info("wrote what this provider profile's endpoint needs into config.toml", { profile: behind.profile, ...behind.set, why: behind.why });
  }
  return written.map((behind) => behind.profile);
}
