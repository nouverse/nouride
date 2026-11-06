#!/usr/bin/env bun
/**
 * `tsc --noEmit` over every project in the workspace, as many at a time as the machine can take.
 *
 * Every project is every `tsconfig.json` under `apps/`, `packages/` and `scripts/`, and under the Pro tree when it
 * is checked out, less the ones `NOT_FOR_TSC` names with a reason (`lint-sources.ts`). It was a `&&` chain of two
 * once — `apps/engine` and `apps/dashboard` — and package *tests* were checked by nothing: twelve real type errors sat
 * in them, a fixture missing a required field, a test reaching past `protected`, a DOM name that is not in
 * `lib: ["ESNext"]`. Then it was a hand-kept list of fifteen, and the same happened to what the list left out: the
 * dashboard's tests, the WhatsApp bridge's tests and the root scripts held sixteen more. `bun test` does not
 * typecheck, so all of it passed. Found rather than listed, a project nobody thought to add is checked anyway.
 *
 * ## Why this is a pool and not `Promise.all`
 *
 * It *was* `Promise.all`, which spawned every project at once — twelve, then. On a developer laptop that is the right
 * answer and takes four seconds. On the 2-core / 2 GB LXC this daemon is built to run on, it takes
 * the whole container down — and it did, repeatedly, whenever an agent was asked to check the
 * codebase.
 *
 * The numbers, measured rather than assumed: one `tsc` on `apps/engine` peaks at **694 MB**, and one
 * on a small package at **246 MB**. Twelve at once is three to four gigabytes against two, with the
 * daemon, six agents and nine gateway connections living in the same container. `bun test` over the
 * whole suite, by contrast, peaks at 556 MB and finishes in 28 seconds *on that box* — it was never
 * the problem, and the tests were being blamed for something the typechecker did.
 *
 * So the width of the pool is derived from the machine instead of from the project count. A laptop
 * runs as many as its cores and memory allow; the LXC runs two and survives. `NOURIDE_TYPECHECK_JOBS` overrides it for anyone

 * who knows better than the arithmetic.
 *
 * This file is itself tooling, so it is exempt from the Bun and Node rules the engine follows.
 */

import { cpus, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateRouteTree } from "../apps/dashboard/scripts/routes.ts";
import { NOT_FOR_TSC, proProjects, publicProjects } from "./lint-sources.ts";
import { installsInTsc, notInstalled } from "./uninstalled.ts";

/** Repo root — this script lives in `scripts/`. */
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * The dashboard's route tree, `src/routeTree.gen.ts`, is generated and gitignored — the pages and their tests import it.
 * A fresh clone has none, and this used to skip both dashboard projects there with a warning, so lint:types in a new
 * worktree checked neither. It is written here first, from `src/routes`, the way the build writes it.
 */
await generateRouteTree();

/**
 * The Pro code's projects, when the private submodule is checked out — see `proProjects`. The Box editions are built
 * from it, and nothing typechecked it: `tsc -p apps/engine` reads the engine's own declarations of the plugins, not
 * the plugins, and the 2026-10-16 audit found three errors sitting in it.
 */
const PRO = proProjects(ROOT);

/**
 * Biggest first. The pool hands out work in order, so starting the long pole early is the difference between finishing
 * with one straggler and finishing with eleven idle slots. The rest follow in path order.
 */
const LONG_POLES = ["apps/engine", "apps/dashboard/tests", "apps/dashboard"];

function rank(project: string): number {
  const at = LONG_POLES.indexOf(project);
  return at === -1 ? LONG_POLES.length : at;
}

const PROJECTS = [...publicProjects(ROOT).filter((project) => !(project in NOT_FOR_TSC)), ...PRO.projects].sort(
  (a, b) => rank(a) - rank(b) || a.localeCompare(b),
);

/** Measured peak for the heaviest project, rounded up. The budget one slot must be able to cover. */
const MB_PER_JOB = 700;

/**
 * What this machine will actually lend us, in MB.
 *
 * `MemAvailable` on Linux, because that is the number that means "can be used without swapping" —
 * `free` alone reads as catastrophic on any box with a warm page cache. Everywhere else, half of
 * total: macOS `freemem()` excludes purgeable memory and reads far lower than the truth, so it would
 * throttle a 64 GB laptop to one job.
 */
function availableMb(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
    if (match) return Number(match[1]) / 1024;
  } catch {
    // Not Linux, or /proc is not mounted. Fall through.
  }
  return totalmem() / 1024 / 1024 / 2;
}

function jobLimit(): number {
  const override = Number(process.env.NOURIDE_TYPECHECK_JOBS);
  if (Number.isInteger(override) && override > 0) return Math.min(override, PROJECTS.length);

  const byCpu = Math.max(1, cpus().length);
  const byMemory = Math.max(1, Math.floor(availableMb() / MB_PER_JOB));
  return Math.max(1, Math.min(byCpu, byMemory, PROJECTS.length));
}

interface Result {
  project: string;
  code: number;
  output: string;
}

async function typecheck(project: string): Promise<Result> {
  // From the root, so the paths in its output are relative to it — `installsInTsc` reads them.
  const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "--skipLibCheck", "-p", project], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { project, code, output: `${out}${err}`.trim() };
}

/**
 * A fixed number of workers pulling from one queue.
 *
 * Not a chunked `Promise.all` over slices of the list: a slice finishes at the speed of its slowest
 * member, so `apps/engine` in one chunk would leave the rest of that chunk's slots idle for seconds.
 * Workers taking the next item keep every slot busy until there is nothing left.
 */
async function run(limit: number): Promise<Result[]> {
  const queue = [...PROJECTS];
  const results: Result[] = [];

  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        results.push(await typecheck(next));
      }
    }),
  );

  return results;
}

const limit = jobLimit();
for (const [dir, why] of Object.entries(NOT_FOR_TSC)) console.log(`- ${dir}: not checked here — ${why}`);
for (const dir of PRO.uncovered) console.log(`- ${dir}: no tsconfig.json, so its types are not checked`);
const results = await run(limit);
const failed = results.filter((result) => result.code !== 0);

for (const result of failed) {
  console.error(`\n✗ ${result.project}`);
  console.error(result.output);
}

/**
 * The installs those failures are waiting for, said once each, last — where it is read. A project with lockfiles of its
 * own (`internals/pro`, Nougate's apps) is not installed by the root `bun install`, and in a fresh clone its TS2307s
 * were all this said, with nothing about why.
 */
const missing = new Map<string, Set<string>>();
for (const result of failed) {
  for (const [dir, packages] of installsInTsc(result.output, ROOT)) missing.set(dir, new Set([...(missing.get(dir) ?? []), ...packages]));
}
for (const [dir, packages] of missing) console.error(`\n✗ ${notInstalled(dir, [...packages].sort(), "typechecked")}`);

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} projects failed typecheck`);
  process.exit(1);
}

// The width is printed because it is the thing somebody will want to know when this is slow, and
// because a machine silently running one at a time should say so rather than just feeling broken.
console.log(`✓ types check out (${results.length} projects, ${limit} at a time)`);
