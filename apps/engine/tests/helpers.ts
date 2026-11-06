/** Fixtures shared by the engine tests: agent packs, a fake gateway, a fake provider. */

import { TransientSecrets } from "@nouride/secrets";
import { join } from "node:path";
import type {
  ButtonPress,
  ChatMessage,
  GlobalConfig,
  Gateway,
  GatewayEvent,
  GatewayName,
  GatewayStatus,
  LoadedAgent,
  MessageButton,
  MessageEnvelope,
  OutboundMessage,
  PressAnswer,
  ApprovalRequest,
} from "@nouride/shared";
import { hashPassword, openDatabase, passwordNeedsRehash, verifyPassword, writeTextFile, type SqliteDb } from "@nouride/runtime";
import type { PasswordHasher } from "@/modules/users/users.store.ts";
import { migrate } from "@/db/index.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import type { ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import type { ChildEnv } from "@/modules/tools/exec-secrets.ts";

export { tempDir } from "./temp-dirs.ts";

/**
 * Point every install path at a throwaway directory.
 *
 * All four default *inside the install* and resolve against the cwd, which under `bun test` is the
 * repo — so a test that leaves any of them alone writes into the developer's working tree. That has
 * happened twice: first `.nouride/workspace/private/{nouva,nox}` appeared in a checkout nothing had
 * run a daemon in, then `.nouride/memories` filled up with transcripts from the hook tests.
 *
 * One function so the next path added to `[daemon]` is fixed in one place rather than in every
 * harness that forgot.
 */
export function isolateInstallPaths(config: GlobalConfig, dataDir: string): void {
  config.daemon.dataDir = dataDir;
  config.daemon.workspaceDir = join(dataDir, "workspace");
  config.memory.dir = join(dataDir, "memory");
}

export interface AgentPackSpec {
  id: string;
  identity?: string;
  soul?: string;
  memory?: string;
  configToml?: string;
}

export async function writeAgentPack(agentsDir: string, spec: AgentPackSpec): Promise<void> {
  await writeTextFile(
    join(agentsDir, spec.id, "IDENTITY.md"),
    spec.identity ?? `# IDENTITY\n- Name: ${spec.id}\n`,
  );
  if (spec.soul) await writeTextFile(join(agentsDir, spec.id, "SOUL.md"), spec.soul);
  if (spec.memory) await writeTextFile(join(agentsDir, spec.id, "MEMORY.md"), spec.memory);
  if (spec.configToml) {
    await writeTextFile(join(agentsDir, spec.id, "config.toml"), spec.configToml);
  }
}

/** Minimal `LoadedAgent`, for tests that need an agent without touching disk. */
export function fakeAgent(overrides: Partial<LoadedAgent> = {}): LoadedAgent {
  return {
    config: {
      id: "nouva",
      displayName: "Nouva",
      emoji: "🌌",
      enabled: true,
      llm: { provider: "anthropic", model: "claude-sonnet-4-20250514", maxTokens: 4096, temperature: 0.7 },
      channels: {},
      tools: { enabled: [], approvalRequired: [], blocked: [] },
      skills: {},
      mcpServers: [],
      senderAllowlist: [],
      execSecrets: [],
      skillRoots: [],
      workspaceRoots: [],
      ...overrides.config,
    },
    persona: { identity: "# IDENTITY\n- Name: Nouva\n", ...overrides.persona },
    skills: overrides.skills ?? [],
    dir: overrides.dir ?? "/tmp/nouva",
    loadedAt: overrides.loadedAt ?? 1,
  };
}

export interface EnvelopeOverrides extends Partial<MessageEnvelope> {}

export function envelope(overrides: EnvelopeOverrides = {}): MessageEnvelope {
  return {
    id: "m1",
    timestamp: 1_700_000_000_000,
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    senderId: "user-1",
    senderName: "Gading",
    text: "hello",
    raw: {},
    ...overrides,
  };
}

/**
 * Gateway that records instead of connecting.
 *
 * Implements the real interface, so a test drives the pipeline exactly as a platform would:
 * push an envelope in, read the replies out.
 */
export class FakeGateway implements Gateway {
  /**
   * Which progress style this stand-in claims. See `Gateway.progressStyle`.
   *
   * Settable rather than fixed at construction: the interesting assertions are about one platform
   * behaving differently from another, and a test that has to build a second gateway to say so tends
   * not to get written.
   */
  progressStyle: "live" | "summary" = "live";

