/**
 * The dashboard is where the daemon looks for it — in every layout, including the container.
 *
 * This is a regression test for a bug that shipped and stayed shipped: every Docker deployment of
 * Nouride answered `/dashboard/` with a 503, the managed cloud pods included, while the built SPA
 * sat in the image the whole time. Nothing caught it because the two halves live in different files
 * and neither mentions the other — the Dockerfile decides where the assets go, `web/server.ts`
 * decides where to look, and they simply disagreed.
 *
 * So this test reads both and checks they still agree. It is the same shape as the skills-mirror
 * check: two places that must match, with a test that says so rather than a convention that hopes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("the Dockerfile and the resolver agree", () => {
  test("the image copies the dashboard to a path the daemon looks in", () => {
    const dockerfile = source("Dockerfile");
    const server = source("apps/engine/src/modules/web/server.ts");

    /**
     * `COPY --from=dashboard-builder /app/apps/dashboard/dist ./apps/dashboard/dist`
     *
     * The destination is what matters: it is relative to `WORKDIR /app`, and the bundle sits at
     * `/app/nouride.bundle.js`, so `moduleDir` of the running artifact is `/app`.
     */
    const copy = /COPY --from=dashboard-builder \S+ \.\/(\S+)/.exec(dockerfile);
    expect(copy).not.toBeNull();
    const destination = copy![1]!.replace(/\/$/, "");
    expect(destination).toBe("apps/dashboard/dist");

    // And the resolver has a candidate anchored at the bundle's own directory with that suffix.
    expect(server).toContain(`join(moduleDir(import.meta.url), "${destination}")`);
  });

  test("the bundle really does sit beside that directory", () => {
    // The anchor only works because `WORKDIR` and the bundle's destination are the same place. If
    // the bundle moved to, say, `/app/bin/`, the candidate above would point at `/app/bin/apps/…`.
    const dockerfile = source("Dockerfile");
    expect(dockerfile).toMatch(/WORKDIR \/app[\s\S]*COPY --from=engine-builder \S+ \.\/nouride\.bundle\.js/);
  });

  test("all three layouts are still covered", () => {
    /**
     * Named individually because each one is a deployment somebody has: a checkout, a tarball
     * install, and a container. Losing any of them is a 503 for that whole population.
     */
    const server = source("apps/engine/src/modules/web/server.ts");
    expect(server).toContain('"../../../../dashboard/dist"'); // checkout
    expect(server).toContain("dirname(process.execPath)"); // tarball, beside the binary
    expect(server).toContain('"apps/dashboard/dist"'); // container
  });

  test("finding nothing is logged rather than left to a 503 somebody has to ask for", () => {
    // The container bug lived as long as it did because `/health` was green and the log was clean.
    const server = source("apps/engine/src/modules/web/server.ts");
    expect(server).toMatch(/log\.warn\("no dashboard assets found/);
    expect(server).toContain("looked_in: DASHBOARD_CANDIDATES");
  });
});
