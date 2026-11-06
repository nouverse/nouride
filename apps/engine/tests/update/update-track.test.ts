/**
 * `[update] track` (0.8.18, PLAN §3.3): the setting, the loader's refusal of a value the updater would misread, the
 * engine reading it from the running config at each check, and the dashboard's route. Which releases each track takes
 * is the update package's (`packages/update/tests/track.test.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { setUpdateTrack } from "@/modules/config/settings/update.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { resolveLinkedPlugins } from "@/boot/linked-plugins.ts";
import { checkForUpdate, followUpdateTrack, setReleaseSource } from "@/modules/update/index.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { UpdateOps } from "@/modules/web/control/routes/update.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

// The plugin is linked into a build (`scripts/build/edition.ts`), not resolved from the engine's tests: its own source,
// as the bridge's tests map theirs.
mock.module("nouride-update", () => import(join(import.meta.dir, "../../../../packages/update/src/index.ts")));

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
  setReleaseSource(null);
  followUpdateTrack(() => "latest");
});

function deps(): SettingsDeps {
  dir = mkdtempSync(join(tmpdir(), "update-track-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, "[daemon]\nname = \"t\"\n");
  return { config: structuredClone(DEFAULT_CONFIG), configPath } as unknown as SettingsDeps;
}

describe("the setting", () => {
  test("latest until set, saved to [update], and live at once", async () => {
    const d = deps();
    expect(d.config.update.track).toBe("latest");
    expect(await setUpdateTrack(d, { track: "lts" })).toMatchObject({ ok: true, restartRequired: false });
    expect(readFileSync(d.configPath, "utf8")).toContain('[update]\ntrack = "lts"');
    expect(d.config.update.track).toBe("lts");
  });

  test("a value that is not a track is refused, naming the key, and nothing is written", async () => {
    const d = deps();
    const saved = await setUpdateTrack(d, { track: "lastest" });
    expect(saved).toEqual({ ok: false, error: '[update] track must be one of "latest", "lts", got "lastest"' });
    expect(readFileSync(d.configPath, "utf8")).not.toContain("[update]");
    expect(d.config.update.track).toBe("latest");
  });
});

describe("the config file", () => {
  test("[update] track is read, and a typo stops the load naming the key: the updater would take it for lts", () => {
    expect(readConfigText('[update]\ntrack = "lts"\n', "/c/config.toml").update.track).toBe("lts");
    expect(readConfigText("", "/c/config.toml").update.track).toBe("latest");
    expect(() => readConfigText('[update]\ntrack = "lastest"\n', "/c/config.toml")).toThrow('[update] track must be one of "latest", "lts", got "lastest"');
  });
});

describe("the engine", () => {
  test("from boot, each check follows the track the running config holds at that moment", async () => {
    dir = mkdtempSync(join(tmpdir(), "update-track-"));
    const config = structuredClone(DEFAULT_CONFIG);
    await resolveLinkedPlugins(config);
    setReleaseSource({ name: "fake", releases: async () => [], tarballUrl: () => "", checksumUrl: () => "", staleness: () => null });
    expect((await checkForUpdate(dir)).track).toBe("latest");
    config.update.track = "lts";
    expect((await checkForUpdate(dir)).track).toBe("lts");
  });
});

describe("the route", () => {
  const TOKEN = "control-token-for-tests-0000000000";
  function app(saved: { track?: string }[]) {
    const config = structuredClone(DEFAULT_CONFIG);
    const ops = {
      updateSupported: () => true,
      checkForUpdate: async () => ({ current: "1.0.5", latest: config.update.track === "lts" ? "v1.0.7" : "v1.1.0", newer: true, track: config.update.track, publishedAt: null, notesUrl: null }),
    } as unknown as UpdateOps;
    const settings = {
      setUpdateTrack: async (params: { track: string }) => {
        saved.push(params);
        if (params.track !== "lts" && params.track !== "latest") return { ok: false, error: "[update] track must be one of" };
        config.update.track = params.track;
        return { ok: true, restartRequired: false };
      },
    };
    const hono = new Hono();
    mountControlRoutes(hono, { ctx: { config, startedAt: Date.now(), status: "ready", gateways: new Map(), providerErrors: new Map() }, token: TOKEN, audit: { record: () => {} }, settings, updates: ops } as unknown as ControlDeps);
    return hono;
  }
  const post = (hono: Hono, body: unknown, headers: Record<string, string> = { "x-nouride-token": TOKEN }) =>
    hono.request("/api/control/update/track", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }, { clientAddress: "203.0.113.10" });

  test("saves the track and answers with the check on it, so the page shows what it now offers", async () => {
    const saved: { track?: string }[] = [];
    const res = await post(app(saved), { track: "lts" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, track: "lts", check: { track: "lts", latest: "v1.0.7" } });
    expect(saved).toEqual([expect.objectContaining({ track: "lts" })]);
  });

  test("a value that is not a track is a 400 with the setter's words", async () => {
    const res = await post(app([]), { track: "nightly" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("[update] track must be one of");
  });

  test("without a sign-in it is refused before anything is saved", async () => {
    const saved: { track?: string }[] = [];
    const res = await post(app(saved), { track: "lts" }, {});
    expect(res.status).toBe(401);
    expect(saved).toEqual([]);
  });
});

describe("one list of tracks", () => {
  test("the engine's, which the config refuses by, is the update package's, which the check reads", async () => {
    // Read from its source, as the package's other shapes are (`update-external.test.ts`): the engine declares them.
    const { UPDATE_TRACKS } = await import("@nouride/shared");
    const source = readFileSync(join(import.meta.dir, "../../../../packages/update/src/track.ts"), "utf8");
    const listed = /const UPDATE_TRACKS = \[([^\]]*)\] as const;/.exec(source)?.[1] ?? "";
    expect([...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...UPDATE_TRACKS]);
  });
});