  /** Settable rather than derived, like `progressStyle` — see `Gateway.selfId`. */
  selfId?: string;
  /** Settable, like `selfId` — see `Gateway.selfMention`. */
  selfMention?: string;
  /** Settable, like `selfMention` — see `Gateway.formatting`. */
  formatting?: string;
  /** Settable: Telegram's is false, and a room there behaves differently — see `Gateway.echoesOwnMessages`. */
  echoesOwnMessages?: boolean;
  /** Settable: whether a message can carry buttons — see `Gateway.buttons` (G11). */
  buttons?: boolean;
  /** Settable: the platform's name for a room — see `Gateway.roomTitle` (0.7.24). Absent, the capability is. */
  roomTitle?: (chatId: string) => Promise<string | undefined>;
  /** Settable: whether this connection's account can read a room — see `Gateway.sees` (0.8.12). Absent, the capability is. */
  sees?: (chatId: string) => boolean | undefined;

  readonly sent: OutboundMessage[] = [];
  readonly typing: string[] = [];
  status: GatewayStatus = "connected";

  private messageHandlers: ((env: MessageEnvelope) => void)[] = [];
  private eventHandlers: ((event: GatewayEvent) => void)[] = [];

  constructor(
    readonly id = "telegram:main",
    readonly platform: GatewayName = "telegram",
  ) {}

  async start(): Promise<void> {
    this.status = "connected";
  }

  async stop(): Promise<void> {
    this.status = "disconnected";
  }

  /**
   * Set to make `send` throw, which is what a bot that was never invited to the channel looks like:
   * Discord answers "Missing Access" and nothing in config could have predicted it.
   */
  failSend?: Error;

  /** Each message's text as it was sent, before any edit rewrote it in `sent` — what the chat said at that moment. */
  readonly posted: string[] = [];

  async send(msg: OutboundMessage): Promise<string[]> {
    if (this.failSend) throw this.failSend;
    this.sent.push(msg);
    this.posted.push(msg.text);
    /**
     * Stable and guessable, so a test can assert on reply routing without reaching into the fake —
     * and prefixed with the instance, because a real platform's message ids are unique across the
     * bots on it.
     *
     * Two fakes both numbering from 1 collided, and the record of who wrote what is keyed by platform:
     * one id then mapped to two different authors. It made a handover test fail for a reason that had
     * nothing to do with the code under test, and it would have hidden a real one.
     */
    return [`${this.id}#${this.sent.length}`];
  }

  async setTyping(chatId: string): Promise<void> {
    this.typing.push(chatId);
  }

  /** Edits applied in order, so a test can read what the progress line said over time. */
  readonly edits: { messageId: string; text: string }[] = [];

  async editMessage(_chatId: string, messageId: string, text: string): Promise<boolean> {
    const index = Number(messageId.slice(messageId.lastIndexOf("#") + 1)) - 1;
    const target = this.sent[index];
    if (!target) return false;
    target.text = text;
    this.edits.push({ messageId, text });
    return true;
  }

