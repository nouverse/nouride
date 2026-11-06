/**
 * Every page in the dashboard, loaded.
 *
 * There has never been a test that so much as imported one. Four test files, all pure functions —
 * so the failure mode that keeps happening was structurally invisible: on 2026-09-06 clicking
 * **Chat** threw `Cannot read properties of undefined (reading 'length')` because a `useQuery` and
 * an `useInfiniteQuery` shared the key `["sessions", ""]`, and whichever mounted first filled the
 * cache with the wrong shape. Nothing in CI could have seen it.
 *
 * This does not render anything, and it is not pretending to be a browser. What it checks is the
 * layer under rendering, which is where the cheap breakages live:
 *
 * - **Every route file declares the route its filename promises.** TanStack's file routes are
 *   matched by convention, so a file whose `createFileRoute` path disagrees with its name is a
 *   route that silently never matches.
 * - **Every route has a page.** A route file that renders nothing is a blank screen with no error.
 *
 * That every page module imports is `mount.test.ts`'s: it regenerates the route tree from `src/routes` and
 * mounts it, which imports every route file, so a module that cannot load fails every test there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(dirname(import.meta.path), "..");
const ROUTES = join(ROOT, "src", "routes");

/**
 * `agents.$agentId.model.tsx` → `/agents/$agentId/model`, which is what TanStack derives too.
 *
 * An `index` file keeps a trailing slash — `agents.index.tsx` is `/agents/`, not `/agents`, and the
 * distinction is TanStack's: the second is the layout route in `agents.tsx`. Dropping it made this
 * test report the two index routes as wrong, which is the test being wrong about the convention.
 */
function pathFromFilename(file: string): string {
  const base = file.replace(/\.tsx$/, "");
  if (base === "index") return "/";
  const segments = base.split(".");
  const isIndex = segments.at(-1) === "index";
  const path = segments.filter((segment) => segment !== "index").join("/");
  return isIndex ? `/${path}/` : `/${path}`;
}

const files = readdirSync(ROUTES)
  .filter((name) => name.endsWith(".tsx") && name !== "__root.tsx")
  .sort();

describe("the route files", () => {
  test("there are some, so the rest of this means something", () => {
    // The fail-open shape: a directory that stopped being read would make every `for` below pass.
    expect(files.length).toBeGreaterThan(20);
  });

  test("each declares the path its filename promises", () => {
    const wrong: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(ROUTES, file), "utf8");
      const declared = /createFileRoute\(\s*["'`]([^"'`]+)["'`]\s*\)/.exec(source)?.[1];
      const expected = pathFromFilename(file);

      // A layout route (`agents.tsx` beside `agents.index.tsx`) declares its own path, so the
      // comparison is the same one either way — what matters is that it is not something else.
      if (declared !== expected) wrong.push(`${file}: declares ${declared ?? "nothing"}, filename says ${expected}`);
    }

    expect(wrong).toEqual([]);
  });

  test("each renders something", () => {
    // A route with no component is a blank screen and no error in the console — the hardest kind of
    // breakage to notice, because nothing anywhere says anything.
    const empty = files.filter((file) => {
      const source = readFileSync(join(ROUTES, file), "utf8");
      return !/component\s*:/.test(source) && !/loader\s*:/.test(source) && !/beforeLoad\s*:/.test(source);
    });

    expect(empty).toEqual([]);
  });
});

describe("every route has a way in", () => {
  /**
   * A route nothing links to is a page that ships to everybody and is opened by nobody — `/demo-icons`, a brand
   * showcase from August, sat in every bundle for two months: lint:deadcode exempts `src/routes/`, and a route file
   * imports its page, so neither looked dead.
   *
   * A way in is a path written somewhere in `src` outside the route files: the sidebar's `to`, a `<Link to>`, a
   * `navigate({ to })`, or a redirect the session gate returns. A layout route is reached through its children.
   */
  const SRC = join(ROOT, "src");
  /** The URL a route answers: an index's trailing slash and TanStack's `_` (not nested under its parent) dropped. */
  const urlOf = (path: string) => (path.length > 1 ? path.replace(/\/$/, "") : path).replace(/_(?=\/|$)/g, "");

  function sourcesOutsideRoutes(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return path === ROUTES ? [] : sourcesOutsideRoutes(path);
      return /\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".gen.ts") ? [readFileSync(path, "utf8")] : [];
    });
  }

  test("each route is linked, navigated to or redirected to from somewhere", () => {
    const written = new Set(sourcesOutsideRoutes(SRC).flatMap((source) => [...source.matchAll(/["'`](\/[A-Za-z0-9_$\-/.]*)["'`]/g)].map((m) => m[1]!)));
    const urls = files.map((file) => urlOf(pathFromFilename(file)));
    const linked = (url: string) => written.has(url);
    // A layout route has no page of its own to link to: it is reached when one of its children is.
    const reached = (url: string) => linked(url) || urls.some((other) => other.startsWith(`${url}/`) && linked(other));

    const stranded = files.filter((file) => !reached(urlOf(pathFromFilename(file))));
    expect(stranded).toEqual([]);
  });
});
