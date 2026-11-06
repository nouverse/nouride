/**
 * The plugins every edition links, resolved once at start.
 *
 * Every edition links `packages/update` and `packages/system-packages`, so a failure here is a broken
 * build rather than a mode — `build:binary` asserts both markers to stop one being made. Still
 * resolved dynamically and still caught: a daemon that cannot check for updates, or reach the package
 * service, should carry on serving chat. Resolved before the first prompt, which reads the second
 * without waiting (the install ladder).
 */

import type { GlobalConfig } from "@nouride/shared";
import { resolveSystemPackages } from "@/modules/system-packages/index.ts";
import { followUpdateTrack, resolveUpdateProvider } from "@/modules/update/index.ts";

export async function resolveLinkedPlugins(config: GlobalConfig): Promise<void> {
  await resolveUpdateProvider();
  // Read at each check from the running config, which a save changes in place (`config/follow.ts`).
  followUpdateTrack(() => config.update.track);
  await resolveSystemPackages();
}
