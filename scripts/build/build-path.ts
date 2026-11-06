/**
 * No path from the machine that built it.
 *
 * Bun writes a CommonJS module's `__dirname` into the bundle as that module's absolute directory, and three of the
 * daemon's dependencies read it — `@discordjs/ws`, `pino` and `thread-stream`, each to find a worker script. So every
 * binary and image bundle carried the checkout it was built in (`/Users/<name>/…/node_modules/.bun/…`, or the CI
 * runner's), named where it was built, and reproduced only from that directory: two builds of one tree in two places
 * differed by 276 bytes, and a private map made in one was off by that much for the other.
 *
 * Both names are defined instead, for all the code in a bundle, to the directory every module of a compiled binary is
 * in — `import.meta.dir` there. Nothing on a path the daemon takes reads them: the three look for worker scripts for
 * pino's transports and discord's worker sharding, which this daemon never starts, and a path on the build machine
 * named nothing where the daemon runs anyway. The engine's own code reads neither: it counts from `import.meta.url`
 * (`moduleDir`), which stays a runtime expression. The image's bundle gets the same value, since it is built with the
 * same flags; it names nothing there either, which is the point.
 *
 * `checkoutPathsIn` is the check behind it: the build fails an artefact that still names its checkout, whatever wrote
 * the path in (`assertAbsent` in `core.ts`).
 */

/** Where every module of a compiled binary is, as Bun says it: the binary's own virtual root. */
export const BUNDLED_DIR = "/$bunfs/root";

/** The `--define`s that put `BUNDLED_DIR` where Bun would write a module's own directory and file — for `bundleFlags`. */
export function noBuildPathFlags(): string[] {
  return [
    "--define",
    `__dirname=${JSON.stringify(BUNDLED_DIR)}`,
    "--define",
    `__filename=${JSON.stringify(`${BUNDLED_DIR}/nouride`)}`,
  ];
}

/**
 * The checkout's top-level directories a path out of it runs through. Not the root alone: the image is built at `/app`,
 * which is also where it runs, and the bundle names `/app/data` on purpose (the gateway's state before 0.5.13).
 */
const TREE = ["node_modules", "apps", "packages", "internals", "scripts", "content"];

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every path in `text` into one of `roots` — the checkout as given and as its real path, since Bun writes real paths —
 * up to a quote, a space or a NUL, at most ten. Empty for an artefact that names none.
 */
export function checkoutPathsIn(text: string, roots: readonly string[]): string[] {
  const found = new Set<string>();
  for (const root of new Set(roots.map((path) => path.replace(/\/+$/, "")).filter(Boolean))) {
    const pattern = new RegExp(`${escaped(root)}/(?:${TREE.join("|")})/[^"'\`\\s\\0]{0,160}`, "g");
    for (const match of text.matchAll(pattern)) {
      found.add(match[0]);
      if (found.size >= 10) return [...found];
    }
  }
  return [...found];
}
