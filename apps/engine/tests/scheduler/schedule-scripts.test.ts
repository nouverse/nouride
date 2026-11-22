/**
 * `schedule`, for a script and for a watch that ends: what an agent writes, what the job keeps of it, what is refused
 * with the reason said to the agent, and the sentences of the tool's description that make it reach for a script. Those
 * sentences are behaviour: a model reads them on every request and decides by them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { Job, MessageButton, Tool, ToolContext } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { ProposalCards } from "@/modules/cron/proposal-cards.ts";
import type { ScriptFacts } from "@/modules/cron/scripts.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";

let dir = "";
let db: SqliteDb;
let store: CronStore;
let asked: { text: string; buttons: MessageButton[] }[];
let tool: Tool;
let facts: ScriptFacts;

const DM = { agentId: "nouva", gatewayId: "telegram:main", chatId: "8142", senderId: "8142", workspaceRoots: [] } as unknown as ToolContext;
const HOUR = 3_600_000;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "schedule-scripts-"));
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  store = new CronStore({ db, config: DEFAULT_CONFIG.cron, timezone: "Asia/Jakarta" });
  asked = [];
  facts = { secrets: () => ["notion_token"], hasProgram: async (_agent, program) => program !== "python9" };
  const cards = new ProposalCards({
    store,
    notifier: { ask: async (_target, text, buttons) => (asked.push({ text: text(true), buttons }), { ids: [`m${asked.length}`], buttons: true }), settle: async () => true },
    voice: (_agentId, gatewayId) => gatewayId,
    isAdmin: () => false,
    isOwner: () => false,
    when: (job) => (job.trigger.kind === "every" ? "every 10m" : job.trigger.kind),
    results: () => null,
  });
  tool = createScheduleTool({ store, timezone: () => "Asia/Jakarta", agentExists: (id) => id === "nouva" || id === "nox", post: (job) => cards.post(job), chats: () => ({ chats: [], othersGateways: [] }), scripts: facts });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const propose = (args: Record<string, unknown>) => tool.execute({ name: "Price watch", when: "every 10m", ...args }, DM);
const jobs = (): Job[] => store.list({ includeDisabled: true });
const CHECK = 'price=$(curl -s https://example.test/price)\n[ "$price" -lt 100 ] && echo "It is $price now"';

describe("the words that make an agent write a script", () => {
  test("what is the same every run is a script, and a prompt is for judgement", () => {
    const words = tool.definition.description;
    expect(words).toContain("`script` runs a program you write");
    expect(words).toContain("What is the same every run and needs no judgement (fetch, compare, call a service) is a `script`: no model runs. A `prompt` is for what must be read, judged or written.");
  });

  test("a loop, a retry or branches are one script and not a web of steps, and a script is tried before it is proposed", () => {
    const words = tool.definition.description;
    expect(words).toContain("Work that needs a loop, a retry or more than one branch is one `script`, not more steps.");
    expect(words).toContain("Run a script once with `exec` before you propose it.");
  });

  test("being told when something happens is a script that prints only once it has, and ends well until then", () => {
    // Ending in an error while the moment has not come is a failure, said in the chat each time it looks.
    expect(tool.definition.description).toContain("To be told when something happens, a `script` that prints only once it has and exits 0 until then (`if`, not `&&`), with `once`.");
  });

  test("the fields say what a script reads and hands on, what runs it, and what a person reads of it", () => {
    const fields = tool.definition.parameters.properties as Record<string, { description?: string; items?: { properties: Record<string, unknown> } }>;
    expect(fields.script?.description).toBe("A program's text, kept in the job. It reads what the step before said, or a webhook's body, on stdin; what it prints is sent or handed on, printing nothing says nothing, a non-zero exit is a failure.");
    expect(fields.run?.description).toBe('What runs the `script`: "sh" unless said, or "python3", "bun".');
    expect(fields.about?.description).toBe("With `script`: what it does, in one line a person reads before turning it on.");
    expect(fields.secrets?.description).toBe("With `script`: your secrets it is handed as variables, by name.");
    // A step is written as a job of one kind is: the same fields.
    for (const field of ["script", "run", "about", "secrets"]) expect(Object.keys(fields.steps!.items!.properties)).toContain(field);
  });
});

describe("proposing a script", () => {
  test("the job keeps its text, what runs it and what it does, signed with the agent that wrote it", async () => {
    const result = await propose({ script: CHECK, about: "Tells you when the price is under 100", once: true, for: "7d" });
    expect(result.isError).toBe(false);
    const [job] = jobs();
    expect(job!.payload).toEqual({ kind: "command", argv: ["sh"], script: { text: CHECK, about: "Tells you when the price is under 100", by: "agent:nouva" }, then: "deliver" });
    expect(job!.delivery).toEqual({ mode: "announce", once: true, lasts: 7 * 24 * HOUR });
    expect(job!.enabled).toBe(false);
  });

  test("what runs it is the program as written, with that program's own arguments, and its secrets are kept by name", async () => {
    await propose({ script: "print('hi')", run: "python3 -u", about: "Greets", secrets: ["notion_token"] });
    expect(jobs()[0]!.payload).toMatchObject({ argv: ["python3", "-u"], script: { secrets: ["notion_token"] } });
  });

  test("its card says it in words a person reads, with the text under them", async () => {
    await propose({ script: CHECK, about: "Tells you when the price is under 100", once: true, for: "7d" });
    const card = asked[0]!.text;
    expect(card).toContain("Does: Tells you when the price is under 100\n   a script run by `sh` on this machine, with no model: 2 lines\n```\n" + CHECK + "\n```");
    expect(card).toContain("Lasts: 7 days from when it is turned on. Then it turns itself off and says so, if it has told nothing by then.");
  });

  test("a script with no line of what it does is refused, and nothing is kept", async () => {
    const refused = await propose({ script: CHECK });
    expect(refused).toMatchObject({ isError: true, content: "A `script` needs `about`: one line of what it does, for the person who turns it on." });
    expect(jobs()).toEqual([]);
  });

  test("a script and another thing beside it are refused: a job is one of them", async () => {
    const refused = await propose({ script: CHECK, about: "x", command: "date" });
    expect(refused.content).toBe("Give exactly one of `text`, `command`, `script`, `prompt` or `mission`.");
  });

  test("a step of a list is a script, handed what the step before said, and so is one started beside others", async () => {
    const result = await propose({ steps: [{ prompt: "Sum up today's mail." }, { script: "cat > /dev/null; echo saved", about: "Saves it", name: "Save it", if_failed: "next" }, { together: [{ script: "wc -w", about: "Counts the words" }, { prompt: "Say hello." }] }] });
    expect(result.isError).toBe(false);
    const steps = (jobs()[0]!.payload as unknown as { steps: Record<string, unknown>[] }).steps;
    expect(steps[1]).toEqual({ id: "s2", kind: "command", name: "Save it", whenFailed: "next", argv: ["sh"], script: { text: "cat > /dev/null; echo saved", about: "Saves it", by: "agent:nouva" } });
    expect((steps[2] as { steps: Record<string, unknown>[] }).steps[0]).toMatchObject({ kind: "command", argv: ["sh"], script: { about: "Counts the words", by: "agent:nouva" } });
  });

  test("a script that speaks only when what it prints changes is a list of one marked step", async () => {
    await propose({ script: "df -h / | awk 'NR==2 {print $5}'", about: "Reads how full the disk is", only_changed: true });
    expect(jobs()[0]!.payload).toEqual({ kind: "steps", steps: [{ id: "s1", kind: "command", argv: ["sh"], script: { text: "df -h / | awk 'NR==2 {print $5}'", about: "Reads how full the disk is", by: "agent:nouva" }, onlyChanged: true }] });
  });

  test("a script a call from outside would set off is an admin's to make, as a command is", async () => {
    const refused = await propose({ when: "webhook", script: "cat", about: "Echoes" });
    expect(refused.content).toBe("A webhook that runs a command or a script is made by an admin from the dashboard, not proposed.");
  });

  test("a program that is not on this machine is said to the agent that wrote the script, and nothing is proposed", async () => {
    const refused = await propose({ script: "print('hi')", run: "python9", about: "Greets" });
    expect(refused).toMatchObject({ isError: true, content: "Not proposed: `python9` is not on this machine for nouva's commands, so the script could not run: write it for a program that is (`sh` always is), or install that one." });
    expect(jobs()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a secret its agent does not hold is said, with its place in a list", async () => {
    const refused = await propose({ steps: [{ text: "Starting." }, { script: "echo", about: "Posts", secrets: ["gh_token"] }] });
    expect(refused.content).toBe("Not proposed: step 2: the script names `gh_token`, which nouva's commands are not handed: an admin adds a secret to an agent on its page.");
    expect(jobs()).toEqual([]);
  });

  test("the machine is asked for the agent that will run it, not the one that proposes", async () => {
    const askedFor: string[] = [];
    facts.hasProgram = async (agentId) => (askedFor.push(agentId), true);
    await propose({ script: "echo", about: "x", agent: "nox" });
    expect(askedFor).toEqual(["nox"]);
  });
});

describe("a watch an agent sets has an end", () => {
  test("telling once on a schedule needs how long it watches, and says why", async () => {
    const refused = await propose({ script: CHECK, about: "x", once: true });
    expect(refused).toMatchObject({ isError: true, content: '`once` on a schedule needs `for`: how long it watches before it gives up and says so ("6h", "30d"). With no end it would check for good.' });
    expect(jobs()).toEqual([]);
    // A pattern is a schedule too.
    expect((await propose({ when: "cron 0 9 * * 1-5", text: "Standup", once: true })).isError).toBe(true);
  });

  test("a job that is not on a clock tells once with no end, since nothing of it checks", async () => {
    expect((await propose({ when: "manual", text: "Done.", once: true })).isError).toBe(false);
    expect(jobs()[0]!.delivery).toEqual({ mode: "announce", once: true });
  });

  test("a length that is not one is refused in the tool's own words", async () => {
    expect((await propose({ text: "hi", for: "a while" })).content).toBe('`for` is a length of time: "6h", "30d".');
  });

  test("a job may last a set time without telling once", async () => {
    await propose({ text: "Drink water.", when: "every 1h", for: "8h" });
    expect(jobs()[0]!.delivery).toEqual({ mode: "announce", lasts: 8 * HOUR });
  });

  test("a change that says no length keeps the one the job has", async () => {
    await propose({ script: CHECK, about: "x", once: true, for: "6h" });
    const made = store.setEnabled(jobs()[0]!.id, true, "tester")!;
    db.prepare("UPDATE cron_jobs SET proposal = NULL WHERE id = ?").run(made.id);
    const changed = await propose({ script: `${CHECK}\necho checked`, about: "x", once: true, replaces: made.id });
    expect(changed.isError).toBe(false);
    expect(jobs().find((job) => job.proposal?.replaces === made.id)!.delivery).toEqual({ mode: "announce", once: true, lasts: 6 * HOUR });
  });
});
