#!/usr/bin/env bun
/**
 * Build the standalone `nouride` executable — the public editions.
 *
 * `basic` and `router`, and nothing else. The third, `pro`, is built by
 * `internals/pro/build-pro/build.ts`, a private submodule, because which plugins it links and which
 * markers prove it is commercial information about a product that is not published. Both entry
 * points import the same `scripts/build/core.ts`, so there is one build and two lists.
 *
 * Usage:
 *   bun run build:binary                          # this machine, → dist/nouride
 *   bun run build:binary --router                 # + the LLM gateway in this process
 *   bun run build:binary --target linux-x64       # cross-compiled, → dist/nouride-linux-x64/
 *   bun run build:binary --target linux-x64,linux-arm64
 *   bun run build:binary --target all
 *
 * Cross-compiling works from any host: Bun downloads and caches the target runtime on first use, so
 * the first foreign target is slow and the rest are not.
 */

import { runBuild } from "./build/core.ts";
import { PUBLIC_EDITIONS } from "./build/editions.ts";

await runBuild(PUBLIC_EDITIONS);
