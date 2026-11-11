/**
 * The cat's poses: each means one thing, and a view has one cat. The table is `POSES` in `Mascot.tsx`; a pose
 * in it is drawn by some page, or it goes back to wait in `docs/design/mascot` with the rest of the set. The pages below
 * are the ones whose cat was the wrong one — asleep over a list nobody had made yet, over a filter that matched
 * nothing — and the ones that have a cat where an icon was.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const SRC = join(import.meta.dir, "..", "src");
const BRAND = join(SRC, "..", "..", "..", "packages", "shared", "assets");
const MASCOT = readFileSync(join(SRC, "commons/components/brand/Mascot.tsx"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The table: each pose's name with the picture it imports. */
const poses = [...MASCOT.matchAll(/^ {2}(\w+): \[(\w+), "/gm)].map((row) => ({ pose: row[1]!, file: MASCOT.match(new RegExp(`import ${row[2]} from "@brand/([^"?]+)`))?.[1] }));
/** How many of the cat's pictures a page drew. */
const cats = (html: string) => html.split("/mascot/").length - 1;
const ok = (body: unknown) => ({ status: 200, body });

describe("the table of poses", () => {
  test("is read: every pose with its picture, which is there", () => {
    expect(poses.length).toBeGreaterThan(30);
    expect(poses.filter((row) => !row.file || !existsSync(join(BRAND, row.file)))).toEqual([]);
    expect(new Set(poses.map((row) => row.file)).size).toBe(poses.length);
  });

  test("holds no pose that no page draws", () => {
    const drawn = sources(SRC)
      .filter((path) => !path.endsWith("brand/Mascot.tsx"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    // By name in a string: `pose="lost"`, `{ pose: "coffee" }`, a list of poses a page picks from.
    expect(poses.map((row) => row.pose).filter((pose) => !new RegExp(`"${pose}"`).test(drawn))).toEqual([]);
  });
});

describe("the cat a page draws", () => {
  test("no agents yet: standing by its scooter, ready, not asleep", async () => {
    answer({ "/status": ok({ ...(WIRE["/status"] as object), agents: [], orchestrator: null }) });
    const html = await renderPage("/agents", async (host) => {
      await eventually(() => host.textContent?.includes("No agents yet") === true, 3_000, "the empty list");
    });
    expect(html).toContain("03-scooter-lean");
    expect(html).not.toContain("06-sleeping");
  });

  test("Automations with no webhooks yet: throwing a paper plane, not asleep", async () => {
    answer({ "/automations": ok({ automations: [], timezone: "UTC" }) });
    const html = await renderPage("/webhooks", async (host) => {
      await eventually(() => host.textContent?.includes("No webhooks yet") === true, 3_000, "the empty list");
    });
    expect(html).toContain("06-sent");
    expect(html).not.toContain("06-sleeping");
    expect(cats(html.slice(html.indexOf("<main")))).toBe(1);
  });

  test("Connectors: the delivery over an empty list, and beside the title once there is one; never both", async () => {
    answer({ "/mcp/library": ok({ servers: [] }) });
    const empty = await renderPage("/mcp", async (host) => {
      await eventually(() => host.textContent?.includes("No connectors yet") === true, 3_000, "the empty list");
    });
    const emptyMain = empty.slice(empty.indexOf("<main"));
    expect(emptyMain).toContain("08-delivery");
    expect(cats(emptyMain)).toBe(1);
    expect(emptyMain.slice(emptyMain.indexOf("<header"), emptyMain.indexOf("</header>"))).not.toContain("/mascot/");

    answer({});
    const listed = await renderPage("/mcp", async (host) => {
      await eventually(() => host.querySelector("header img") !== null, 3_000, "the title's cat");
    });
    const main = listed.slice(listed.indexOf("<main"));
    expect(main).not.toContain("No connectors yet");
    expect(cats(main)).toBe(1);
    expect(main.slice(main.indexOf("<header"), main.indexOf("</header>"))).toContain("08-delivery");
  });

  test("Secrets with secrets in it: the shield beside the title, hidden on a phone", async () => {
    const html = await renderPage("/secrets", async (host) => {
      await eventually(() => host.querySelector("header img") !== null, 3_000, "the title's cat");
    });
    const header = html.slice(html.indexOf("<header", html.indexOf("<main")));
    expect(header.slice(0, header.indexOf("</header>"))).toMatch(/<img[^>]*max-sm:hidden[^>]*05-security/);
  });

  test("a mission: at its laptop while it works, the trophy with its result once done, pushing its scooter when it ended short", async () => {
    const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
    const page = async (mission: Record<string, unknown>, until: string) => {
      answer({ "/missions/msn_1": ok({ ...shown, mission: { ...shown.mission, ...mission } }) });
      const html = await renderPage("/missions/msn_1", async (host) => {
        await eventually(() => host.textContent?.includes(until) === true, 3_000, until);
      });
      return html.slice(html.indexOf("<main"));
    };
    const working = await page({}, "Now");
    expect(working).toContain("05-laptop");
    expect(cats(working)).toBe(1);

    const done = await page({ status: "done", seen: "done", report: "Sent it." }, "What it handed back.");
    expect(done).toContain("10-trophy");
    expect(done).not.toContain("05-laptop");
    expect(cats(done)).toBe(1);

    const ended = await page({ status: "failed", seen: "ended", reason: "The model stopped answering." }, "Why it ended");
    expect(ended).toContain("12-pushing");
    expect(ended).not.toContain("10-trophy");
    expect(cats(ended)).toBe(1);
  });
});
