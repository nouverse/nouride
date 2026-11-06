/**
 * Baileys' optional peers, kept out of every build — and how to see that they were.
 *
 * Baileys reaches for these with `import('sharp').catch(() => {})` and degrades quietly when they are absent: a send
 * loses its thumbnail and nothing else. Compiled in, `sharp` is the problem, because it is a native module: what lands
 * in the artefact is its *loader*, which then looks for a `.node` file that is not there. Its 0.33 loader fails
 * catchably; the static `require("@img/sharp-<platform>/sharp.node")` lines of 0.35 are ones the bundler embeds, and
 * Bun answers those by reaching for a temp directory it has not been given — fatal, not catchable:
 *
 *   error: Unexpected accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL
 *
 * Seen live in the standalone bridge, the first time anything was sent to WhatsApp as an image. The bridge runs inside
 * the daemon now, so that exit would be the daemon's.
 *
 * Every build marks these `--external` (`bundleFlags` in `build/core.ts`) — until 0.7.10 only the standalone bridge's
 * did, and every daemon carried sharp 0.33.5's loader, the version linked beside Baileys because the site depended on
 * it. Left external, the import does not resolve, a compiled binary reports that as a plain `ResolveMessage`, and
 * Baileys' `.catch()` handles it. To have thumbnails, `sharp` would have to be installed *for the target platform*
 * beside the executable.
 *
 * Its own module so a test can read it without importing a build script that runs a build on import.
 */
export const BRIDGE_EXTERNALS = ["sharp", "jimp", "audio-decode", "link-preview-js"] as const;

/**
 * Strings sharp's loader carries in every version, which nothing of this project's says: an artefact containing one
 * has a native loader in it, and `assertAbsent` fails the build that made it.
 */
export const NATIVE_LOADER_MARKERS = ["@img/sharp", "sharp.node"] as const;
