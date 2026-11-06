/**
 * Signing in, signing out, and changing your own credentials.
 *
 * The sign-in route is rate limited, and the shape of that is the interesting part — see the two
 * rules below. It is the one route where the caller is trying to *find* a credential rather than
 * present one, and until this it accepted attempts as fast as a client could send them, on a
 * dashboard whose whole purpose is an agent that can run commands.
 */

import { createLogger, rateLimit } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import {
  loadOauth,
  oauthReady,
  oauthSupported,
  redirectUriFor,
  OIDC_FLOW_COOKIE,
} from "@/modules/users/oidc.ts";
import {
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
} from "@/modules/users/auth.ts";
import { pathInDashboard } from "@/modules/web/links.ts";
import { secureCookies } from "../guard.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_RUNNING, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

const log = createLogger("control.auth");

/**
 * Two rules, because one is always the wrong one.
 *
 * **Per address**, so a single host cannot spray one password across every username it can think
 * of — each account would otherwise see a single attempt and no rule would ever trip. Loose enough
 * for an office behind one NAT, and keyed on the *socket* rather than `x-forwarded-for`, which the
 * caller writes: see the note at the `serveHttp` call in `web/server.ts`.
 *
 * **Per account**, so a known username cannot be brute-forced from a thousand addresses. This one
 * has a cost worth naming: somebody who knows a username can burn its allowance on purpose and
 * make its owner wait. That is why the window is fifteen minutes rather than an hour, why the limit
 * is ten rather than three, and why **a successful sign-in is refunded and the account's failures
 * cleared** — a person typing the right password does not spend their own allowance, so the only
 * thing that accumulates is being wrong.
 *
 * The alternative to accepting that cost is unlimited guessing against a named account, which is
 * strictly worse. Neither rule is a lockout: both refill continuously, so the answer to a refusal
 * is always "wait", never "ask an administrator".
 */
const ATTEMPTS_PER_ADDRESS = 30;
const ATTEMPTS_PER_ACCOUNT = 10;
const ATTEMPT_WINDOW = "15m";

/** Addressless requests share one bucket rather than bypassing the rule — a test, or a unix socket. */
const NO_ADDRESS = "unknown";

/**
 * The dashboard page an OAuth sign-in goes on to (0.8.11): its `next`, kept across the provider's round trip. A cookie
 * of its own, sent only to the callback, so the flow's own cookie stays as the sign-in module writes it. Checked again
 * when it is read: a cookie is the browser's to write.
 */
const NEXT_COOKIE = "nouride_next";
const NEXT_PATH = "/api/control/auth/oauth";

function nextCookie(next: string | null, secure: boolean): string {
  return [`${NEXT_COOKIE}=${next ? encodeURIComponent(next) : ""}`, `Path=${NEXT_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${next ? 600 : 0}`, ...(secure ? ["Secure"] : [])].join("; ");
}

