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
import { addToLane, choosePath, insertOnLine, moveOnLine, removeDrawn, setLaneEnd, type Choice, type PathExit } from "@/modules/automations/lib/paths";
import { KINDS, argvOf, blankStep, newStepId, replaceStep, setExit, type ExitName, type Step, type StepKind } from "@/modules/automations/lib/steps";

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
  settled({ ...draft, steps: insertOnLine(draft.steps, null, { ...blankStep(kind, draft.steps), ...written } as Step) });
/** A one-line command, as an automation made before scripts holds one and the page still saves it: a new one from the page is a script. */
const line = (draft: Draft, typed: string, written: Record<string, unknown> = {}): Draft =>
  settled({ ...draft, steps: insertOnLine(draft.steps, null, { id: newStepId(draft.steps), kind: "command", argv: argvOf(typed), ...written } as Step) });
const path = (draft: Draft, index: number, exit: ExitName, go: StepExit): Draft => settled({ ...draft, steps: setExit(draft.steps, index, exit, go) });
const move = (draft: Draft, from: number, to: number): Draft => settled({ ...draft, steps: moveOnLine(draft.steps, from, to) });
const remove = (draft: Draft, index: number): Draft => settled({ ...draft, steps: removeDrawn(draft.steps, index) });
/** One of a step's paths given an answer, and what the page then has written into the step it made. */
const choose = (draft: Draft, index: number, exit: PathExit, choice: Exclude<Choice, "jump">, written: Record<string, unknown> = {}): Draft => {
  const chosen = choosePath(draft.steps, index, exit, choice);
  const made = chosen.steps.findIndex((step) => !draft.steps.some((was) => was.id === step.id));
  return settled({ ...draft, steps: made < 0 ? chosen.steps : replaceStep(chosen.steps, made, { ...chosen.steps[made]!, ...written } as Step) });
};
const laneStep = (draft: Draft, owner: number, exit: PathExit, kind: StepKind, written: Record<string, unknown>): Draft => {
  const added = addToLane(draft.steps, owner, exit, kind);
  const made = added.steps.findIndex((step) => step.id === added.opened);
  return settled({ ...draft, steps: replaceStep(added.steps, made, { ...added.steps[made]!, ...written } as Step) });
};
const laneEnds = (draft: Draft, owner: number, exit: PathExit, ends: "stop" | "back"): Draft => settled({ ...draft, steps: setLaneEnd(draft.steps, owner, exit, ends) });

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
  shop = line(shop, "curl -sf https://shop.example.com/health");
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
  const backup = line(fresh({ name: "Backup check", start: "manual", then: "agentTurn" }), "ls backups | tail -1");

  // Started by a webhook: two steps.
  let order = add(fresh({ name: "New order", start: "webhook" }), "agentTurn", { message: "A new order came in. Read what was sent and say who ordered what." });
  order = add(order, "systemEvent", { text: "New order, details above." });

  // One message at a time of day, on weekdays.
  const brief = add(fresh({ name: "Morning brief", trigger: { ...fresh({}).trigger, mode: "daily", time: "07:00", days: [1, 2, 3, 4, 5] } }), "systemEvent", { text: "Good morning. The bins go out today." });

  // Once, kept on the list after it ran, and quiet.
  const tidy = add(fresh({ name: "Year-end tidy", trigger: { ...fresh({}).trigger, mode: "once", at: "2099-12-31T09:00" }, keepAfterRun: true, delivery: { mode: "none" } }), "agentTurn", {
    message: "Archive this year's reports.",
  });

  // Several at the same time, then a step that reads what they said; a failure among them goes on to it.
  let round = fresh({ name: "Morning round", trigger: { ...fresh({}).trigger, mode: "daily", time: "07:00", days: [] } });
  round = add(round, "parallel", {
    name: "Ask them",
    steps: [
      { id: "s1-1", name: "News", kind: "agentTurn", message: "Read today's news and say what matters.", agentId: "nix" },
      { id: "s1-2", kind: "command", argv: argvOf("ls reports | tail -3") },
    ],
  });
  round = add(round, "agentTurn", { message: "Write the morning note from what they said." });
  round = path(round, 0, "whenFailed", "next");

  // A script as a step, and "Ask me first" where it fails: the wait stands right after it, passed over when it is done.
  let digest = fresh({ name: "Morning digest", trigger: { ...fresh({}).trigger, mode: "daily", time: "07:00", days: [1, 2, 3, 4, 5] } });
  digest = add(digest, "agentTurn", { message: "Read my unread email from the last day and sum it up in four points." });
  digest = add(digest, "command", { name: "Save it", argv: ["python3"], script: { text: "import sys\n\nsummary = sys.stdin.read().strip()\nprint(f\"saved {len(summary)} characters\")\n", about: "Saves the summary as today's page." } });
  digest = add(digest, "systemEvent", { text: "The morning digest is saved." });
  digest = choose(digest, 1, "whenFailed", "ask", { ask: "Saving it failed. Send the digest anyway?" });

  // One that watches: a script marked to go on only when what it prints changes, other steps in its place where it
  // fails, silence that goes on, told once and stopped by itself after six hours.
  let watch = fresh({ name: "Backup watch", trigger: { ...fresh({}).trigger, mode: "interval", everyCount: "30", everyUnit: "m" }, delivery: { mode: "announce", once: true, lasts: 6 * 3_600_000 } });
  watch = add(watch, "command", { argv: ["sh"], script: { text: "test -f backups/last.ok && cat backups/last.ok\n", about: "Reads the mark the backup leaves when it is done." }, onlyChanged: true });
  watch = add(watch, "systemEvent", { text: "The backup is in place." });
  watch = choose(watch, 0, "whenFailed", "lane", { message: "Read the backup's log and say what went wrong." });
  watch = laneStep(watch, 0, "whenFailed", "systemEvent", { text: "The backup needs a look. What was found is above." });
  watch = laneEnds(watch, 0, "whenFailed", "stop");
  watch = choose(watch, 0, "whenEmpty", "goOn");

  // A script as the one thing an automation does, started by hand.
  const room = add(fresh({ name: "Disk room", start: "manual" }), "command", { argv: ["sh"], script: { text: "df -h / | tail -1\n", about: "Says how full the disk is." } });

  // Its lane goes back into the line, the failure of its last step goes on, and it lasts a day.
  let watchNow = laneEnds(watch, 0, "whenFailed", "back");
  watchNow = { ...watchNow, delivery: { mode: "announce", once: true, lasts: 86_400_000 } };

  // The question taken off again: the wait goes with it.
  const digestNow = choose(digest, 1, "whenFailed", "goOn");

  // The list changed: renamed, the wait taken out of the steps that run when the check fails, the step two paths led
  // to deleted, and another time to start. Those steps are a lane (a step of it goes on with nothing to say, and is
  // still its lane's step), so none of them is dragged along the main line.
  let shopNow: Draft = { ...shop, name: "Shop check", trigger: { ...shop.trigger, mode: "daily", time: "07:00", days: [] } };
  shopNow = remove(shopNow, 3);
  shopNow = remove(shopNow, 4);


  // The one thing becomes a list: its command, a step for the agent that read its output, and the step added.
  const backupNow = add(backup, "systemEvent", { text: "Backup checked." });

  // Where the webhook's automation reports, and that it stays quiet.
  const orderNow: Draft = { ...order, chatId: "-100200", delivery: { mode: "none" } };

  // Then a step of it dragged above the one before it, on a plain list: the daemon holds the change above by now.
  const orderMoved = move(orderNow, 1, 0);

  return [
    made(shop),
    made(backup),
    made(order),
    made(brief),
    made(tidy),
    made(round),
    made(digest),
    made(watch),
    made(room),
    changed("Shop health check, changed", shop, shopNow),
    changed("Backup check, with a second step", backup, backupNow),
    changed("New order, reporting elsewhere and quiet", order, orderNow),
    changed("New order, the note first", orderNow, orderMoved),
    changed("Backup watch, back into the line and for a day", watch, watchNow),
    changed("Morning digest, going on without asking", digest, digestNow),
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
  // What the canvas writes of its own: a script in a list and as the one thing, a question, a lane that stops and
  // one that goes back, a failure that goes on, a step marked to watch, and a time it lasts.
  const named = (name: string) => (all.find((save) => save.name === name)!.keeps.payload as { steps: Step[] }).steps;
  expect(steps.filter((step) => step.kind === "command" && step.script).length).toBeGreaterThanOrEqual(2);
  expect((all.find((save) => save.name === "Disk room")!.keeps.payload as { script?: { about: string } }).script?.about).toBe("Says how full the disk is.");
  expect(named("Morning digest")).toMatchObject([{ id: "s1" }, { id: "s2", then: { to: "s3" }, whenFailed: { to: "s4" } }, { id: "s4", kind: "approval", then: { to: "s3" } }, { id: "s3" }]);
  expect(named("Morning digest, going on without asking").map((step) => [step.id, step.whenFailed])).toEqual([["s1", undefined], ["s2", "next"], ["s3", undefined]]);
  expect(named("Backup watch")).toMatchObject([{ id: "s1", onlyChanged: true, then: { to: "s2" }, whenFailed: { to: "s3" }, whenEmpty: { to: "s2" } }, { id: "s3" }, { id: "s4", then: "end" }, { id: "s2" }]);
  expect(named("Backup watch, back into the line and for a day").map((step) => [step.id, step.then])).toEqual([["s1", { to: "s2" }], ["s3", undefined], ["s4", { to: "s2" }], ["s2", undefined]]);
  expect(all.find((save) => save.name === "Backup watch")!.keeps.delivery).toEqual({ mode: "announce", once: true, lasts: 21_600_000 });
  expect(all.find((save) => save.name === "Backup watch, back into the line and for a day")!.body).toMatchObject({ delivery: { mode: "announce", once: true, lasts: 86_400_000 } });
  expect(all.filter((save) => "change" in save.send).length).toBeGreaterThanOrEqual(3);
  // A change sends what changed: the renamed, shortened list sends its name, its steps and its time, and no chat.
  expect(Object.keys(all.find((save) => save.name === "Shop health check, changed")!.body as object).sort()).toEqual(["cron", "name", "payload", "tz"]);
  // The check's own steps for a failure are a lane, one of which goes on with nothing to say; with the wait and the
  // step two paths led to gone, the lane is the three left, in the order they run. Its last step is the last of the
  // list now, and ends the run by being that.
  expect(named("Shop health check").map((step) => step.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  expect(named("Shop health check, changed").map((step) => [step.id, step.then, step.whenEmpty])).toEqual([["s1", "end", undefined], ["s2", undefined, "next"], ["s3", undefined, undefined], ["s5", undefined, undefined]]);
  // A dragged step: the list in its new order, and nothing but the list sent.
  expect(named("New order, the note first").map((step) => step.kind)).toEqual(["systemEvent", "agentTurn"]);
  expect(Object.keys(all.find((save) => save.name === "New order, the note first")!.body as object)).toEqual(["payload"]);
  // A path that led to a deleted step is gone from what is sent, not sent pointing nowhere.
  const shopNow = (all.find((save) => save.name === "Shop health check, changed")!.keeps.payload as { steps: Step[] }).steps;
  expect(shopNow.flatMap((step) => [step.then, step.whenFailed, step.whenEmpty]).filter((go) => typeof go === "object")).toEqual([]);
});