  onMessage(handler: (env: MessageEnvelope) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * The last command list this gateway was asked to publish, or null if it never was.
   *
   * Recorded rather than sent, like everything else here — the point of the fake is that a test can
   * read what the platform *would* have been told.
   */
  syncedCommands: { command: string; description: string }[] | null = null;

  async syncCommands(
    commands: { command: string; description: string }[],
  ): Promise<{ synced: number }> {
    this.syncedCommands = commands;
    return { synced: commands.length };
  }

  onEvent(handler: (event: GatewayEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  private pressHandler?: (press: ButtonPress) => Promise<PressAnswer>;

  onPress(handler: (press: ButtonPress) => Promise<PressAnswer>): void {
    this.pressHandler = handler;
  }

  /**
   * Somebody presses a button under message `messageId` — as the platform would hand it over — and the answer is carried
   * out as an adapter does: a settled message rewritten, its buttons gone. What the presser alone was told comes back.
   */
  async press(press: Omit<ButtonPress, "gatewayId"> & { gatewayId?: string }): Promise<PressAnswer> {
    const pressed = { gatewayId: this.id, ...press };
    const answer = (await this.pressHandler?.(pressed)) ?? {};
    if (answer.settled) await this.settleButtons(pressed.chatId, pressed.messageId, answer.settled);
    return answer;
  }

  /** Messages rewritten as settled, in order — see `Gateway.settleButtons`. */
  readonly settled: { messageId: string; text: string }[] = [];

  async settleButtons(_chatId: string, messageId: string, text: string, keep: readonly MessageButton[] = []): Promise<boolean> {
    const target = this.sent[Number(messageId.slice(messageId.lastIndexOf("#") + 1)) - 1];
    if (!target) return false;
    target.text = text;
    if (keep.length > 0) target.buttons = [...keep];
    else delete target.buttons;
    this.settled.push({ messageId, text });
    return true;
  }

  /** Simulate an inbound message from the platform. */
  receive(env: MessageEnvelope): void {
    for (const handler of this.messageHandlers) handler(env);
  }

  emit(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  lastText(): string | undefined {
    return this.sent.at(-1)?.text;
  }
}

/**
 * Scripted OpenAI-compatible responses, in order, delivered as **SSE**.
 *
 * SSE and not JSON because `llm.streaming.enabled` defaults to true, so that is the code path
 * a real deployment takes. A JSON-returning double would have the stream parser find no
 * events and quietly produce an empty answer — which is exactly the bug this shape catches.
 *
 * Returns a `fetchImpl` for `HttpDeps`, so the request mapping in `@nouride/llm` runs for real:
 * a double at the provider level would skip the layer most likely to be wrong.
 *
 * `GET …/models` is the endpoint's listing, which the daemon asks for on its own (`llm/catalog.ts`): answered with
 * `models` — none, unless a test says — and neither recorded in `requests` nor counted as a turn.
 */
export function scriptedOpenAI(
  /**
   * `hang`: no answer at all — the request is held until it is aborted, and then fails as `fetch` does.
   * `promptTokens`: the input the provider reports for the request, 10 when unsaid.
   */
  turns: { text?: string; toolCalls?: { id: string; name: string; args: unknown }[]; hang?: boolean; promptTokens?: number }[],
  options: { models?: Record<string, unknown>[] } = {},
): { fetchImpl: typeof fetch; requests: any[] } {
  const requests: any[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const asked = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if ((init?.method ?? "GET") === "GET" && /\/models$/.test(asked)) {
      return new Response(JSON.stringify({ data: options.models ?? [] }), { headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const turn = turns[Math.min(index, turns.length - 1)];
    index += 1;

    if (turn?.hang) {
      return await new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    }

    // A non-streaming request (the executor's wrap-up call withholds tools and streaming)
    // still has to be answered in its own format.
    if (!body.stream) {
      return new Response(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: turn?.text ?? "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: turn?.promptTokens ?? 10, completion_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    const events: string[] = [];
    if (turn?.text) {
      // Split across two deltas, as a real stream would.
      const half = Math.ceil(turn.text.length / 2);
      for (const piece of [turn.text.slice(0, half), turn.text.slice(half)]) {
        events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
    }
    for (const [callIndex, call] of (turn?.toolCalls ?? []).entries()) {
      events.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: callIndex,
                    id: call.id,
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    }
    events.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: turn?.toolCalls?.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: turn?.promptTokens ?? 10, completion_tokens: 5 },
      })}\n\n`,
      "data: [DONE]\n\n",
    );

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });

    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

export const noSleep = async (): Promise<void> => {};

/**
 * argon2id at its lowest useful cost, for a `UserStore` in a test: half a millisecond a hash where the real parameters
 * take about 20 ms. A login rate-limit test signs in forty times. `crypto.test.ts` keeps the real parameters. A hash at
 * this cost is current for this hasher, so a sign-in in a test is not followed by a re-hash.
 */
const CHEAP_COST = { memoryCost: 1024, timeCost: 1 };
export const cheapPasswords: PasswordHasher = {
  hash: (password) => hashPassword(password, CHEAP_COST),
  verify: verifyPassword,
  needsRehash: (hash) => passwordNeedsRehash(hash, CHEAP_COST),
};

/** Waiting in a test, as `wait.ts` says; re-exported so the engine's tests keep one place to import from. */
export { eventually, sleep } from "./wait.ts";

export function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

/**
 * Every tool name the daemon can build, with every optional dependency present.
 *
 * One source, deliberately. There were two, and the difference is why a real omission went unseen:
 * a test asserting "the wizard gets every tool the daemon can offer" built its comparison registry
 * without `reflection`, so `skill_improve` was absent from *both* sides and the assertion passed
 * while the first agent on every fresh install could not raise a skill draft.
 *
 * Every option below gates a tool's inclusion rather than its behaviour — `web_search` needs a
 * backend, `skill_improve` needs the reflection loop, `person_record` needs the people writer — so
 * this is the widest set that exists. Stubs, because nothing is called: only the keys are read.
 */
export function everyBuiltinToolName(): string[] {
  const stub = (() => undefined) as never;
  return [
    ...createBuiltinTools({
      security: DEFAULT_CONFIG.security,
      web: { search: { backend: "brave", apiKey: "x" } } as never,
      sessionStatus: stub,
      runSubagent: stub,
      askAgent: { run: stub } as never,
      harness: { registry: stub, providers: () => [], agentsDir: "/tmp/agents" } as never,
      reflection: {} as never,
      skillHub: {} as never,
      sendFile: { send: stub } as never,
      memory: {} as never,
      nourideCli: { installDir: "/srv/nouride", command: "nouride" },
      people: {} as never,
      heldSecrets: new TransientSecrets(),
      secretKeeping: { has: stub, keep: stub, bind: stub, changeFields: stub },
    }).keys(),
  ];
}

/**
 * A `ChildEnv` for a test: every command is handed `values` — or only those `bound` says, as `[security.exec_secrets]`
 * binds them (S6). The names handed are the variables lower-cased, the way a pack names its secrets.
 */
export function childEnvOf(values: Record<string, string>, bound: (argv: readonly string[] | null) => boolean = () => true): ChildEnv {
  return Object.assign(() => ({ ...values }), {
    forCommand: (_agentId: string, argv: readonly string[] | null) =>
      bound(argv) ? { env: { ...values }, secrets: Object.keys(values).map((name) => name.toLowerCase()), bound: [] } : { env: {}, secrets: [], bound: [] },
  });
}

/**
 * The daemon's own state rows (`daemon_state`) over a database of the schema that ships, in memory: what the paused
 * agents, the alert cooldowns and the external agents' sessions are kept in. One per test that wants a restart to read
 * back what the last process wrote: two services handed the same rows are the same data directory.
 */
export function stateRows(): DaemonStateStore {
  const db = openDatabase(":memory:");
  // Synchronous inside: `migrate` awaits nothing, so the table is there when this returns.
  void migrate(db);
  return new DaemonStateStore(db);
}

/** The turn store the daemon runs — records in `turn_records`, steps in the event stream — over one database. */
export function turnStore(db: SqliteDb): EventedTurnStore {
  // Strict: every test that writes through it holds the daemon's writers to the contract (`eventProblems`).
  return new EventedTurnStore(db, new EventStore(db, Date.now, { strict: true }));
}

/**
 * `db`, counting its commits: each outermost transaction is one, and so is each write made outside any — SQLite's
 * autocommit. Each commit is listed as the writes in it, `"UPDATE turn_records"`, `"INSERT events:tool_done"` — an
 * event with its kind, the stream being what these tests are about — so a test can say which rows went out together.
 * Reads are not commits and are not listed.
 */
export function countingDb(db: SqliteDb): { db: SqliteDb; commits: string[][] } {
  const commits: string[][] = [];
  let open: string[] | null = null;
  let depth = 0;
  const write = (sql: string): string | null => {
    const match = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql);
    return match ? `${match[1]!.split(/\s+/)[0]!.toUpperCase()} ${match[2]}` : null;
  };
  const counted: SqliteDb = {
    ...db,
    transaction: <T>(fn: () => T): T => {
      if (depth === 0) open = [];
      depth += 1;
      try {
        return db.transaction(fn);
      } finally {
        depth -= 1;
        if (depth === 0 && open) {
          if (open.length > 0) commits.push(open);
          open = null;
        }
      }
    },
    prepare: <T>(sql: string) => {
      const statement = db.prepare<T>(sql);
      const what = write(sql);
      return {
        all: (...params: unknown[]) => statement.all(...params),
        get: (...params: unknown[]) => statement.get(...params),
        run: (...params: unknown[]) => {
          const result = statement.run(...params);
          const said = what === "INSERT events" && typeof params[5] === "string" ? `${what}:${params[5]}` : what;
          if (said && open) open.push(said);
          else if (said) commits.push([said]);
          return result;
        },
      };
    },
  };
  return { db: counted, commits };
}


/**
 * A gate that approves everything. A test double: it lived in `modules/tools/approval.ts`, where the daemon never used
 * it — a gate that approves all is a code change someone reviews, not something production should have one import away.
 */
export class AutoApprovalGate implements ApprovalGate {
  readonly available = true;

  constructor(private readonly by = "auto") {}

  async request(): Promise<ApprovalOutcome> {
    return { status: "approved", by: this.by, decision: "allow-once" };
  }

  pending(): ApprovalRequest[] {
    return [];
  }

  expireAll(): number {
    return 0;
  }
}

/** A gate that is not there: every ask is refused as unavailable, the way a process with no chat surface answers. */
export class UnavailableApprovalGate implements ApprovalGate {
  readonly available = false;

  async request(ask: { tool: string; reason: string }): Promise<ApprovalOutcome> {
    return {
      status: "unavailable",
      reason: `Tool "${ask.tool}" needs approval and no approval gate is wired up in this process. Reason given: ${ask.reason}.`,
    };
  }

  pending(): ApprovalRequest[] {
    return [];
  }

  expireAll(): number {
    return 0;
  }
}

/**
 * A request's messages as the conversation ends: the daemon's tail — who is speaking, the work notes — left off. On an
 * OpenAI-compatible wire it is sent as one more user message after the conversation (`ChatParams.tail`), so a test that
 * reads "the last message" as the question, or as the tool result it answers, reads this instead.
 */
export function conversationOf<T extends { role: string; content?: unknown }>(messages: readonly T[]): T[] {
  const last = messages.at(-1);
  const tail = last?.role === "user" && typeof last.content === "string" && (last.content.startsWith("<<<NOURIDE:DYNAMIC>>>") || last.content.startsWith("WORK NOTES"));
  return tail ? messages.slice(0, -1) : [...messages];
}
