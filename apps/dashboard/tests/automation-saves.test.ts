/**
 * What the Automations page sends when it saves, written down for the daemon's own routes to take
 * (`tests/fixtures/automation-saves.json`: `apps/engine/tests/contracts/dashboard-saves.test.ts` sends each one to
 * `/cron` and `/webhooks` as the daemon mounts them, and reads the automation back).
 *
 * The page's rules for a list of steps and the server's are two copies of one rule, and the mount tests answer a save
 * from a fixture: a body the server refuses, or keeps otherwise than the page then draws it, would pass every test
 * here and fail in a browser. Each save below is made with the page's own operations (a step added and written, a
 * path set, a step moved or deleted), so the file follows the page and not a hand that copied it.
 *
 * Written again after a change to what a save sends: `WRITE_SAVE_FIXTURES=1 bun test <this file>`. The engine's test
 * then says whether the daemon takes it.
 */

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepExit } from "@nouride/wire";
import { blankDraft, createBody, deliveryOf, patchBody, payloadOf, settled, type Draft } from "@/modules/automations/lib/draft";
import { KINDS, argvOf, blankStep, insertStep, moveStep, removeStep, setExit, type ExitName, type Step, type StepKind } from "@/modules/automations/lib/steps";

const FIXTURES = join(import.meta.dir, "fixtures", "automation-saves.json");
const TZ = "Asia/Jakarta";

/** One save, and what the page then draws: the automation as the server must keep it. */
interface Save {
  name: string;
  /** A new automation, sent to `/cron` or `/webhooks`; or a change to the one a save above made, by that save's name. */
  send: { create: "/cron" | "/webhooks" } | { change: string };
  body: unknown;
  keeps: { name: string; start: Draft["start"]; payload: unknown; target: { gatewayId: string; chatId: string }; delivery: unknown };
}

/** A draft as the page that makes one starts it, with its chat picked. */
const fresh = (over: Partial<Draft>): Draft => ({ ...blankDraft("nouva", "telegram:nouva", TZ), chatId: "8142", ...over });
/** The editor's own operations, each ended as the editor ends a change (`use-editor.ts`). */
const add = (draft: Draft, kind: StepKind, written: Record<string, unknown>): Draft =>
  settled({ ...draft, steps: insertStep(draft.steps, draft.steps.length, { ...blankStep(kind, draft.steps), ...written } as Step).steps });
const path = (draft: Draft, index: number, exit: ExitName, go: StepExit): Draft => settled({ ...draft, steps: setExit(draft.steps, index, exit, go) });
const move = (draft: Draft, from: number, to: number): Draft => settled({ ...draft, steps: moveStep(draft.steps, from, to).steps });
const remove = (draft: Draft, index: number): Draft => settled({ ...draft, steps: removeStep(draft.steps, index).steps });

const kept = (draft: Draft): Save["keeps"] => ({
  name: draft.name.trim(),
  start: draft.start,
  payload: payloadOf(draft),
  target: { gatewayId: draft.gatewayId, chatId: draft.chatId.trim() },
  delivery: deliveryOf(draft),
});
const made = (draft: Draft): Save => ({ name: draft.name, send: { create: draft.start === "webhook" ? "/webhooks" : "/cron" }, body: createBody(draft), keeps: kept(draft) });
/** A change to one a save above made: `was` is that draft as the page holds it once loaded, a list where it was saved as one. */
const changed = (name: string, of: Draft, now: Draft): Save => {
  const was: Draft = { ...of, list: payloadOf(of).kind === "steps" };
  return { name, send: { change: of.name }, body: patchBody(was, { ...now, list: was.list }), keeps: kept({ ...now, list: was.list }) };
};

