/**
 * The decisions `POST /approvals/:id/:decision` takes: three words, and a refusal that names them. `approve`, which a
 * CLI from before 0.7.10 sent, is one it does not take — read as anything, it would answer an approval nobody chose.
 */

import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerApprovalRoutes } from "@/modules/web/control/routes/approvals.ts";

function app() {
  const decided: string[] = [];
  const control = new Hono();
  control.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "token", actor: "cli" } as never);
    await next();
  });
  registerApprovalRoutes(control as never, { approvals: { resolve: (_id: string, decision: string) => (decided.push(decision), true) } } as never);
  return { control, decided };
}

test("a word it does not take is refused, naming the three it does — not the old one", async () => {
  const { control } = app();
  const res = await control.request("/approvals/a1/yes", { method: "POST" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "decision must be one of allow-once, allow-always, deny" });
});

test("approve, the word a CLI from before 0.7.10 sent, is refused like any other — nothing is answered", async () => {
  const { control, decided } = app();
  expect((await control.request("/approvals/a1/approve", { method: "POST" })).status).toBe(400);
  expect(decided).toEqual([]);
});
