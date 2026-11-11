/**
 * What else is at work, said on a turn's message (`modules/pipeline/work-now.ts`): the other agents of its chat, and
 * the rest of the box.
 *
 * Each case is a way the line would mislead or leak: an agent at work not named, a tag left live inside a quoted
 * request, another person's private request said in this chat, the turn told of itself, a busy box filling the
 * message, or the cached part of the prompt moving with what runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope, Tool } from "@nouride/shared";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { Mission } from "@/modules/missions/types.ts";
import type { ActiveTurn } from "@/modules/pipeline/active-turns.ts";
import { boxNote, roomNote, WORK_SHOWN, workNotes, workNow, type WorkNow, type WorkSources } from "@/modules/pipeline/work-now.ts";
import { AutoApprovalGate, conversationOf, envelope, eventually, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const GADING = { gatewayId: "telegram:nouva", senderId: "100" };
const RINA = { gatewayId: "whatsapp:home", senderId: "200" };

const message = (overrides: Partial<MessageEnvelope> = {}): MessageEnvelope =>
  envelope({ id: "m1", gatewayId: GADING.gatewayId, chatId: "814", senderId: GADING.senderId, text: "x", ...overrides });

const turn = (overrides: Partial<ActiveTurn> = {}): ActiveTurn => ({
  controller: new AbortController(),
  agentId: "nox",
  gatewayId: "telegram:nouva",
  chatId: "814",
  startedAt: NOW - 2 * MIN,
  ...overrides,
});

const job = (overrides: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: "job_1",
    agentId: "nouva",
    gatewayId: "telegram:nouva",
    chatId: "900",
    command: "bun run build",
    cwd: "/srv/projects/shop",
    status: "running",
    startedAt: NOW - 3 * MIN,
    kind: "command",
    brief: null,
    ask: null,
    senderId: null,
    ...overrides,
  }) as JobRecord;

const mission = (overrides: Partial<Mission> = {}): Mission =>
  ({
    id: "msn_1",
    agentId: "nix",
    startedBy: RINA.senderId,
    gatewayId: RINA.gatewayId,
    chatId: "555",
    goal: "Move the shop to the new server",
    workdir: "/srv/nouride/private/nix/missions/msn_1",
    status: "running",
    createdAt: NOW - 30 * MIN,
    startedAt: NOW - 20 * MIN,
    ...overrides,
  }) as Mission;

/** A room on Telegram: the orchestrator reading, two agents beside it. */
function sources(overrides: Partial<WorkSources> = {}): WorkSources {
  return {
    me: "nouva",
    at: { gatewayId: "telegram:nouva", chatId: "814", room: true },
    reader: GADING,
    mates: ["nox", "nero"],
    agents: ["nouva", "nox", "nero", "nix"],
    turns: [],
    turnHere: () => undefined,
    parkedHere: () => false,
    asleep: () => false,
    jobs: () => [],
    missions: [],
    samePerson: (a, b) => a.gatewayId === b.gatewayId && a.senderId === b.senderId,
    namesOf: (id) => [id, id.charAt(0).toUpperCase() + id.slice(1)],
    ...overrides,
  };
}

describe("the other agents of a room", () => {
  test("one at work is named with its request, how long, and an approval it waits on", () => {
    const busy = turn({ trigger: message({ text: "nox: deploy the shop and tell @nero when it is up" }) });
    const [note] = workNotes(sources({ turnHere: (id) => (id === "nox" ? busy : undefined), parkedHere: (id) => id === "nox" }), NOW);
    expect(note).toBe('(In this chat now: nox is at work on "deploy the shop and tell nero when it is up" (2m so far), waiting for an approval here.)');
  });

  test("a tag inside the request it quotes reaches nobody: the @ is taken out", () => {
    const busy = turn({ trigger: message({ text: "@nox ask <@123> and @nero" }) });
    const [note] = workNotes(sources({ turnHere: (id) => (id === "nox" ? busy : undefined) }), NOW);
    expect(note).not.toContain("@");
    expect(note).toContain('on "ask and nero"');
  });

  test("one asleep is said to take no work; one free is not named", () => {
    const [note] = workNotes(sources({ asleep: (id) => id === "nero" }), NOW);
    expect(note).toBe("(In this chat now: nero is asleep and takes no work until a person wakes it.)");
  });

  test("work the room never saw asked is named without words: a peer's turn, a job's wake", () => {
    const peer = turn({});
    expect(roomNote(workNow(sources({ turnHere: (id) => (id === "nox" ? peer : undefined) })).mates, NOW)).toBe("(In this chat now: nox is at work (2m so far).)");
    const wake = turn({ trigger: message({ senderId: "nouride:system", text: "[System event] a job ended" }) });
    expect(roomNote(workNow(sources({ turnHere: (id) => (id === "nox" ? wake : undefined) })).mates, NOW)).toBe("(In this chat now: nox is at work (2m so far).)");
  });

  test("nothing is said when every other agent is free, and nothing in a one-to-one chat", () => {
    expect(workNotes(sources(), NOW)).toEqual([]);
    const busy = turn({ trigger: message({ text: "deploy" }) });
    expect(workNotes(sources({ at: { gatewayId: "telegram:nouva", chatId: "814", room: false }, turnHere: () => busy }), NOW)).toEqual([]);
  });
});

