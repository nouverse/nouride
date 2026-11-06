/**
 * The boot waits for its gateways a bounded time (0.8.15).
 *
 * On the live box `telegram:nouva`'s first connect took sixty seconds — a `getMe` that hung, retried inside the client
 * — and the whole daemon waited for it: the dashboard's routes, the CLI, the inbox, the missions, the scheduler
 * (2026-11-02).
 */

import { expect, test } from "bun:test";
import type { Gateway } from "@nouride/shared";
import { startGateways } from "@/boot/gateways-start.ts";

function gateway(start: () => Promise<void>): Gateway {
  return { start } as unknown as Gateway;
}

test("one gateway that does not finish connecting holds the boot no longer than the wait, and is named", async () => {
  const began = Date.now();
  const late = await startGateways(
    new Map([
      ["telegram:fast", gateway(async () => {})],
      ["telegram:hung", gateway(() => new Promise<void>(() => {}))],
    ]),
    50,
  );
  expect(late).toEqual(["telegram:hung"]);
  expect(Date.now() - began).toBeLessThan(1_000);
});

test("gateways that all start do not make the boot wait out the bound", async () => {
  const began = Date.now();
  const late = await startGateways(new Map([["telegram:a", gateway(async () => {})], ["discord:b", gateway(async () => {})]]), 10_000);
  expect(late).toEqual([]);
  expect(Date.now() - began).toBeLessThan(1_000);
});

test("a start that throws is logged and does not stop the others", async () => {
  let started = false;
  const late = await startGateways(
    new Map([
      ["telegram:broken", gateway(async () => Promise.reject(new Error("no route to host")))],
      ["telegram:ok", gateway(async () => void (started = true))],
    ]),
    1_000,
  );
  expect(late).toEqual([]);
  expect(started).toBe(true);
});
