/**
 * One external agent's coding CLI, running (0.8.1): the process, its ACP client, and the sessions it holds — one per
 * conversation, so a Discord thread keeps its context across messages.
 *
 * One process an agent, not one a conversation: a CLI is a few hundred MB, and ACP serves many sessions on one
 * connection. A permission the CLI asks for names its session, and goes to whoever is prompting that session now.
 * What the CLI writes on stderr is kept, its last lines, for the reason an agent shows when its CLI will not start.
 */

import { VERSION } from "@/cli/version.ts";
import { AcpClient, AcpError, AUTH_REQUIRED, type CliRow, type ContentBlock, type InitializeResult, type McpServer, type NewSessionResult, type PermissionOutcome, type RequestPermissionParams, type SessionConfigOption, type SessionUpdate, type PromptAnswer, type SteerOutcome } from "@nouride/acp";
import { createLogger } from "@nouride/shared";
import type { LongLivedProcess } from "@nouride/runtime";
import type { Launch } from "./launch.ts";
import { thoughtLevel } from "./models.ts";

const log = createLogger("external-agents");

export type Spawn = (cmd: string[], opts: { agent: string; cwd: string; env: Record<string, string> }) => LongLivedProcess;

/** How many of the CLI's last stderr lines are kept. */
const STDERR_KEPT = 30;

/**
 * Why an agent's CLI cannot answer, in words for wherever its status is shown: not installed, not signed in, or what
 * it said when it failed.
 */
export function unavailableReason(row: CliRow, error: unknown, stderr: readonly string[]): string {
  const said = [error instanceof Error ? error.message : String(error ?? ""), ...stderr].join("\n");
  if (/not found|No such file|ENOENT|exit(ed with)? code 127/i.test(said)) return `${row.name} is not installed here: ${row.install}`;
  if (signedOut(row, error)) return `${row.name} is not signed in. Sign in on the agent's Brain tab`;
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  return `${row.name} did not start: ${line.slice(0, 200)}`;
}

/** The protocol's sign-in refusal, or the words a CLI uses for being signed out or not set up. */
export function signedOut(row: CliRow, error: unknown): boolean {
  if (error instanceof AcpError && error.code === AUTH_REQUIRED) return true;
  const text = error instanceof AcpError ? `${error.message} ${JSON.stringify(error.data ?? "")}` : String(error ?? "");
  return (row.signedOut ?? []).some((words) => text.includes(words));
}

type PermissionHandler = (request: RequestPermissionParams) => Promise<PermissionOutcome>;

export class CliConnection {
  private child: LongLivedProcess | null = null;
  private client: AcpClient | null = null;
  private handshake: InitializeResult | null = null;
  private readonly stderr: string[] = [];
  private readonly sessions = new Map<string, string>();
  /** What Nouride last set each session to, by session id: a change on the Brain tab is set again where it differs. */
  private readonly settings = new Map<string, { mode?: string; model?: string; effort?: string; ownEffort?: string }>();
  /** Each session's options as the CLI last said them — opened, reopened, or after one was set. */
  private readonly options = new Map<string, SessionConfigOption[]>();
  private readonly permissions = new Map<string, PermissionHandler>();
  /** The sessions turns are working in, with how many; and those let go under one, closed once it is done (0.8.8). */
  private readonly inUse = new Map<string, number>();
  private readonly closeWhenDone = new Set<string>();
  private running = 0;
  private gone: string | null = null;
  /** Sessions being reopened: what the CLI sends for one then is its history replayed, not something it says now. */
  private readonly loading = new Set<string>();
  lastUsed: number;
  /** What a session says with no prompt running — the CLI going on by itself (`own-words.ts`). */
  onOwnWords?: (sessionId: string, update: SessionUpdate) => void;

  constructor(
    readonly row: CliRow,
    readonly launch: Launch,
    readonly agentId: string,
    private readonly spawn: Spawn,
    private readonly now: () => number = Date.now,
  ) {
    this.lastUsed = now();
  }

  get info(): InitializeResult | null {
    return this.handshake;
  }

  get closed(): string | null {
    return this.gone;
  }