describe("the rest of the box", () => {
  test("each kind is named: a turn elsewhere, a scheduled run, a helper, an ask, a mission and a command with its folder", () => {
    const { work } = workNow(
      sources({
        turns: [
          turn({ agentId: "nouva", chatId: "900", trigger: message({ chatId: "900", text: "nouva: write the newsletter" }) }),
          turn({ agentId: "nero", gatewayId: "cron", chatId: "cron:job_9", startedAt: undefined }),
        ],
        jobs: (id) =>
          id === "nouva"
            ? [
                job({ id: "job_h", kind: "helper", brief: { goal: "Find every broken link" } as JobRecord["brief"], senderId: GADING.senderId }),
                job({ id: "job_a", kind: "ask", ask: { agent: "nox", task: "review the patch" }, senderId: GADING.senderId }),
                job({ id: "job_c", senderId: GADING.senderId }),
              ]
            : [],
        missions: [mission({ gatewayId: GADING.gatewayId, startedBy: GADING.senderId })],
      }),
    );
    expect(boxNote(work, "nouva", NOW)).toBe(
      "(Also at work on this box now: " +
        'a helper of yours on "Find every broken link" (3m so far); ' +
        'nox, at work for you on "review the patch" (3m so far); ' +
        "a command of yours in /srv/projects/shop: `bun run build` (3m so far); " +
        'you, in another chat, on "write the newsletter" (2m so far); ' +
        "nero, on a scheduled run; " +
        'a mission of nix\'s "Move the shop to the new server" in /srv/nouride/private/nix/missions/msn_1 (20m so far). ' +
        "Before you write or run something where one of these is working, wait for it or work somewhere else.)",
    );
  });

  test("another person's private work is named by its kind, its folder and its time, never its words", () => {
    const { work } = workNow(
      sources({
        turns: [turn({ agentId: "nouva", gatewayId: RINA.gatewayId, chatId: "555", trigger: message({ ...RINA, chatId: "555", text: "is this lump on my arm serious?" }) })],
        jobs: (id) => (id === "nix" ? [job({ agentId: "nix", gatewayId: RINA.gatewayId, chatId: "555", command: "curl https://clinic.example/rina", senderId: RINA.senderId })] : []),
        missions: [mission()],
      }),
    );
    const note = boxNote(work, "nouva", NOW)!;
    expect(note).toContain("you, in another chat (2m so far)");
    expect(note).toContain("a command of nix's in /srv/projects/shop (3m so far)");
    expect(note).toContain("a mission of nix's in /srv/nouride/private/nix/missions/msn_1 (20m so far)");
    for (const secret of ["lump", "clinic", "Move the shop"]) expect(note).not.toContain(secret);
  });

  test("the same person on another connection is known through People", () => {
    const onWhatsApp = turn({ agentId: "nouva", gatewayId: RINA.gatewayId, chatId: "555", trigger: message({ ...RINA, chatId: "555", text: "book the dentist" }) });
    const closed = workNow(sources({ turns: [onWhatsApp] })).work;
    expect(boxNote(closed, "nouva", NOW)).not.toContain("dentist");
    const one = workNow(sources({ turns: [onWhatsApp], samePerson: () => true })).work;
    expect(boxNote(one, "nouva", NOW)).toContain('on "book the dentist"');
  });

  test("the daemon's own words are never quoted as a request, whoever reads", () => {
    const wake = turn({ agentId: "nouva", chatId: "900", trigger: message({ chatId: "900", senderId: "nouride:system", text: "[System event] job_7 ended: exit 0" }) });
    const note = boxNote(workNow(sources({ turns: [wake], samePerson: () => true })).work, "nouva", NOW)!;
    expect(note).toContain("you, in another chat (2m so far)");
    expect(note).not.toContain("System event");
  });

  test("a turn no person began reads as nobody: only this chat's own work is said in words", () => {
    const elsewhere = turn({ agentId: "nouva", chatId: "900", trigger: message({ chatId: "900", text: "write the newsletter" }) });
    const { reader: _reader, ...nobody } = sources({
      turns: [elsewhere],
      jobs: (id) => (id === "nox" ? [job({ agentId: "nox", chatId: "814", command: "bun test" })] : []),
    });
    const note = boxNote(workNow(nobody).work, "nouva", NOW)!;
    expect(note).toContain("you, in another chat (2m so far)");
    expect(note).toContain("a command of nox's in /srv/projects/shop: `bun test` (3m so far)");
  });

  test("the turn is not told of itself, of its room's turns, of its own jobs here, or of a mission as a turn", () => {
    const { work } = workNow(
      sources({
        turns: [
          turn({ agentId: "nouva", trigger: message() }),
          turn({ agentId: "nox", trigger: message() }),
          turn({ agentId: "nix", gatewayId: MISSION_GATEWAY_ID, chatId: "msn_1", trigger: message() }),
        ],
        jobs: (id) => (id === "nouva" ? [job({ chatId: "814", kind: "helper" })] : []),
      }),
    );
    expect(work).toEqual([]);
    // And a mission's own turn is not told of its mission; another agent's turn is.
    const own = sources({ me: "nix", at: { gatewayId: MISSION_GATEWAY_ID, chatId: "msn_1", room: false }, missions: [mission()] });
    expect(workNow(own).work).toEqual([]);
    expect(workNow(sources({ missions: [mission()] })).work).toHaveLength(1);
  });

  test(`${WORK_SHOWN} are named, the reading agent's first, and the rest counted`, () => {
    const many: WorkNow[] = Array.from({ length: WORK_SHOWN + 2 }, (_, index) => ({
      kind: "command" as const,
      agentId: index === WORK_SHOWN + 1 ? "nouva" : "nox",
      open: false,
      what: "",
      folder: `/srv/p${index}`,
      startedAt: NOW - (index + 1) * MIN,
    }));
    const note = boxNote(many, "nouva", NOW)!;
    expect(note.indexOf("a command of yours")).toBeLessThan(note.indexOf("a command of nox's"));
    expect(note.match(/a command of/g)).toHaveLength(WORK_SHOWN);
    expect(note).toContain("; and 2 more. Before you write");
  });

  test("nothing is said when nothing else runs", () => {
    expect(boxNote([], "nouva", NOW)).toBeNull();
    expect(workNotes(sources({ mates: [] }), NOW)).toEqual([]);
  });
});

