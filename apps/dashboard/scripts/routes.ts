/**
 * The route tree, `src/routeTree.gen.ts`, written from `src/routes` the way the Vite plugin writes it.
 *
 * The file is generated and gitignored, and the Vite plugin wrote it only during `build:dashboard`. So a fresh clone or
 * a new worktree failed every rendering test in `mount.test.ts` on an import, and lint:types skipped the dashboard; and a
 * route added or removed without a rebuild left the tests running over a tree that no longer matched `src/routes`. The
 * tests, lint:deadcode and lint:types generate it themselves now, through this, from the options the build uses.
 */

import { Generator, getConfig } from "@tanstack/router-generator";
import { fileURLToPath } from "node:url";

/** The router plugin's options — `vite.config.ts` passes these, so the tree a build writes is the one this writes. */
export const ROUTE_OPTIONS = {
  routesDirectory: "./src/routes",
  generatedRouteTree: "./src/routeTree.gen.ts",
} as const;

/** The dashboard's directory, which the options are relative to. */
const DASHBOARD = fileURLToPath(new URL("..", import.meta.url));

/** Write `src/routeTree.gen.ts` from `src/routes`. A tree that already matches is left as it is. */
export async function generateRouteTree(root: string = DASHBOARD): Promise<void> {
  const config = getConfig({ ...ROUTE_OPTIONS, disableLogging: true }, root);
  await new Generator({ config, root }).run();
}

if (import.meta.main) await generateRouteTree();