  get busy(): boolean {
    return this.running > 0;
  }

  /** A turn is working in one of its sessions — held from when it has one to its end (`use`). */
  get held(): boolean {
    return this.inUse.size > 0;
  }

  /** The CLI's process, while it runs. */
  get pid(): number | undefined {
    return this.gone ? undefined : this.child?.pid;
  }

  get stderrTail(): readonly string[] {
    return this.stderr;
  }

  /** Start the CLI and shake hands. Fails with what the CLI said, its stderr kept. */
  async open(): Promise<InitializeResult> {
    if (this.handshake) return this.handshake;
    const child = this.spawn(this.launch.cmd, { agent: this.agentId, cwd: this.launch.cwd, env: this.launch.env });
    this.child = child;
    const client = new AcpClient({
      transport: { send: (line) => child.writeLine(line) },
      permission: (request) => {
        const handler = this.permissions.get(request.sessionId);
        return handler ? handler(request) : Promise.resolve({ outcome: "cancelled" });
      },
      stray: (line) => this.keep(line),
      unclaimed: (sessionId, update) => {
        if (this.loading.has(sessionId)) return;
        // Working, though nobody prompted it: the idle sweep counts from its last word.
        this.lastUsed = this.now();
        this.onOwnWords?.(sessionId, update);
      },
      failed: (method, err) => log.warn("an external agent's CLI sent what Nouride could not read; it reads on", { agent_id: this.agentId, cli: this.row.id, method, error: String(err) }),
      clientInfo: { name: "nouride", version: VERSION },
    });
    this.client = client;
    void (async () => {
      try {
        for await (const line of child.lines()) client.receive(line);
      } catch {
        // The process ended mid-read: `exited` says so below.
      }
    })();
    void (async () => {
      try {
        for await (const line of child.stderrLines()) this.keep(line);
      } catch {
        // A closed stderr is never the interesting failure.
      }
    })();
    void child.exited.then((code) => {
      this.gone = `exited with code ${code}`;
      client.closed(this.gone);
      log.info("an external agent's CLI exited", { agent_id: this.agentId, cli: this.row.id, code });
    });
    this.handshake = await client.initialize();
    log.info("an external agent's CLI started", { agent_id: this.agentId, cli: this.row.id, agent: this.handshake.agentInfo?.name, version: this.handshake.agentInfo?.version });
    return this.handshake;
  }

  /**
   * The conversation's session: the one this process opened for it, else the one it kept from before (where the CLI
   * reopens sessions), else a new one — `setUp` runs on a session this process has not used yet (its mode, its model).
   */
  async session(key: string, cwd: string, kept: string | undefined, mcpServers: McpServer[], setUp: (sessionId: string, opened: NewSessionResult | null) => Promise<void>): Promise<string> {
    const client = this.need();
    const known = this.sessions.get(key);
    if (known) return known;
    if (kept && this.handshake?.agentCapabilities?.loadSession) {
      this.loading.add(kept);
      try {
        const loaded = await client.loadSession(kept, cwd, mcpServers);
        this.loading.delete(kept);
        this.offers(kept, loaded.configOptions);
        this.sessions.set(key, kept);
        await setUp(kept, null);
        return kept;
      } catch (err) {
        this.loading.delete(kept);
        // A session the CLI no longer has is not a failure: the conversation starts a new one.
        log.info("an external agent's kept session could not be reopened; starting a new one", { agent_id: this.agentId, error: String(err) });
      }
    }
    const opened = await client.newSession(cwd, mcpServers);
    this.sessions.set(key, opened.sessionId);
    this.offers(opened.sessionId, opened.configOptions);
    await setUp(opened.sessionId, opened);
    return opened.sessionId;
  }

  /** A session's options as the CLI last said them; empty before it said any. */
  optionsOf(sessionId: string): readonly SessionConfigOption[] {
    return this.options.get(sessionId) ?? [];
  }

  /** The session this process has open for a conversation, if it has one. */
  sessionOf(key: string): string | undefined {
    return this.sessions.get(key);
  }

