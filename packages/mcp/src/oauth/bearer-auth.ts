/**
 * A login in use: its access token sent as a bearer on every request, renewed a little before it expires and when a
 * server refuses it, and every renewed set handed back to be stored.
 *
 * One renewal at a time. A connection sends several requests at once — a turn's parallel tool calls — and each would
 * otherwise spend the same refresh token: the first renewal wins, and on a server that rotates refresh tokens the rest
 * present a spent one and are told to log in again. So a renewal in flight is the renewal everybody waits on, and a 401
 * for a token already replaced is answered by retrying with its replacement rather than by renewing again.
 */

import { createLogger } from "@nouride/shared";
import type { McpAuth } from "../http-auth.ts";
import { messageOf, OAuthLoginRequiredError, withoutSecrets } from "./errors.ts";
import type { OAuthTokens } from "./token.ts";

const log = createLogger("mcp.oauth");

/** How long before its expiry an access token is renewed: a request that leaves now must not arrive with a dead one. */
const RENEW_BEFORE_MS = 60_000;

export interface OAuthAuthOptions {
  /** The login's tokens, as last stored — what `exchangeCode` returned, or the last set `onTokens` was handed. */
  tokens: OAuthTokens;
  /** Renew them: `(current) => refreshTokens(discovery, client, current)`. */
  refresh(current: OAuthTokens): Promise<OAuthTokens>;
  /**
   * Handed each renewed set, to store in place of the last — before the new token is sent anywhere. Keep them: a
   * rotated refresh token is spent once used, so the old set is a lost login after a restart. A store that fails is
   * logged, and the renewed tokens are used for as long as this connection lives.
   */
  onTokens?(tokens: OAuthTokens): void | Promise<void>;
  /** The clock expiry is read against — `Date.now` unless a test drives it. */
  now?: () => number;
}

/**
 * The `McpAuth` for a server logged in to with OAuth: `Authorization: Bearer <access token>`, renewed ahead of its
 * expiry and on a 401 — once per 401, and one renewal shared by every request waiting on it.
 *
 * A refresh the server refuses (`OAuthLoginRequiredError`: the refresh token is spent, expired or revoked) ends it: from
 * then on a 401 is not retried, so the call fails with `McpAuthRequiredError` and the person is asked to log in. A
 * refresh that fails any other way — the authorization server unreachable — is thrown to the call that met the 401, so
 * it fails with why, and the next 401 tries again: an outage is not a lost login.
 */
export function oauthAuth(options: OAuthAuthOptions): McpAuth {
  const now = options.now ?? Date.now;
  let tokens = options.tokens;
  /** The server refused the refresh token: nothing renews this login any more. */
  let lost = false;
  let renewing: Promise<boolean> | null = null;
  const bearer = (): string => `Bearer ${tokens.accessToken}`;
  /** Text from elsewhere — a caller's exception, a server's error — with this login's tokens cut out of it, and `also`'s. */
  const clean = (err: unknown, also?: OAuthTokens): string =>
    withoutSecrets(messageOf(err), [tokens.accessToken, tokens.refreshToken, also?.accessToken, also?.refreshToken]);

  const store = async (next: OAuthTokens): Promise<void> => {
    try {
      await options.onTokens?.(next);
    } catch (err) {
      // Said before `next` is in use, so its tokens are named to the scrub: the store's error may quote them.
      log.warn("could not store an MCP server's renewed login; it holds until the daemon restarts", { error: clean(err, next) });
    }
  };

  const renewOnce = async (): Promise<boolean> => {
    try {
      const next = await options.refresh(tokens);
      await store(next);
      tokens = next;
      log.debug("renewed an MCP server's login", { expires_in_s: next.expiresAt === undefined ? null : Math.round((next.expiresAt - now()) / 1000) });
      return true;
    } catch (err) {
      if (!(err instanceof OAuthLoginRequiredError)) throw err;
      lost = true;
      log.warn("an MCP server's login can no longer be renewed; it needs logging in again", { error: clean(err) });
      return false;
    }
  };

  /** The renewal in flight, or a new one: whoever asks while one runs waits on it. */
  const renew = (): Promise<boolean> => {
    renewing ??= renewOnce().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const due = (): boolean => !lost && tokens.refreshToken !== undefined && tokens.expiresAt !== undefined && now() >= tokens.expiresAt - RENEW_BEFORE_MS;

  return {
    async headers() {
      if (renewing || due()) {
        try {
          await renew();
        } catch (err) {
          // The token it has may still have its last minute; a server that refuses it sends the call back through
          // `unauthorized`, which tries again.
          log.warn("could not renew an MCP server's login ahead of its expiry; sending the one it has", { error: clean(err) });
        }
      }
      return { authorization: bearer() };
    },

    async unauthorized(_challenge, sent) {
      if (lost || tokens.refreshToken === undefined) return false;
      // Sent before a renewal replaced its token: the new one has not been refused yet, so it is tried.
      if (!renewing && sent.authorization !== bearer()) return true;
      return await renew();
    },
  };
}
