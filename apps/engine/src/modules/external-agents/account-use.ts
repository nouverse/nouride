/**
 * A coding-CLI account's use, asked of its maker at any time, not only said while an agent works on it.
 *
 * What a CLI says of the account's use comes with a turn (`use.ts`), and a CLI that says nothing leaves it unknown
 * until a message is refused. The row says how its account's use is asked for (`CliRow.readUse`): an address its maker
 * answers with the account's own token, the request the CLI's own usage command makes, or a method of the CLI's own
 * over a connection that is open. The token is read where the CLI keeps it, as the agent whose folder it is in, used
 * for that one request and kept nowhere; never for a model call. Answers are parsed into one shape (`CliUse`) by the
 * row, so the Models page shows every CLI's the same way and the account rotation reads it before a turn is refused.
 *
 * Read as the account is signed in: an account signed in once for all its agents (a shared token) is read once, with
 * that token; where each agent signs in by itself (Codex, Cursor, a Claude agent signed in alone), each agent's own
 * sign-in is its own use, read from its folder alone, and never said of another agent's.
 *
 * A read is taken as it stands for five minutes, a failed one too: a page opened again and again asks once.
 */

import { join } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import type { CliRow, CliUse, UseReader } from "@nouride/acp";

const log = createLogger("external-agents.use");

/** How long a read is taken as it stands. A choice of this code: a window's share moves slowly, an hour's is minutes. */
export const USE_FRESH_MS = 5 * 60_000;
/** How long a maker, or a CLI, is given to answer. */
const ASK_MS = 10_000;

/** An account's use, and when it was read or said; `said`: as its CLI said it while it worked, not read of its maker. */
export interface UseSeen {
  use: CliUse;
  at: number;
  said?: true;
}

/** A CLI running on the account: asked a method of its own, and what it last said of the account's use. */
export interface RunningOnAccount {
  ask(method: string, timeoutMs: number): Promise<unknown>;
  accountUse: UseSeen | null;
}

export interface AccountUseDeps {
  /** A shared account's kept token (`CliAccounts.token`). */
  sharedToken: (row: CliRow, account: string) => string | undefined;
  /** The folder an agent's CLI keeps its sign-in in for an account: its profile folder, else its HOME. */
  folderOf: (row: CliRow, agentId: string, account: string) => string;
  /** A file's text, read as the agent whose file it is; undefined where it is not there or cannot be read. */
  readAs: (agentId: string, path: string) => Promise<string | undefined>;
  /** The CLIs running on the account now; with `agentId`, that agent's alone. */
  running: (cli: string, account: string, agentId?: string) => RunningOnAccount[];
  fetch?: typeof fetch;
  now?: () => number;
}

type FileAt = { file: string; path: readonly string[] };

/** Where a read is kept: the account's, or one agent's own sign-in on it. */
const keyOf = (row: CliRow, account: string, agent: string | undefined) => `${row.id}|${account}${agent === undefined ? "" : `|${agent}`}`;
type HttpReader = Extract<UseReader, { kind: "http" }>;

const valueAt = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((at, key) => (at && typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined), value);

export class AccountUses {
  private readonly read = new Map<string, { seen: UseSeen | null; at: number }>();
  private readonly asking = new Map<string, Promise<UseSeen | null>>();