/** The login page with why a sign-in did not finish — and the page it was for, so the next try keeps it. */
function loginAgain(error: string, next: string | null): string {
  return `/dashboard/login?error=${error}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
}

export function registerAuthRoutes(control: ControlApp, deps: ControlDeps): void {
  // Per registration rather than per module, so a test that exhausts a limit does not hand its
  // exhausted bucket to the next test in the file.
  const byAddress = rateLimit({
    name: "login",
    by: "ip",
    limit: ATTEMPTS_PER_ADDRESS,
    window: ATTEMPT_WINDOW,
  });
  const byAccount = rateLimit({
    name: "login",
    by: "account",
    limit: ATTEMPTS_PER_ACCOUNT,
    window: ATTEMPT_WINDOW,
  });

  /**
   * Sign in.
   *
   * One failure message for an unknown username and a wrong password alike, because two messages turn
   * this into a way to find out which accounts exist.
   */
  control.post("/auth/login", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);

    /**
     * Password sign-in switched off, which is only reachable on an install that
     * has an identity provider — `validate()` refuses the combination that
     * would leave no way in.
     *
     * **403 and not 401.** The credential is not wrong; this daemon does not
     * accept credentials of that kind at all, and a 401 would send somebody to
     * check their password forever. The message names the alternative.
     */
    if (deps.ctx.config.dashboard?.passwordLogin === false) {
      const label = deps.ctx.config.dashboard.oauth?.label || "your provider";
      return c.json(
        { error: `password sign-in is disabled on this install. Use "Continue with ${label}"`, plain: `Signing in with a password is turned off here. Use "Continue with ${label}".` },
        403,
      );
    }

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return c.json({ error: "username and password are required" }, 400);

    /**
     * Both rules are spent before the password is checked, and one of them is given back after.
     *
     * Spent first because the check is the expensive part — password verification is deliberately
     * slow — so a limiter that ran afterwards would still let a flood do all the work. Given back
     * on success because the person has just proved who they are.
     */
    const address = c.env.clientAddress ?? NO_ADDRESS;
    // Lower-cased so `Gading` and `gading` cannot be counted as two accounts to get two allowances.
    const account = username.trim().toLowerCase();

    // Address first: it is the rule that catches spraying, and the cheaper one to be refused by.
    const fromAddress = byAddress.check(address);
    const verdict = fromAddress.ok ? byAccount.check(account) : fromAddress;
    if (!verdict.ok) {
      // The username is not logged here — a refusal is not evidence the account exists, and a log
      // full of guessed names is a list of guesses, not of accounts.
      log.warn("login rate limited", { by: verdict.by, retry_after_ms: verdict.retryAfterMs });
      c.header("retry-after", String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
      return c.json({ error: "too many sign-in attempts. Wait a few minutes and try again" }, 429);
    }

    const user = await deps.users.verify(username, password);
    if (!user) {
      deps.audit.record({ action: "login_failed", actor: username, details: { username } });
      return c.json({ error: "wrong username or password" }, 401);
    }

    // The right password costs nothing. Only being wrong accumulates — see the note on the rules.
    byAddress.refund(address);
    byAccount.reset(account);

    const session = deps.users.startSession(user.id);
    c.header("set-cookie", sessionCookie(session.token, session.expiresAt, secureCookies(c)));
    deps.audit.record({ action: "login", actor: user.username });
    return c.json({ user });
  });

  /**
   * Start an OAuth login.
   *
   * Public, because nobody is signed in yet — see `PUBLIC_PATHS` in `guard.ts`. Rate limited by
   * address for the same reason the password route is: it makes outbound requests to the issuer,
   * and an endpoint that does that on demand is one somebody else can point at a third party.
   */
  control.get("/auth/oauth/start", async (c) => {
    // Two different absences, one answer: this build has no flow, or this
    // install has not configured one. Neither is a route a browser should find.
    if (!oauthSupported() || !oauthReady(deps.ctx.config.dashboard)) {
      return c.json({ error: "external sign-in is not available on this daemon" }, 404);
    }

    // The same allowance the password route spends, because both are sign-in attempts from one
    // address and a second budget would only be the way around the first. Given back below when the
    // login succeeds, so a person who uses this ten times a day does not eat their own password
    // budget — and an office behind one NAT does not eat each other's.
    const address = c.env.clientAddress ?? NO_ADDRESS;
    const verdict = byAddress.check(address);
    if (!verdict.ok) {
      c.header("retry-after", String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
      return c.json({ error: "too many sign-in attempts. Wait a few minutes and try again" }, 429);
    }

    const { oauth } = deps.ctx.config.dashboard;
    const next = pathInDashboard(c.req.query("next"));
    try {
      const { beginLogin } = await loadOauth();
      const flow = await beginLogin({ oauth, redirectUri: redirectUriFor(deps.ctx.config.dashboard), secure: secureCookies(c) });
      c.header("set-cookie", flow.cookie);
      if (next) c.header("set-cookie", nextCookie(next, secureCookies(c)), { append: true });
      return c.redirect(flow.authorizeUrl);
    } catch (err) {
      log.warn("could not start an oauth login", { error: String(err) });
      return c.redirect(loginAgain("provider_unreachable", next));
    }
  });

  /**
   * Finish an OAuth login.
   *
   * **An identity is matched to an existing account and never creates one.** The provider
   * authenticates every user it has, not only the ones this daemon knows — so on a rented install,
   * auto-creating would hand an account to every customer of the provider who found the URL. The
   * account is made deliberately, by whoever provisioned the install, with the email as its
   * username; this route only decides whether the person at the door already has one.
   *
   * That also keeps the role decision where it belongs. A local account already carries admin,
   * operator or viewer; an identity carries neither, and inventing a default here would be
   * inventing a permission.
   */
  control.get("/auth/oauth/callback", async (c) => {
    if (!oauthSupported() || !oauthReady(deps.ctx.config.dashboard) || !deps.users) {
      return c.json({ error: "external sign-in is not available on this daemon" }, 404);
    }

    const { clearedFlowCookie, completeLogin } = await loadOauth();
    const secure = secureCookies(c);
    // Cleared on every path out of here, success or not: a used or stale flow cookie is a value
    // with nothing left to prove and no reason to sit in a browser for ten minutes.
    c.header("set-cookie", clearedFlowCookie(secure));
    const next = pathInDashboard(readCookie(c.req.header("cookie"), NEXT_COOKIE));
    if (next) c.header("set-cookie", nextCookie(null, secure), { append: true });

    const { oauth } = deps.ctx.config.dashboard;
    const clientSecret = deps.secrets.resolve(oauth.secretName);
    if (!clientSecret) {
      log.error("oauth is configured but its client secret is missing", { secret_name: oauth.secretName });
      return c.redirect(loginAgain("misconfigured", next));
    }

    const result = await completeLogin({
      oauth,
      clientSecret,
      redirectUri: redirectUriFor(deps.ctx.config.dashboard),
      code: c.req.query("code"),
      state: c.req.query("state"),
      cookieValue: readCookie(c.req.header("cookie"), OIDC_FLOW_COOKIE),
    });

    if (!result.ok) {
      log.warn("oauth login failed", { reason: result.error });
      return c.redirect(loginAgain("oauth_failed", next));
    }

    const user = deps.users.byUsername(result.identity.email);
    if (!user) {
      // Logged with the email, because "somebody with a valid identity has no account here" is the
      // one failure an operator has to be able to act on — they are the person who adds the account.
      log.warn("oauth login refused: no local account", { email: result.identity.email });
      return c.redirect(loginAgain("no_account", next));
    }

    // Proving who you are through the provider costs nothing, the same as the right password.
    byAddress.refund(c.env.clientAddress ?? NO_ADDRESS);
    byAccount.reset(user.username.trim().toLowerCase());

    const session = deps.users.startSession(user.id);
    // Two `set-cookie` headers: the cleared flow cookie above and the session below. `c.header`
    // replaces by name, so these do not collide.
    c.header("set-cookie", sessionCookie(session.token, session.expiresAt, secure), { append: true });
    deps.audit.record({ action: "login", actor: user.username, details: { via: "oauth" } });
    return c.redirect(`/dashboard${next ?? "/"}`);
  });

  /**
   * Turn password sign-in on or off, from the dashboard.
   *
   * **Admin only**, and it is the strictest thing here for a reason: it changes
   * how everybody signs in, including the person changing it, and it takes
   * effect on the next request rather than the next boot.
   *
   * The refusal lives in `SettingsService.setPasswordLogin` — it will not turn
   * this off unless external sign-in is not merely configured but has a client
   * secret that resolves. See there for why `validate()` cannot make that check.
   */
  control.post("/auth/password-login", async (c) => {
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    if (!deps.settings) return c.json({ error: "settings are not available on this daemon", plain: NO_SETTINGS }, 501);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false" }, 400);
    }

    const result = await deps.settings.setPasswordLogin({
      enabled: body.enabled,
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);

    return c.json({ passwordLogin: body.enabled });
  });

  control.post("/auth/logout", (c) => {
    const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (token) deps.users?.endSession(token);
    c.header("set-cookie", clearedSessionCookie(secureCookies(c)));
    return c.json({ ok: true });
  });

  control.get("/auth/me", (c) => {
    const principal = c.get("principal");
    // The CLI's token is not a person. Reported as such rather than invented into one, so the dashboard
    // can tell "signed in as someone" from "holding the host's credential".
    return c.json({
      kind: principal.kind,
      role: principal.role,
      actor: principal.actor,
      user: principal.user ?? null,
    });
  });

  /**
   * Change your own password.
   *
   * The current password is required even though the session already proves identity: a session left
   * open on an unattended machine should not be enough to lock its owner out. Every other session for
   * the account is dropped, because the usual reason to change a password is believing someone else
   * has it.
   *
   * The one exception is the forced first change — see below.
   */
  control.post("/auth/password", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!principal.user) {
      return c.json({ error: "the control token has no password to change", plain: "This sign-in has no password to change." }, 400);
    }

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const current = typeof body.current === "string" ? body.current : "";
    const next = typeof body.next === "string" ? body.next : "";

    /**
     * The current password is not asked for on a forced first change.
     *
     * `must_change_password` means the account is still on the credential the daemon printed at
     * first boot — which the person has just typed, in this session, to get here. Asking for it
     * again proves nothing that logging in did not, and it reads as a *change* form for what is
     * really a *set* form: the old value is not a secret they chose, it is one they were handed and
     * are being made to discard.
     *
     * The session is the proof. Once the flag clears, a change requires the current password again,
     * because from then on it guards a secret the person actually picked.
     */
    const forced = principal.user.mustChangePassword;
    if (!forced && !(await deps.users.verify(principal.user.username, current))) {
      return c.json({ error: "current password is wrong" }, 403);
    }
    try {
      await deps.users.setPassword(principal.user.id, next, principal.actor);
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err), plain: "The password was not changed: it is too short. Try a longer one." }, 400);
    }

    deps.users.endAllSessions(principal.user.id);
    const session = deps.users.startSession(principal.user.id);
    c.header("set-cookie", sessionCookie(session.token, session.expiresAt, secureCookies(c)));
    return c.json({ ok: true });
  });

  /**
   * Your own username and name.
   *
   * Two different things, changed together because they are one form. The username is the handle the
   * password is checked against; the name is what the agent should call you, and it is optional
   * because an unnamed account is a real state rather than an unfinished one.
   *
   * A rename ends every other session for the account. The old handle stops working the moment this
   * returns, and a second browser still holding a session would keep working against a name that no
   * longer exists — which looks like the rename failed.
   */
  control.post("/auth/profile", async (c) => {
    if (!deps.users) return c.json({ error: "accounts are not enabled on this daemon", plain: NOT_RUNNING }, 501);
    const principal = c.get("principal");
    if (!principal.user) {
      return c.json({ error: "the control token has no profile", plain: "This sign-in has no profile to change." }, 400);
    }

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;

    if (typeof body.displayName === "string") {
      deps.users.setDisplayName(principal.user.id, body.displayName, principal.actor);
    }

    let renamed = false;
    if (typeof body.username === "string" && body.username.trim() !== principal.user.username) {
      const result = deps.users.setUsername(principal.user.id, body.username, principal.actor);
      if (!result.ok) return c.json({ error: result.error, plain: "That username was not saved. It may hold letters, digits, dots, dashes and underscores, and must be one nobody else has." }, 400);
      renamed = true;
    }

    if (renamed) {
      deps.users.endAllSessions(principal.user.id);
      const session = deps.users.startSession(principal.user.id);
      c.header("set-cookie", sessionCookie(session.token, session.expiresAt, secureCookies(c)));
    }

    return c.json({ ok: true, user: deps.users.byId(principal.user.id) });
  });
}