  /**
   * The conversation's session let go, so its next message opens a new one: a turn failed in it, or the conversation
   * ended — `/new` and the rest (`conversation-end.ts`) — and the new one lists the skills switched on now, as a CLI
   * does when a session opens. Closed in the CLI where it closes one: at once where no turn is working in it, else when
   * the turn is done with it (`use`) — a `/new` between a turn's prompts closed it under the turn, and its next prompt
   * failed. By that session, not the whole CLI (0.8.8): a turn lets its own conversation's session go as it opens
   * another, on other instructions, while it holds the CLI — and with Claude Code each session is a process of its own,
   * a few hundred MB, which was kept until the idle stop.
   */
  forget(key: string): void {
    const sessionId = this.sessions.get(key);
    if (!sessionId) return;
    this.sessions.delete(key);
    this.settings.delete(sessionId);
    this.options.delete(sessionId);
    if (this.inUse.has(sessionId)) this.closeWhenDone.add(sessionId);
    else this.letGo(sessionId);
  }

  /** A turn's hold on the session it works in, from when it has one to its end; released once (0.8.8). */
  use(sessionId: string): () => void {
    this.inUse.set(sessionId, (this.inUse.get(sessionId) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.inUse.get(sessionId) ?? 1) - 1;
      if (left > 0) return void this.inUse.set(sessionId, left);
      this.inUse.delete(sessionId);
      if (this.closeWhenDone.delete(sessionId)) this.letGo(sessionId);
    };
  }

  /**
   * A session closed in the CLI, where it closes them. Not in one that has exited — asking it threw, out of a failed
   * turn's handling and out of `/new` (0.8.1).
   */
  private letGo(sessionId: string): void {
    if (this.gone || !this.handshake?.agentCapabilities?.sessionCapabilities?.close) return;
    this.need()
      .closeSession(sessionId)
      .catch((err: unknown) => log.info("an external agent's CLI did not close a session", { agent_id: this.agentId, error: String(err) }));
  }

  /**
   * A session opened in `cwd` and left unprompted: a CLI that is not signed in refuses it, and one that opens it says
   * what it offers. What the Brain tab's sign-in check asks, and a new version's handshake check reads its modes from
   * (`cli-update.ts`); no model is called.
   */
  async probe(cwd: string): Promise<NewSessionResult> {
    const opened = await this.need().newSession(cwd);
    this.lastUsed = this.now();
    // Let go at once: each check left a session open in the agent's live CLI, and a session holds memory there.
    this.letGo(opened.sessionId);
    return opened;
  }

  /**
   * The session set to the mode, model and effort the pack names now, each where it differs from what it was last set
   * to: set only when a session opened, a preset changed on the Brain tab never reached a chat already going — one moved
   * off "Free in its folder" ran unasked until the CLI went quiet (0.8.1). `own`: the model is the CLI's own default, set
   * back only where Nouride had set another.
   *
   * The effort after the model, as the session's `thought_level` option offers it then: a CLI whose efforts follow its
   * model offers another list once the model changes. One it does not offer leaves the CLI's own, said once a session
   * and model rather than mapped to a near one.
   */
  async settle(sessionId: string, want: { mode?: string | undefined; model?: string | undefined; own?: boolean; effort?: string | undefined; note: (line: string) => void }): Promise<void> {
    const was = this.settings.get(sessionId) ?? {};
    this.settings.set(sessionId, was);
    if (want.mode && was.mode !== want.mode) {
      await this.need().setMode(sessionId, want.mode).then(() => void (was.mode = want.mode), (err: unknown) => want.note(`${this.row.name} kept its own mode: ${String(err)}`));
    }
    if (want.model && was.model !== want.model && (!want.own || was.model !== undefined)) {
      await this.need().setConfigOption(sessionId, "model", want.model).then(
        (set) => {
          was.model = want.own ? undefined : want.model;
          this.offers(sessionId, set.configOptions);
          delete was.effort;
          delete was.ownEffort;
        },
        (err: unknown) => want.note(`${this.row.name} kept its own model: ${String(err)}`),
      );
    }
    if (want.effort && was.effort !== want.effort) {
      const option = thoughtLevel(this.options.get(sessionId));
      if (!option?.options?.some((entry) => entry.value === want.effort)) {
        was.effort = want.effort;
        want.note(`${this.row.name} kept its own effort: ${want.effort} not offered`);
      } else if (option.currentValue === want.effort) {
        was.effort = want.effort;
      } else {
        const own = option.currentValue;
        await this.need().setConfigOption(sessionId, option.id, want.effort).then(
          (set) => {
            // What the CLI thought at before Nouride set one, for when nothing names one again.
            if (was.ownEffort === undefined && typeof own === "string") was.ownEffort = own;
            was.effort = want.effort;
            this.offers(sessionId, set.configOptions);
          },
          (err: unknown) => want.note(`${this.row.name} kept its own effort: ${String(err)}`),
        );
      }
    } else if (!want.effort && was.effort !== undefined) {
      // Nothing names one any more (`/effort default` in a chat whose pack sets none): the CLI's own back, rather than
      // the chat's last level kept for the rest of the session.
      const option = thoughtLevel(this.options.get(sessionId));
      const own = was.ownEffort;
      delete was.effort;
      delete was.ownEffort;
      if (option && own && option.currentValue !== own && option.options?.some((entry) => entry.value === own)) {
        await this.need().setConfigOption(sessionId, option.id, own).then(
          (set) => this.offers(sessionId, set.configOptions),
          (err: unknown) => want.note(`${this.row.name} kept the effort it was set to: ${String(err)}`),
        );
      }
    }
  }

