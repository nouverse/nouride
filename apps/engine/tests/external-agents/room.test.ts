/**
 * Whether a box can hold a coding CLI (EXTERNAL_AGENTS §6): with less room for the agents' commands than one CLI's
 * session holds, external agents are not offered — the scan says so and lists none — and a box that will not say what
 * it has is not refused on a number it never gave.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";

const MiB = 1024 * 1024;
const service = (bytes: number, scanned: string[] = []) =>
  new ExternalAgents({
    workspaceDir: () => "/nowhere",
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    room: () => bytes,
    scan: async (row) => (scanned.push(row.id), { id: row.id, name: row.name, command: row.command, installed: false, install: row.install, login: false }),
  });

describe("room for a coding CLI", () => {
  test("is enough at a session's measured size and above, not below; unknown is not refused", () => {
    expect(service(300 * MiB).room()).toEqual({ enough: false, bytes: 300 * MiB, needs: 512 * MiB });
    expect(service(512 * MiB).room().enough).toBe(true);
    expect(service(4096 * MiB).room().enough).toBe(true);
    expect(service(0).room().enough).toBe(true);
  });

  test("a box without it is told so by the scan, and offered no CLI", async () => {
    const scanned: string[] = [];
    const app = new Hono();
    const token = "control-token-for-tests-0000000000";
    mountControlRoutes(app, {
      ctx: { config: {}, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
      token,
      registry: { get: () => undefined } as unknown as AgentRegistry,
      externalAgents: service(300 * MiB, scanned),
    } as unknown as ControlDeps);
    const answer = (await (await app.request("/api/control/external-clis", { headers: { "x-nouride-token": token } }, { clientAddress: "203.0.113.10" })).json()) as { room: { enough: boolean; bytes: number; needs: number }; clis: unknown[] };
    expect(answer).toEqual({ room: { enough: false, bytes: 300 * MiB, needs: 512 * MiB }, clis: [] });
    expect(scanned).toEqual([]);
  });
});