function saves(): Save[] {
  // Every kind of step, with paths of their own, on a timer.
  let shop = fresh({ name: "Shop health check" });
  shop = add(shop, "command", { argv: argvOf("curl -sf https://shop.example.com/health") });
  shop = add(shop, "agentTurn", { name: "Find out why", message: "The shop's health check failed. Find out why and say what you found.", agentId: "nix" });
  shop = add(shop, "mission", { name: "Bring it back", goal: "Bring the shop back up and confirm that it answers.", checks: ["curl -sf https://shop.example.com/health"] });
  shop = add(shop, "approval", { ask: "Post what was found to the group?", timeoutMs: 3_600_000 });
  shop = add(shop, "systemEvent", { name: "Tell the group", text: "The shop was down for a while. What was found is above." });
  shop = add(shop, "systemEvent", { name: "Tell me", text: "The shop check needs you: a step failed and it could not fix itself." });
  const last = shop.steps[5]!.id;
  shop = path(shop, 0, "then", "end");
  shop = path(shop, 0, "whenFailed", "next");
  shop = path(shop, 1, "whenFailed", { to: last });
  shop = path(shop, 1, "whenEmpty", "next");
  shop = path(shop, 2, "whenFailed", { to: last });
  shop = path(shop, 4, "then", "end");

  // One thing, started by hand: a command whose output its agent reads.
  const backup = add(fresh({ name: "Backup check", start: "manual", then: "agentTurn" }), "command", { argv: argvOf("ls backups | tail -1") });

  // Started by a webhook: two steps.
  let order = add(fresh({ name: "New order", start: "webhook" }), "agentTurn", { message: "A new order came in. Read what was sent and say who ordered what." });
  order = add(order, "systemEvent", { text: "New order, details above." });

  // One message at a time of day, on weekdays.
  const brief = add(fresh({ name: "Morning brief", trigger: { ...fresh({}).trigger, mode: "daily", time: "07:00", days: [1, 2, 3, 4, 5] } }), "systemEvent", { text: "Good morning. The bins go out today." });

  // Once, kept on the list after it ran, and quiet.
  const tidy = add(fresh({ name: "Year-end tidy", trigger: { ...fresh({}).trigger, mode: "once", at: "2099-12-31T09:00" }, keepAfterRun: true, delivery: { mode: "none" } }), "agentTurn", {
    message: "Archive this year's reports.",
  });

  // The list changed: renamed, a step moved above the wait, the step two paths led to deleted, and another time to start.
  let shopNow: Draft = { ...shop, name: "Shop check", trigger: { ...shop.trigger, mode: "daily", time: "07:00", days: [] } };
  shopNow = move(shopNow, 4, 3);
  shopNow = remove(shopNow, 5);

  // The one thing becomes a list: its command, a step for the agent that read its output, and the step added.
  const backupNow = add(backup, "systemEvent", { text: "Backup checked." });

  // Where the webhook's automation reports, and that it stays quiet.
  const orderNow: Draft = { ...order, chatId: "-100200", delivery: { mode: "none" } };

  return [
    made(shop),
    made(backup),
    made(order),
    made(brief),
    made(tidy),
    changed("Shop health check, changed", shop, shopNow),
    changed("Backup check, with a second step", backup, backupNow),
    changed("New order, reporting elsewhere and quiet", order, orderNow),
  ];
}

/** As the file holds it: what JSON drops (a field left unset) is not there. */
const written = (): Save[] => JSON.parse(JSON.stringify(saves())) as Save[];

test("what the page sends for each save is the file the daemon's test takes", () => {
  const now = written();
  if (process.env.WRITE_SAVE_FIXTURES === "1") writeFileSync(FIXTURES, `${JSON.stringify(now, null, 2)}\n`);
  expect(JSON.parse(readFileSync(FIXTURES, "utf8"))).toEqual(now);
});

test("the saves are of every kind of step, every way a path can go, each way to start, one thing and a list, a new one and a change", () => {
  const all = written();
  const payloads = all.map((save) => save.keeps.payload as { kind: string; steps?: Step[] });
  const steps = payloads.flatMap((payload) => payload.steps ?? []);
  expect([...new Set(steps.map((step) => step.kind))].sort()).toEqual([...KINDS].sort());
  const goes = steps.flatMap((step) => [step.then, step.whenFailed, step.whenEmpty]).filter((go) => go !== undefined);
  expect(goes).toContain("end");
  expect(goes).toContain("next");
  expect(goes.some((go) => typeof go === "object")).toBe(true);
  expect([...new Set(all.map((save) => save.keeps.start))].sort()).toEqual(["manual", "scheduled", "webhook"]);
  expect([...new Set(payloads.map((payload) => payload.kind))].sort()).toEqual(["agentTurn", "command", "steps", "systemEvent"]);
  expect(all.filter((save) => "change" in save.send).length).toBeGreaterThanOrEqual(3);
  // A change sends what changed: the renamed, reordered list sends its name, its steps and its time, and no chat.
  expect(Object.keys(all.find((save) => save.name === "Shop health check, changed")!.body as object).sort()).toEqual(["cron", "name", "payload", "tz"]);
  // A path that led to a deleted step is gone from what is sent, not sent pointing nowhere.
  const shopNow = payloads[5]!.steps!;
  expect(shopNow.flatMap((step) => [step.then, step.whenFailed, step.whenEmpty]).filter((go) => typeof go === "object")).toEqual([]);
});
