/**
 * `/health` passes on the image name a container should move to: the image under its old name says so in
 * `NOURIDE_IMAGE_MOVED_TO`, and the dashboard reads `/health` on every page to tell whoever runs it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DaemonContext } from "@/commons/context.ts";
import { buildHealth, imageMovedTo } from "@/modules/web/health.ts";

const ctx = {
  gateways: new Map(),
  db: { walSizeBytes: () => 0 },
  config: { daemon: { dataDir: "/tmp/nr-health" } },
  providerErrors: new Map(),
  status: "running",
  startedAt: Date.now(),
  agentCount: 1,
} as unknown as DaemonContext;

const before = process.env.NOURIDE_IMAGE_MOVED_TO;
afterEach(() => {
  if (before === undefined) delete process.env.NOURIDE_IMAGE_MOVED_TO;
  else process.env.NOURIDE_IMAGE_MOVED_TO = before;
});

describe("the image's new name", () => {
  test("said on /health where the image sets it, and nowhere else", () => {
    process.env.NOURIDE_IMAGE_MOVED_TO = "ghcr.io/nouverse/nouride";
    expect(buildHealth(ctx).payload.imageMovedTo).toBe("ghcr.io/nouverse/nouride");
    delete process.env.NOURIDE_IMAGE_MOVED_TO;
    expect(buildHealth(ctx).payload).not.toHaveProperty("imageMovedTo");
  });

  test("an image reference only: /health answers anyone who can reach the port", () => {
    expect(imageMovedTo({ NOURIDE_IMAGE_MOVED_TO: " ghcr.io/nouverse/nouride:latest " })).toBe("ghcr.io/nouverse/nouride:latest");
    expect(imageMovedTo({ NOURIDE_IMAGE_MOVED_TO: "registry.lan:5000/me/nouride" })).toBe("registry.lan:5000/me/nouride");
    for (const value of ["", "<script>alert(1)</script>", "Move to this image now", "x".repeat(300)]) {
      expect({ value, said: imageMovedTo({ NOURIDE_IMAGE_MOVED_TO: value }) }).toEqual({ value, said: null });
    }
    expect(imageMovedTo({})).toBeNull();
  });
});