  constructor(private readonly deps: AccountUseDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * The account's use: asked of its maker where its row says how and the last read is five minutes old, else the last
   * read; and what a CLI on it said while it worked, where that is newer. `agent`: that agent's own sign-in on the
   * account, where each signs in by itself; absent, the account's shared one. Null: not known.
   */
  async of(row: CliRow, account: string, agent?: string): Promise<UseSeen | null> {
    const key = keyOf(row, account, agent);
    const last = this.read.get(key);
    const read = row.readUse && (!last || this.now() - last.at >= USE_FRESH_MS) ? await this.ask(key, row, row.readUse, account, agent) : (last?.seen ?? null);
    return this.newer(read, row, account, agent);
  }

  /** What is known of it now, asking nobody: the last read, or what a CLI on it said since. */
  known(row: CliRow, account: string, agent?: string): UseSeen | null {
    return this.newer(this.read.get(keyOf(row, account, agent))?.seen ?? null, row, account, agent);
  }

  private newer(read: UseSeen | null, row: CliRow, account: string, agent: string | undefined): UseSeen | null {
    const said = this.deps
      .running(row.id, account, agent)
      .map((cli) => cli.accountUse)
      .reduce<UseSeen | null>((newest, seen) => (seen && (!newest || seen.at > newest.at) ? seen : newest), null);
    return said && (!read || said.at > read.at) ? { ...said, said: true } : read;
  }

  /** One read at a time for an account: a second asker waits for the first's answer. */
  private ask(key: string, row: CliRow, reader: UseReader, account: string, agent: string | undefined): Promise<UseSeen | null> {
    const going = this.asking.get(key);
    if (going) return going;
    const asking = this.readOnce(row, reader, account, agent)
      .catch((err: unknown) => {
        // The error's words, never the request's: its headers hold the token.
        log.info("an account's use could not be read", { cli: row.id, account, error: err instanceof Error ? err.name : "error" });
        return null;
      })
      .then((use) => {
        const at = this.now();
        const seen = use ? { use, at } : null;
        this.read.set(key, { seen, at });
        return seen;
      })
      .finally(() => this.asking.delete(key));
    this.asking.set(key, asking);
    return asking;
  }

  private async readOnce(row: CliRow, reader: UseReader, account: string, agent: string | undefined): Promise<CliUse | null> {
    if (reader.kind === "acp") {
      const cli = this.deps.running(row.id, account, agent)[0];
      return cli ? reader.parse(await cli.ask(reader.method, ASK_MS), this.now()) : null;
    }
    const signedIn = await this.credentials(row, reader, account, agent);
    if (!signedIn) return null;
    const res = await (this.deps.fetch ?? fetch)(reader.url, {
      method: reader.method,
      headers: { accept: "application/json", ...reader.headers, ...signedIn.headers, authorization: `Bearer ${signedIn.token}` },
      ...(reader.body === undefined ? {} : { body: reader.body }),
      signal: AbortSignal.timeout(ASK_MS),
    });
    if (!res.ok) {
      log.info("an account's use was not read: its maker refused", { cli: row.id, account, status: res.status });
      return null;
    }
    return reader.parse(await res.json(), this.now());
  }

  /**
   * The token, and the headers read beside it: for the shared sign-in, its kept token where the row names its variable;
   * for one agent's own, that agent's sign-in files, and no other's.
   */
  private async credentials(row: CliRow, reader: HttpReader, account: string, agent: string | undefined): Promise<{ token: string; headers: Record<string, string> } | null> {
    for (const from of reader.token) {
      if ("env" in from) {
        const token = agent === undefined && from.env === row.sharedLogin?.env ? this.deps.sharedToken(row, account) : undefined;
        if (token) return { token, headers: {} };
        continue;
      }
      for (const agentId of agent === undefined ? [] : [agent]) {
        const files = new Map<string, Promise<unknown>>();
        const valueOf = async (at: FileAt): Promise<string | undefined> => {
          if (!files.has(at.file)) files.set(at.file, this.json(agentId, join(this.deps.folderOf(row, agentId, account), at.file)));
          const value = valueAt(await files.get(at.file), at.path);
          return typeof value === "string" && value !== "" ? value : undefined;
        };
        const token = await valueOf(from);
        if (!token) continue;
        const headers: Record<string, string> = {};
        for (const [name, at] of Object.entries(reader.fileHeaders ?? {})) {
          const value = await valueOf(at);
          if (value) headers[name] = value;
        }
        return { token, headers };
      }
    }
    return null;
  }

  private async json(agentId: string, path: string): Promise<unknown> {
    const text = await this.deps.readAs(agentId, path);
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }
}
