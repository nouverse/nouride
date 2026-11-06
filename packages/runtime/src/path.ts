/**
 * Path adapter (TD-001).
 *
 * Thin on purpose: `node:path` is pure string computation and every runtime worth targeting ships
 * it, so these are re-exports rather than reimplementations. What matters is not that the *code*
 * changes when the runtime does — it is that there is exactly one file to look at when it might.
 *
 * The rule this serves is the one `scripts/check-arch.ts` enforces: outside `packages/runtime`,
 * nothing imports a runtime module. `Bun.*` was already covered; `node:*` was the half that leaked
 * everywhere, so "which of these thirty files would a port have to touch" had no answer short of a
 * grep — which is the state the adapter boundary exists to prevent.
 */

export {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether a `relative()` result leaves the directory it was taken from.
 *
 * `rel.startsWith("..")` was the test, in three places, and it reads a file or directory *named* `..x` — inside —
 * as outside: a credentials directory called `..creds` in a root the agent can read was not refused, and a
 * workspace file `..notes.md` was. Leaving is `..` itself or `..` followed by a separator, or an absolute path
 * (another drive, on Windows).
 */
export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * The directory a module lives in, from its own `import.meta.url`.
 *
 * `import.meta.dir` would do it in Bun and nothing else. Taking the URL as an argument keeps this
 * usable from any module without the caller reaching for a runtime global.
 */
export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