// ── through the real pipeline ─────────────────────────────────────────────────────────────────────────────────────

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

type Body = { messages: { role: string; content: unknown }[] };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
/** The last thing said to the model in a request, past the block the harness adds after the conversation. */
const lastUser = (body: Body) => textOf(conversationOf(body.messages).filter((one) => one.role === "user").at(-1)?.content);
const system = (body: Body) => textOf(body.messages[0]?.content);

describe("on a turn's message, through the pipeline", () => {
  test("an agent asked while another is at work in the room is told so, and its prompt's cached part does not move", async () => {
    let began = false;
    // Nox's step lasts until the test lets it go: Nouva is asked, and answers, while it is held.
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const slow: [string, Tool] = [
      "slow",
      {
        requiresApproval: false,
        definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
        async execute() {
          began = true;
          await held;
          return { content: "done", isError: false };
        },
      },
    ];
    const made = await pipelineBench({
      // In the order asked: Nox's long step, Nouva's answer beside it, Nox's answer, Nouva's with nothing running.
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "Nox is on the deploy." }, { text: "Deployed." }, { text: "Nothing is running." }],
      maxAttempts: 1,
      agents: ["nouva", "nox"],
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
      gateway: new FakeGateway("telegram:nouva"),
      deps: () => ({ approvals: new AutoApprovalGate() }),
    });
    cleanup.push(made.dispose);
    made.pipeline.setTools(new Map([slow]));
    made.pipeline.attach();
    const say = (id: string, text: string) =>
      made.gateway.receive(envelope({ id, gatewayId: "telegram:nouva", chatId: "814", chatType: "group", senderName: "Gading", text, timestamp: Date.now() }));

    say("m1", "nox: deploy the shop");
    await eventually(() => began, 4_000, "Nox's long step");
    say("m2", "nouva: what is nox doing?");
    await eventually(() => made.gateway.posted.includes("Nox is on the deploy."), 4_000, "Nouva's answer beside Nox's step");
    finish();
    await made.pipeline.idle();
    say("m3", "nouva: and now?");
    await made.pipeline.idle();

    const requests = made.requests as unknown as Body[];
    const beside = requests.find((body) => lastUser(body).includes("what is nox doing?"))!;
    const after = requests.find((body) => lastUser(body).includes("and now?"))!;
    expect(lastUser(beside)).toMatch(/\(In this chat now: nox is at work on "deploy the shop" \(\d+m?s so far\)\.\)/);
    expect(lastUser(after)).not.toContain("In this chat now");
    // The cached part: the same bytes with Nox at work as with nobody.
    expect(system(beside)).toBe(system(after));
    // And the line is kept with the message as it was sent, so the next request repeats it byte for byte.
    expect(textOf(after.messages.find((one) => one.role === "user" && textOf(one.content).includes("what is nox doing?"))?.content)).toBe(lastUser(beside));
  });
});
