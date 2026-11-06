/**
 * Logins started and not yet finished: what the redirect will need — the PKCE verifier, the discovery, the client —
 * held in memory by the `state` the authorization request carried.
 *
 * Each is good once, for ten minutes, and only to the person who started it. Memory rather than the database: a
 * verifier is a secret that is useful for minutes, and a restart in the middle of a login costs one more click, where
 * a table of them would be secrets on disk that nothing needs past the redirect.
 */

import type { OAuthClient, OAuthDiscovery } from "@nouride/mcp";

export interface PendingLogin {
  state: string;
  /** The PKCE verifier — a secret: never logged, never answered by a route. */
  verifier: string;
  redirectUri: string;
  discovery: OAuthDiscovery;
  client: OAuthClient;
  /** Whose login it becomes: an agent's id, or `shared` — the library's. */
  holder: string;
  server: string;
  /** Who started it (`kind:actor`): finishing it takes the same person. */
  startedBy: string;
  expiresAt: number;
}

/** How long a login waits for its redirect: long enough to sign in and approve, short enough that a stray one dies. */
export const PENDING_LOGIN_MS = 10 * 60_000;

/** Logins waiting at once, at most. Past it the oldest goes: a person starts one at a time, and a loop is not a person. */
const MAX_PENDING = 32;

export class PendingLogins {
  private readonly byState = new Map<string, PendingLogin>();

  constructor(private readonly now: () => number = Date.now) {}

  add(login: Omit<PendingLogin, "expiresAt">): void {
    for (const [state, held] of this.byState) if (held.expiresAt <= this.now()) this.byState.delete(state);
    while (this.byState.size >= MAX_PENDING) this.byState.delete(this.byState.keys().next().value!);
    this.byState.set(login.state, { ...login, expiresAt: this.now() + PENDING_LOGIN_MS });
  }

  /**
   * The login `state` names, given out once — to the person who started it. Anybody else is told nothing, and the
   * login stays theirs to finish; an expired one is gone either way.
   */
  take(state: string, by: string): PendingLogin | undefined {
    const login = this.byState.get(state);
    if (!login) return undefined;
    if (login.expiresAt <= this.now()) {
      this.byState.delete(state);
      return undefined;
    }
    if (login.startedBy !== by) return undefined;
    this.byState.delete(state);
    return login;
  }
}