  /** A turn's hold on the CLI, from its start to its end: the idle sweep stops none that is held. Released once. */
  hold(): () => void {
    this.running += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.running -= 1;
      this.lastUsed = this.now();
    };
  }

  /**
   * A session going on by itself, followed by a turn: busy, as a prompt is, and what it asks permission for goes to
   * that turn. Returns the follow's end; released once.
   */
  follow(sessionId: string, onPermission: PermissionHandler): () => void {
    this.running += 1;
    this.permissions.set(sessionId, onPermission);
    let following = true;
    return () => {
      if (!following) return;
      following = false;
      if (this.permissions.get(sessionId) === onPermission) this.permissions.delete(sessionId);
      this.running -= 1;
      this.lastUsed = this.now();
    };
  }

  async prompt(sessionId: string, blocks: ContentBlock[], onUpdate: (update: SessionUpdate) => void, onPermission: PermissionHandler): Promise<PromptAnswer> {
    const client = this.need();
    this.running += 1;
    this.permissions.set(sessionId, onPermission);
    try {
      return await client.promptAnswer(sessionId, blocks, onUpdate);
    } finally {
      this.permissions.delete(sessionId);
      this.running -= 1;
      this.lastUsed = this.now();
    }
  }

  /** Words for the prompt running in a session (`AcpClient.steer`); `failed` where the CLI is gone. */
  async steer(sessionId: string, blocks: ContentBlock[]): Promise<SteerOutcome> {
    return this.client && !this.gone ? await this.client.steer(sessionId, blocks) : "failed";
  }

  cancel(sessionId: string): void {
    this.client?.cancel(sessionId);
  }

  /** Stop the CLI: its input ended, then a signal, as an MCP server is stopped. `why` is what its calls in flight fail with. */
  async close(why = "stopped"): Promise<void> {
    const child = this.child;
    if (!child || this.gone) return;
    this.gone = why;
    this.client?.closed(why);
    child.endInput();
    const quit = await Promise.race([child.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))]);
    if (!quit) child.kill("SIGTERM");
  }

  /** A session's options as the CLI said them; an answer without them leaves the last it said. */
  private offers(sessionId: string, options: SessionConfigOption[] | null | undefined): void {
    if (options) this.options.set(sessionId, options);
  }

  private need(): AcpClient {
    if (!this.client || this.gone) throw new AcpError(-32099, `${this.row.name} is not running${this.gone ? ` (${this.gone})` : ""}`);
    return this.client;
  }

  private keep(line: string): void {
    this.stderr.push(line.slice(0, 500));
    if (this.stderr.length > STDERR_KEPT) this.stderr.shift();
  }
}
