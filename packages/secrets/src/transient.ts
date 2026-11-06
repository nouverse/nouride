/**
 * Credentials a person sent in a message, held in memory under a handle — and nowhere else.
 *
 * A credential is taken out of a message as it arrives and a handle put in its place, `$TMP_SECRET_…`, which is what
 * everything after reads, stores and sends to a model. The value is here: not in the database, a log or a transcript.
 * So it lasts as long as the process does, and an hour at most — long enough for the work the message was about;
 * saving it as a named secret keeps it for good.
 *
 * A handle is a shell variable on purpose. A command that says `"$TMP_SECRET_…"` is given the value in its environment,
 * the way a named secret reaches one, and the command line never holds it.
 */

import { randomHex } from "@nouride/runtime";

/** `$TMP_SECRET_` and twelve hex digits: what a message holds in place of a credential. */
const HANDLE = /\$TMP_SECRET_[0-9A-F]{12}(?![0-9A-Za-z_])/g;

/** The handles `text` names, each once, `$` and all. */
export function handlesIn(text: string): string[] {
  return [...new Set(text.match(HANDLE) ?? [])];
}

/** One credential held: its value, what it looked like, and the conversation it may be used in. */
export interface HeldSecret {
  /** `TMP_SECRET_…` — the variable a command finds it in. A message says it with a `$` in front. */
  name: string;
  value: string;
  /** What it looked like: "a GitHub token". */
  label: string;
  /** Where it may be used: opaque here — the engine's key for one conversation. */
  scope: string;
  /** Who sent it. */
  from: string;
  /** When it was last sent: an hour from then, it is gone. */
  at: number;
}

export class TransientSecrets {
  private readonly held = new Map<string, HeldSecret>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    // A ceiling, as every table the daemon keeps in memory has: a chat that pastes keys all day holds the newest. 4096,
    // not the 256 it was: a printed credential file holds every value of it (`printed.ts`), and a few 40-line `.env`s
    // across a few chats would have pushed out the handles an agent was in the middle of using. A few hundred KB at most.
    this.max = options.max ?? 4096;
    this.now = options.now ?? Date.now;
  }

  /**
   * Hold `value` for `scope`, and say the handle to put in its place. The same value sent again in the same
   * conversation is the same handle, and its hour starts over.
   */
  hold(value: string, meta: { scope: string; label: string; from: string }): string {
    this.sweep();
    const at = this.now();
    for (const secret of this.held.values()) {
      if (secret.scope === meta.scope && secret.value === value) {
        this.held.delete(secret.name);
        this.held.set(secret.name, { ...secret, at });
        return `$${secret.name}`;
      }
    }
    let name = `TMP_SECRET_${randomHex(6).toUpperCase()}`;
    while (this.held.has(name)) name = `TMP_SECRET_${randomHex(6).toUpperCase()}`;
    this.held.set(name, { name, value, label: meta.label, scope: meta.scope, from: meta.from, at });
    // Oldest first: a Map keeps the order things were set in, and `hold` sets a refreshed one last.
    while (this.held.size > this.max) this.held.delete(this.held.keys().next().value!);
    return `$${name}`;
  }

  /** What a handle holds — in its own conversation, while it lasts. `$` or not. */
  get(handle: string, scope: string): HeldSecret | undefined {
    this.sweep();
    const secret = this.held.get(handle.replace(/^\$/, ""));
    return secret?.scope === scope ? secret : undefined;
  }

  /** Forget a handle: saved for good, or not a secret after all. */
  release(handle: string): void {
    this.held.delete(handle.replace(/^\$/, ""));
  }

  /** What `scope` holds, without the values: each handle, what it looked like, and when it goes. */
  heldIn(scope: string): { handle: string; label: string; expiresAt: number }[] {
    this.sweep();
    return [...this.held.values()].filter((secret) => secret.scope === scope).map((secret) => ({ handle: `$${secret.name}`, label: secret.label, expiresAt: secret.at + this.ttlMs }));
  }

  /** Every value held for `scope`, by variable — what a command in that conversation is masked against. */
  valuesFor(scope: string): Record<string, string> {
    this.sweep();
    return Object.fromEntries([...this.held.values()].filter((secret) => secret.scope === scope).map((secret) => [secret.name, secret.value]));
  }

  /** Every value held, by variable — what anything leaving the daemon is masked against, whichever conversation it is. */
  values(): Record<string, string> {
    this.sweep();
    return Object.fromEntries([...this.held.values()].map((secret) => [secret.name, secret.value]));
  }

  private sweep(): void {
    const expired = this.now() - this.ttlMs;
    for (const [name, secret] of this.held) {
      if (secret.at <= expired) this.held.delete(name);
    }
  }
}
