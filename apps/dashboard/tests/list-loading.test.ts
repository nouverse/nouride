/**
 * A list that is loading is drawn as its shape — rows, or cards side by side — where a spinner stood: the page does not
 * jump when the list comes, and the shape says what is coming. It pulses as one, in opacity, which the reduced-motion
 * rule stops (`reduced-motion.test.ts`). A spinner is left for what is not a list: one thing being done in a button, a
 * page or a file on its way.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const SRC = join(import.meta.dir, "..", "src");

/** Where a large spinner still stands, and why it is not a list's. */
const NOT_A_LIST: Record<string, string> = {
  "commons/components/layout/RootLayout.tsx": "the whole dashboard, while it learns who is signed in",
  "commons/components/ui/MarkdownPreview.tsx": "a file being read",
  "commons/components/ui/NotesModal.tsx": "a file being read",
  "modules/agents/cli.page.tsx": "an agent's coding CLI, one thing",
  "modules/agents/components/DaemonConfigEditor.tsx": "a file being read",
  "modules/agents/components/FileEditor.tsx": "a file being read",
  "modules/agents/layout.page.tsx": "an agent's page",
  "modules/agents/look.page.tsx": "an agent's look, one thing",
  "modules/jobs/job.page.tsx": "a job's page",
  "modules/llm-gateway/index.page.tsx": "the gateway's own dashboard, in a frame",
  "modules/memories/knowledge/document.dialog.tsx": "a document being read",
  "modules/missions/mission.page.tsx": "a mission's page",
  "modules/box/components/QrTile.tsx": "a QR code being drawn",
  "modules/update/index.page.tsx": "the check for an update",
  "commons/components/layout/Reconnecting.tsx": "the daemon coming back",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

describe("a list that is loading", () => {
  test("is drawn as its shape: no large spinner is left but where no list is coming", () => {
    const spinning = files(SRC)
      .filter((path) => /loading-spinner loading-(md|lg)|<Loader2 size=\{(18|20|28)\}/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(spinning.length).toBeGreaterThan(0);
    expect(spinning.filter((path) => !(path in NOT_A_LIST))).toEqual([]);
  });

  test("on Missions is cards side by side, as the missions will be, and no spinner", async () => {
    answer({ "/missions": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("loading-spinner loading-lg");
  });

  test("pulses inside its frame, which a page's section fades in: one element takes one animation", async () => {
    answer({ "/people": { status: 200, body: {}, hold: true } });
    let seen = { frame: [] as string[], inside: [] as string[], fades: false };
    await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
      const frame = host.querySelector('[aria-busy="true"]')!;
      seen = {
        frame: (frame.getAttribute("class") ?? "").split(/\s+/),
        inside: (frame.firstElementChild?.getAttribute("class") ?? "").split(/\s+/),
        fades: (frame.parentElement?.getAttribute("class") ?? "").split(/\s+/).includes("*:animate-fade"),
      };
    });
    expect(seen.fades).toBe(true);
    expect(seen.frame.filter((word) => word.startsWith("animate-"))).toEqual([]);
    expect(seen.inside).toContain("animate-pulse");
  });

  test("on People is rows, and the list takes their place once it comes", async () => {
    answer({ "/people": { status: 200, body: {}, hold: true } });
    const loading = await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(loading).toContain("animate-pulse");
    expect(loading).not.toContain("loading-spinner loading-lg");
    answer({});
    const loaded = await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') === null, 4_000, "the list");
    });
    expect(loaded).not.toContain('aria-busy="true"');
  });

  test("in System Logs is rows, where the daemon's lines will be", async () => {
    answer({ "/logs/stored": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/logs", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("animate-spin text-primary/60");
  });
});
