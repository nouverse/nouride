/**
 * What the badge says, and specifically what it must never say.
 *
 * It said "Version unknown" once, in a header that was printing `v0.3.1` two inches to the
 * left, because the release check had failed. The version is never unknown — it comes from the
 * daemon answering the request. What can be unknown is whether anything newer exists, and the
 * three reasons for that are acted on differently.
 */

import { describe, expect, test } from "bun:test";
import { badgeState, editionLabel } from "@/commons/hooks/use-update";
import type { UpdateStatus } from "@/commons/lib/api";

const INSTALL: UpdateStatus["install"] = {
  version: "0.3.1",
  edition: "basic",
  installDir: "/srv/nouride",
  supervisor: "systemd",
  compiled: true,
  platform: "linux",
  arch: "arm64",
  musl: false,
};

const IDLE: UpdateStatus["download"] = {
  status: "idle",
  received: 0,
  total: null,
  tag: null,
  artifact: null,
  error: null,
};

const CHECK = {
  current: "0.3.1",
  latest: "v0.3.2",
  newer: true,
  publishedAt: null,
  notesUrl: null,
};

describe("the badge", () => {
  test("is checking before anything has arrived", () => {
    expect(badgeState(undefined)).toBe("checking");
  });

  test("a failed channel is 'unreachable', not 'unknown'", () => {
    /**
     * The regression. The daemon answered — it told us its version and that the channel is
     * down — so the only thing missing is the release list.
     */
    const state = badgeState({
      supported: true,
      install: INSTALL,
      download: IDLE,
      error: "the release channel answered 403",
    });
    expect(state).toBe("unreachable");
  });

  test("a build with no provider is its own state", () => {
    // Nothing will ever change, so the page has nothing more to say and the badge is not a link.
    expect(badgeState({ supported: false, install: INSTALL, download: IDLE })).toBe("unsupported");
  });

  test("current and available are told apart by the check, not by the download", () => {
    expect(badgeState({ supported: true, install: INSTALL, download: IDLE, check: { ...CHECK, newer: false } })).toBe(
      "current",
    );
    expect(badgeState({ supported: true, install: INSTALL, download: IDLE, check: CHECK })).toBe("available");
  });

  test("a finished download is 'ready', which is a different decision from 'available'", () => {
    const downloaded: UpdateStatus["download"] = { ...IDLE, status: "ready", tag: "v0.3.2" };
    expect(badgeState({ supported: true, install: INSTALL, download: downloaded, check: CHECK })).toBe("ready");
  });

  test("a download running or paused reads as in progress", () => {
    // It is somebody's unfinished business either way; "paused" belongs on the page, not here.
    const paused: UpdateStatus["download"] = { ...IDLE, status: "paused", tag: "v0.3.2", received: 10 };
    expect(badgeState({ supported: true, install: INSTALL, download: paused, check: CHECK })).toBe("downloading");
    const running: UpdateStatus["download"] = { ...IDLE, status: "downloading", tag: "v0.3.2", received: 10 };
    expect(badgeState({ supported: true, install: INSTALL, download: running, check: CHECK })).toBe("downloading");
  });

  test("a malformed answer does not become 'up to date'", () => {
    // The dangerous direction: silence read as reassurance.
    expect(badgeState({ supported: true, install: INSTALL } as UpdateStatus)).toBe("unreachable");
  });
});

describe("edition labels", () => {
  test("`basic` is what the build calls itself and `Community` is what a person calls it", () => {
    expect(["basic", "router", "pro"].map(editionLabel)).toEqual(["Community", "Router", "Pro"]);
  });

  /**
   * The three are the whole set. The names they had before are carried by no daemon a dashboard can be talking to —
   * 0.8.0 is installed over 0.7.28 — so none is labelled as one of the three any more: each is shown as it is, like
   * any edition this was never taught. Pro Router's too, read as Pro until 0.8.0.
   */
  test("an edition outside the three is shown as it is, not hidden — the old names included", () => {
    for (const name of ["something-new", "pro-router", "device", "device-pro", "cloud", "normal", "device-nougate"]) {
      expect(editionLabel(name)).toBe(name);
    }
  });
});
