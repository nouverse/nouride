/**
 * The one place this daemon's version comes from.
 *
 * Read from `apps/engine/package.json` rather than written here, because it was
 * written here — and in `src/index.ts`, and in `modules/web/health.ts`, and in
 * two manifests. Five copies of one fact, and a release bumped two of them: the
 * `0.1.1` image shipped code that reported itself as `0.1.0` to `/health` and to
 * `nouride --version`, which is exactly what an operator reads to find out what
 * is deployed.
 *
 * The import survives `bun build --compile` — the bundler inlines the JSON, so
 * a standalone binary with no source tree beside it still knows. Verified by
 * compiling one and running it.
 *
 * `version.test.ts` fails if a hardcoded copy reappears anywhere.
 */

import pkg from "../../package.json";

export const VERSION: string = (pkg as { version: string }).version;
