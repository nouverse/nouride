/**
 * The public mirror's first page: every updater before 0.8.18 reads thirty releases, newest by
 * date, and finds a stepping stone only there. Each release's floor needs a stone at or above it, below the release,
 * within the first twenty-five; the release audit and `publish.ts` stop a release that would push one off.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { floorOf, readPage, strandedFloors, type MirrorEntry } from "../../../../scripts/release/mirror-page.ts";

const entry = (tag: string, floor: string | null = null, prerelease = false): MirrorEntry => ({ tag, floor, prerelease });
/** The mirror as it stood on 2026-11-04, with 0.8.17 on top. */
const TODAY = [entry("v0.8.17", "0.8.0"), entry("v0.8.16", "0.8.0"), entry("v0.8.0", "0.7.28"), entry("v0.7.29"), entry("v0.6.7"), entry("v0.5.14"), entry("v0.4.8")];
/** `count` intermediate releases on top, each with the 0.8 floor. */
const newer = (count: number) => Array.from({ length: count }, (_, i) => entry(`v0.8.${100 + count - i}`, "0.8.0"));

describe("the mirror's first page", () => {
  test("as it stands, every floor has its stone", () => {
    expect(strandedFloors(TODAY)).toEqual([]);
  });

  test("a stone pushed past the twenty-fifth strands the installs below its floor", () => {
    // 0.7.29, 0.8.0's stone, at the 25th place (index 24): still in.
    expect(strandedFloors([...newer(21), ...TODAY])).toEqual([]);
    // One more release and it is the 26th.
    expect(strandedFloors([...newer(22), ...TODAY])).toEqual([
      "v0.8.0 upgrades only from 0.7.28, and no release from 0.7.28 up to it stands in the first 25 of the mirror's page: an install below 0.7.28 has no way there",
    ]);
  });

  test("a bridge deleted from the mirror is named", () => {
    const without = TODAY.filter((release) => release.tag !== "v0.7.29");
    expect(strandedFloors(without)).toHaveLength(1);
    expect(strandedFloors(without)[0]).toStartWith("v0.8.0 upgrades only from 0.7.28");
  });

  test("a pre-release takes a place but is no stone: the updaters skip it", () => {
    const quiet = TODAY.map((release) => (release.tag === "v0.7.29" ? { ...release, prerelease: true } : release));
    expect(strandedFloors(quiet)).toHaveLength(1);
  });

  test("a release's floor is read from its notes in this repository", () => {
    expect(floorOf("v0.8.17")).toBe("0.8.0");
    expect(floorOf("v0.8.0")).toBe("0.7.28");
    expect(floorOf("v0.4.8")).toBeNull();
  });
});

describe("reading the page", () => {
  const page = [{ tag_name: "v0.8.36" }, { tag_name: "v0.8.0", prerelease: false }];
  /** Answers in turn, and what each ask carried. */
  const answers = (...statuses: number[]) => {
    const asked: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      asked.push(init.headers as Record<string, string>);
      const status = statuses[asked.length - 1] ?? 200;
      return status === 200 ? Response.json(page) : new Response("{}", { status, headers: status === 403 ? { "retry-after": "2" } : {} });
    }) as unknown as typeof fetch;
    return { fetchImpl, asked };
  };

  test("with the workflow's token, as a bearer; with none, no authorization at all", async () => {
    const withToken = answers();
    expect(await readPage({ token: "t0k", fetchImpl: withToken.fetchImpl })).toEqual({ ok: true, listed: page });
    expect(withToken.asked[0]?.authorization).toBe("Bearer t0k");
    const without = answers();
    await readPage({ fetchImpl: without.fetchImpl });
    expect(without.asked[0]).not.toHaveProperty("authorization");
  });

  test("a refusal for asking too often is asked again after the wait it names; the page that follows is read (v0.8.36 stopped on one)", async () => {
    const waited: number[] = [];
    const twice = answers(403, 429);
    expect(await readPage({ fetchImpl: twice.fetchImpl, sleep: async (ms) => void waited.push(ms) })).toEqual({ ok: true, listed: page });
    expect(twice.asked).toHaveLength(3);
    expect(waited).toEqual([2_000, 10_000]);
  });

  test("three refusals stop it, naming the status; any other refusal stops it at once", async () => {
    const always = answers(403, 403, 403);
    expect(await readPage({ fetchImpl: always.fetchImpl, sleep: async () => {} })).toEqual({ ok: false, status: 403 });
    expect(always.asked).toHaveLength(3);
    const gone = answers(404);
    expect(await readPage({ fetchImpl: gone.fetchImpl, sleep: async () => {} })).toEqual({ ok: false, status: 404 });
    expect(gone.asked).toHaveLength(1);
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../../.github/workflows/release.yml"), "utf8");

  test("checks the page with the release on top, before anything is published", () => {
    const check = workflow.indexOf('bun run scripts/release/mirror-page.ts --adding "${GITHUB_REF_NAME}"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("- name: Initialize releases if tagged"));
    // Read with the run's token: with none, the hosted runner's shared address ran out of asks.
    const step = workflow.slice(workflow.indexOf("- name: The mirror's first page keeps every stepping stone"), check);
    expect(step).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  test("stops when the update gate cannot be told, instead of going green with no box offered the release (REVIEW B1)", () => {
    expect(workflow).toContain('error "NOUVERSE_RELEASE_TOKEN is not set, so the signed Pro editions cannot be published for boxes.');
    expect(workflow).not.toContain("::warning::NOUVERSE_RELEASE_TOKEN is not set");
  });
});

