/**
 * Signing in through Nouverse, end to end, against a real issuer that is not Nouverse.
 *
 * The two routes here are the only ones in the daemon that will hand out a session to somebody who
 * never typed a password, so what is tested is not "does a login work" — it is **who is refused**.
 * Four of these assert a refusal and one asserts nothing was created; the happy path is a single
 * test, which is the right ratio for an authentication flow.
 *
 * The issuer is a live HTTP server on a loopback port rather than a stubbed `fetch`, for two
 * reasons. Bun runs every test file in one process, so a global `fetch` stub in this file would
 * reach `cli-setup.test.ts` — that has already happened once here. And the flow makes three
 * outbound calls in a fixed order (discovery, token, userinfo) whose failures are handled
 * differently; a fake that answers by URL exercises that ordering, a stub that answers by call
 * count only pretends to.
 *
 * `discover()` caches per issuer for the process, so each test that needs a clean issuer gets its
 * own path under the same server. That is a property of the cache being deliberate, not a
 * workaround: endpoints do not move mid-session.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { Hono } from "hono";
import { openDatabase, serveHttp, writeTextFile, type HttpServer, type SqliteDb } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { OIDC_FLOW_COOKIE, resolveOauthSupport } from "@/modules/users/oidc.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { cheapPasswords } from "../helpers.ts";

const CLIENT_ID = "nvo_test_client";
const CLIENT_SECRET = "shhh-not-in-the-config";
const SECRET_NAME = "nouverse_oauth";
const PUBLIC_URL = "https://agent.example.test";
const REDIRECT_URI = `${PUBLIC_URL}/api/control/auth/oauth/callback`;
const ACCOUNT = "gading@example.test";

/** What the fake issuer will do on the next token exchange and userinfo call. */
let issuerState: {
  /** Verifiers the issuer accepted, so a test can prove PKCE actually travelled. */
  seenVerifier: string | null;
  seenSecret: string | null;
  tokenStatus: number;
  userinfo: Record<string, unknown>;
  userinfoStatus: number;
};

let issuer: HttpServer;
let origin: string;

let dir: string;
let db: SqliteDb;
let users: UserStore;
let audit: AuditLog;
let secrets: SecretStore;
let app: Hono;

/**
 * Make `nouride-oauth` resolvable for this run.
 *
 * The flow lives in `internals/pro/packages/oauth`, outside the workspace, so that
 * `--external nouride-oauth` can remove it from every edition but `--pro`.
 * That is the whole point of the boundary — and it means a plain checkout has
 * no `node_modules/nouride-oauth` to import.
 *
 * The build (`scripts/build/core.ts`) solves this the same way for a `--pro` build: one symlink,
 * because a package name is the only specifier `--external` can match. Doing it
 * here rather than making the plugin a workspace member is deliberate — as a
 * member it would land in the Docker deps stage, and the free image must not
 * contain it at all.
 *
 * Removed afterwards — when this run made it. It was left in place as a convenience, and a stray
 * `node_modules/nouride-oauth` is what once compiled the sign-in flow into a build that said it had
 * none (`scripts/build/edition.ts`); every later build, test and typecheck ran beside it.
 */
let linked: string | null = null;
function linkOauthPlugin(): void {
  const link = join(REPO_ROOT, "node_modules", "nouride-oauth");
  if (existsSync(link)) return;
  linked = link;
  // A link that is there and leads nowhere — left from when the plugins lived in `plugins/` — reads
  // as absent to `existsSync` and as present to `symlinkSync`. Replaced, not tripped over.
  rmSync(link, { force: true });
  symlinkSync(join(REPO_ROOT, "internals", "pro", "oauth"), link);
}

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

/**
 * Whether the plugin is on disk at all, which in a public clone it is not.
 *
 * `internals/pro/packages/oauth` is a **private** submodule — the flow is Nouverse's own, and the editions that
 * carry it are the ones that are not published. `git clone` without access to it leaves the
 * directory there and empty, so the symlink above would resolve to nothing and every test in this
 * file would fail on an import. Keyed on `package.json`: absent means nobody checked the submodule
 * out, while a checkout missing its source still fails on the import rather than skipping quietly.
 *
 * Skipped rather than failed, for the same reason `check-types.ts` skips the Pro projects in a public
 * clone: an optional component must never become a required one. Somebody who cloned the public repo has a

 * tree where `bun run verify` passes, and the daemon they build refuses `[dashboard.oauth]` by
 * design — `resolveOauthSupport()` answers "no flow in this build", which is the same answer the
 * `basic` and `router` artefacts give.
 */
const HAS_PLUGIN = existsSync(join(REPO_ROOT, "internals", "pro", "oauth", "package.json"));

beforeAll(async () => {
  if (HAS_PLUGIN) linkOauthPlugin();
  // `startControlPlane` does this before anything is served. A test mounts the
  // routes directly, so it does it here — without it every route answers 404
  // and the failure looks like a configuration bug.
  await resolveOauthSupport();
  // Through the runtime adapter, not `Bun.serve` — invariant 1 covers tests and `lint:arch` globs
  // them. Port 0 lets the OS pick, so a parallel run cannot collide.
  issuer = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const tail = url.pathname.split("/").slice(-2).join("/");

      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        const base = url.href.replace("/.well-known/openid-configuration", "");
        if (url.pathname.startsWith("/dead")) return new Response("gone", { status: 503 });
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/oauth2/authorize`,
          token_endpoint: `${base}/oauth2/token`,
          userinfo_endpoint: `${base}/oauth2/userinfo`,
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (tail === "oauth2/token") {
        const form = new URLSearchParams(await req.text());
        issuerState.seenVerifier = form.get("code_verifier");
        issuerState.seenSecret = form.get("client_secret");
        if (issuerState.tokenStatus !== 200) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: issuerState.tokenStatus,
          });
        }
        return Response.json({ access_token: "at_1", token_type: "Bearer", expires_in: 3600 });
      }

      if (tail === "oauth2/userinfo") {
        if (req.headers.get("authorization") !== "Bearer at_1") {
          return new Response("no", { status: 401 });
        }
        return new Response(JSON.stringify(issuerState.userinfo), {
          status: issuerState.userinfoStatus,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${issuer.port}`;
});

afterAll(async () => {
  await issuer.stop(true);
  if (linked) rmSync(linked, { force: true });
});

/**
 * A context carrying only the dashboard section, which is all these two routes read from config.
 *
 * `issuerPath` gives each test its own issuer identity under the one server, so the discovery cache
 * from a previous test cannot answer for this one.
 */
function context(
  issuerPath: string,
  overrides: Record<string, unknown> = {},
  dashboard: Record<string, unknown> = {},
): DaemonContext {
  return {
    config: {
      dashboard: {
        publicUrl: PUBLIC_URL,
        // The real default, from `DEFAULT_CONFIG`. Left out, it reads as
        // `undefined` — which the code treats as on, but a test that asserts
        // `true` would be asserting the fixture rather than the daemon.
        passwordLogin: true,
        ...dashboard,
        oauth: {
          issuer: `${origin}${issuerPath}`,
          clientId: CLIENT_ID,
          secretName: SECRET_NAME,
          label: "Nouverse",
          ...overrides,
        },
      },
    },
    db,
    gateways: new Map(),
    startedAt: Date.now(),
    configSource: null,
    status: "ready",
    agentCount: 0,
    providerErrors: new Map(),
  } as unknown as DaemonContext;
}

function mount(ctx: DaemonContext): Hono {
  const fresh = new Hono();
  mountControlRoutes(fresh, {
    ctx,
    token: "control-token-for-tests-0000000000",
    audit,
    users,
    secrets,
  } as unknown as ControlDeps);
  return fresh;
}

async function get(target: Hono, path: string, headers: Record<string, string> = {}) {
  return await target.request(`/api/control${path}`, { headers }, { clientAddress: "203.0.113.7" });
}

/** The flow cookie a `/start` handed back, ready to send to `/callback`. */
function flowCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

function stateFrom(res: Response): string {
  return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nouride-oidc-"));
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
  users = new UserStore({ passwords: cheapPasswords, db });
  audit = new AuditLog(db);
  // The secret arrives from the environment, which is how a pod gets it: the provisioner injects
  // `NOUVERSE_OAUTH` and the config names it. Nothing here writes a secret to disk.
  secrets = await SecretStore.open(dir, { NOUVERSE_OAUTH: CLIENT_SECRET });
  issuerState = {
    seenVerifier: null,
    seenSecret: null,
    tokenStatus: 200,
    userinfo: { sub: "nv_user_1", email: ACCOUNT, name: "Gading" },
    userinfoStatus: 200,
  };
  app = mount(context("/live"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_PLUGIN)("advertising it", () => {
  test("/setup/state says a configured install has external sign-in, and names it", async () => {
    const res = await get(app, "/setup/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ oauth: { available: true, label: "Nouverse" } });
  });

  test("every one of the four settings is load-bearing", async () => {
    // Not four separate tests, because the point is the conjunction: an install missing any one of
    // these draws the button and then fails, and which one is missing does not change that.
    for (const missing of ["issuer", "clientId", "secretName"]) {
      const partial = mount(context("/live", { [missing]: "" }));
      const res = await get(partial, "/setup/state");
      expect(await res.json()).toMatchObject({ oauth: { available: false } });
    }

    const noPublicUrl = context("/live");
    (noPublicUrl.config as { dashboard: { publicUrl: string } }).dashboard.publicUrl = "  ";
    const res = await get(mount(noPublicUrl), "/setup/state");
    expect(await res.json()).toMatchObject({ oauth: { available: false } });
  });

  test("a daemon with no dashboard section at all answers rather than throwing", async () => {
    // `/setup/state` is public and answers before anything is configured, so a missing section has
    // to read as "no button" — not as a 500 on the one page a new operator sees first.
    const bare = mount({ config: {}, db, gateways: new Map() } as unknown as DaemonContext);
    const res = await get(bare, "/setup/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ oauth: { available: false } });
  });
});

describe.skipIf(!HAS_PLUGIN)("starting a login", () => {
  test("an unconfigured install has no such route", async () => {
    const off = mount(context("/live", { issuer: "" }));
    const res = await get(off, "/auth/oauth/start");
    expect(res.status).toBe(404);
  });

  test("the redirect carries PKCE, a state, and the exact registered redirect URI", async () => {
    const res = await get(app, "/auth/oauth/start");
    expect(res.status).toBe(302);

    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(`${origin}/live/oauth2/authorize`);
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("client_id")).toBe(CLIENT_ID);
    // Byte-identical to the registered value: the provider compares this string three times, and a
    // trailing slash difference fails at the exchange, after the user has already signed in.
    expect(to.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(to.searchParams.get("scope")).toBe("openid profile email");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
    // No padding and no `+`/`/`: base64url, which is what the provider hashes to.
    expect(to.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  test("the flow cookie is HttpOnly and Lax, and is not readable by a page", async () => {
    const res = await get(app, "/auth/oauth/start");
    const header = res.headers.get("set-cookie") ?? "";

    expect(header).toContain(`${OIDC_FLOW_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    // `Lax`, not `Strict`: the callback is a cross-site navigation from the provider, and `Strict`
    // would withhold the cookie on precisely that request.
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=600");
  });

  test("it shares the password route's per-address allowance", async () => {
    // 30 in 15 minutes is the login rule, and this route spends the same one: it makes an outbound
    // request to a third party on demand, so a second budget would only be the way around the first.
    for (let i = 0; i < 30; i += 1) {
      expect((await get(app, "/auth/oauth/start")).status).toBe(302);
    }
    const refused = await get(app, "/auth/oauth/start");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
  });

  test("a finished login gives the attempt back", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });

    // Twenty-nine spent, then the thirtieth is a login that completes. Without the refund the next
    // start is refused; with it, somebody who signs in this way every morning — or an office behind
    // one address — does not spend down the budget the password form shares.
    for (let i = 0; i < 29; i += 1) {
      expect((await get(app, "/auth/oauth/start")).status).toBe(302);
    }
    const started = await get(app, "/auth/oauth/start");
    const done = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, {
      cookie: flowCookie(started),
    });
    expect(done.headers.get("location")).toBe("/dashboard/");

    expect((await get(app, "/auth/oauth/start")).status).toBe(302);
  });

  test("an unreachable issuer sends the operator back to the login page, not to a stack trace", async () => {
    const dead = mount(context("/dead"));
    const res = await get(dead, "/auth/oauth/start");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/login?error=provider_unreachable");
  });
});

describe.skipIf(!HAS_PLUGIN)("finishing a login", () => {
  test("a matched account gets a session, and the login is audited as external", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });

    const started = await get(app, "/auth/oauth/start");
    const res = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, {
      cookie: flowCookie(started),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("nouride_session="))).toBe(true);
    // The flow cookie is spent, and cleared on the same response as the session is set.
    expect(cookies.some((c) => c.startsWith(`${OIDC_FLOW_COOKIE}=;`) || c.includes("Max-Age=0"))).toBe(true);

    // PKCE and the secret both actually reached the issuer, rather than being generated and dropped.
    expect(issuerState.seenVerifier).toBeTruthy();
    expect(issuerState.seenSecret).toBe(CLIENT_SECRET);
  });

  test("a valid identity with no local account is refused, and no account is created", async () => {
    const before = users.list().length;

    const started = await get(app, "/auth/oauth/start");
    const res = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, {
      cookie: flowCookie(started),
    });

    expect(res.headers.get("location")).toBe("/dashboard/login?error=no_account");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("nouride_session="))).toBe(false);
    /**
     * The whole reason this route exists in this shape.
     *
     * The provider authenticates every user it has, not only the ones this install knows — so
     * auto-creating on a first login would hand an account on a rented container to any Nouverse
     * customer who found the URL. Accounts are made by whoever provisioned the install.
     */
    expect(users.list().length).toBe(before);
  });

  test("a state that this browser did not start is refused", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });
    const started = await get(app, "/auth/oauth/start");

    // A login CSRF looks exactly like this: an attacker's finished authorization, handed to a
    // victim as a link. The cookie is the victim's; the state is not.
    const res = await get(app, "/auth/oauth/callback?code=abc&state=not-the-one", {
      cookie: flowCookie(started),
    });

    expect(res.headers.get("location")).toBe("/dashboard/login?error=oauth_failed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("nouride_session="))).toBe(false);
  });

  test("a callback with no flow cookie at all is refused", async () => {
    const res = await get(app, "/auth/oauth/callback?code=abc&state=anything");
    expect(res.headers.get("location")).toBe("/dashboard/login?error=oauth_failed");
  });

  test("a missing secret is the operator's problem and says so distinctly", async () => {
    const started = await get(app, "/auth/oauth/start");
    const state = stateFrom(started);

    const empty = await SecretStore.open(dir, {});
    const noSecret = new Hono();
    mountControlRoutes(noSecret, {
      ctx: context("/live"),
      token: "control-token-for-tests-0000000000",
      audit,
      users,
      secrets: empty,
    } as unknown as ControlDeps);

    const res = await noSecret.request(
      `/api/control/auth/oauth/callback?code=abc&state=${state}`,
      { headers: { cookie: flowCookie(started) } },
      { clientAddress: "203.0.113.7" },
    );
    // Distinct from `oauth_failed`, because nothing the visitor does will fix it.
    expect(res.headers.get("location")).toBe("/dashboard/login?error=misconfigured");
  });

  test("an issuer that refuses the exchange does not become a session", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });
    issuerState.tokenStatus = 401;

    const started = await get(app, "/auth/oauth/start");
    const res = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, {
      cookie: flowCookie(started),
    });

    expect(res.headers.get("location")).toBe("/dashboard/login?error=oauth_failed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("nouride_session="))).toBe(false);
  });

  test("an identity with no email is refused rather than matched on something else", async () => {
    issuerState.userinfo = { sub: "nv_user_1", name: "Gading" };

    const started = await get(app, "/auth/oauth/start");
    const res = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, {
      cookie: flowCookie(started),
    });

    // `email` is what a local account is matched on. Falling back to `sub` would match nothing, and
    // falling back to `name` would match the wrong person.
    expect(res.headers.get("location")).toBe("/dashboard/login?error=oauth_failed");
  });
});

/**
 * An install that accepts no password at all.
 *
 * Only reachable with an identity provider configured — `validate()` refuses the
 * combination that would leave no way in — so these tests always pair the two.
 */
describe.skipIf(!HAS_PLUGIN)("password sign-in switched off", () => {
  const noPassword = () => mount(context("/live", {}, { passwordLogin: false }));

  test("/setup/state says so, and the login page needs it to draw anything", async () => {
    const res = await get(noPassword(), "/setup/state");
    expect(await res.json()).toMatchObject({
      passwordLogin: false,
      oauth: { available: true },
    });
  });

  test("a daemon older than the setting reads as ON, never as no way in", async () => {
    // Absent must not mean "off": a login page with neither a form nor a button
    // is unanswerable, and that is the one failure with no route out of it.
    const res = await get(app, "/setup/state");
    expect(await res.json()).toMatchObject({ passwordLogin: true });
  });

  test("the login route refuses with 403, not 401", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });

    const res = await noPassword().request(
      "/api/control/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: ACCOUNT, password: "local-password-1" }),
      },
      { clientAddress: "203.0.113.7" },
    );

    // 403 and not 401: the credential is correct. This daemon does not accept
    // credentials of that kind, and a 401 sends somebody to check their password
    // forever.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled|Continue with/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("nouride_session="))).toBe(false);
  });

  test("the external route still works — it is the only way in", async () => {
    expect((await get(noPassword(), "/auth/oauth/start")).status).toBe(302);
  });

  test("with it on, a correct password is still accepted", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });
    const res = await app.request(
      "/api/control/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: ACCOUNT, password: "local-password-1" }),
      },
      { clientAddress: "203.0.113.7" },
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Turning password sign-in off from the dashboard.
 *
 * The dangerous direction, and more dangerous than the file version of the same
 * setting: it lands on the next request, including the caller's own. At boot the
 * worst case is a daemon that refuses to start and says why over SSH; here it is
 * a daemon that keeps running and can never be signed into again.
 *
 * So the guard is stricter than `validate()`'s. It is not enough for the
 * provider to be *configured* — the client secret has to resolve, which
 * `validate()` cannot check because it runs before the secret store is open.
 */
describe.skipIf(!HAS_PLUGIN)("the admin switch for password sign-in", () => {
  /** The settings service, with the pieces this one setting reads. */
  const settingsFor = async (
    dashboard: Record<string, unknown>,
    store: SecretStore,
    /**
     * Reaches `dashboard.oauth`, which `context()` assigns AFTER spreading the
     * dashboard override — so an `oauth` passed in the first argument is
     * silently discarded. That cost this suite one wrong failure.
     */
    oauth: Record<string, unknown> = {},
  ) => {
    const { SettingsService } = await import("@/modules/config/settings/index.ts");
    const config = context("/live", oauth, dashboard).config as GlobalConfig;
    const configPath = join(dir, "config.toml");
    // The file says what the running config says: a save is checked against what the next boot would read, and a
    // file with password sign-in off and no provider in it is one the daemon refuses to start from.
    // Password sign-in included: the running config follows the file a save leaves, so the two have to start alike.
    await writeTextFile(
      configPath,
      `[dashboard]\npublic_url = "${PUBLIC_URL}"\npassword_login = ${config.dashboard.passwordLogin}\n\n[dashboard.oauth]\nissuer = "${config.dashboard.oauth.issuer}"\nclient_id = "${CLIENT_ID}"\nsecret_name = "${SECRET_NAME}"\n`,
    );
    return {
      config,
      service: new SettingsService({
        config,
        configPath,
        secrets: store,
        audit,
      } as unknown as ConstructorParameters<typeof SettingsService>[0]),
    };
  };

  test("turns it off when the provider is configured AND its secret resolves", async () => {
    const { config, service } = await settingsFor({}, secrets);

    const result = await service.setPasswordLogin({ enabled: false, actor: "admin" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    // Live: the login route reads this object per request, so no restart is
    // claimed and none is needed.
    expect(result.restartRequired).toBe(false);
    expect(config.dashboard.passwordLogin).toBe(false);
  });

  test("refuses when the client secret resolves to nothing", async () => {
    /**
     * The check `validate()` cannot make, and the reason this guard is not just
     * a copy of it. A `secret_name` pointing at nothing satisfies the loader and
     * fails at the token exchange — after the user has authenticated at the
     * provider, which is the worst moment to discover there is no way in.
     */
    const empty = await SecretStore.open(dir, {});
    const { config, service } = await settingsFor({}, empty);

    const result = await service.setPasswordLogin({ enabled: false, actor: "admin" });
    expect(result.ok).toBe(false);
    // `SaveResult` is a discriminated union: `error` only exists on the failing
    // arm, so the narrowing is the assertion.
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/resolves to nothing/);
    // And nothing changed, so the caller can still sign in.
    expect(config.dashboard.passwordLogin).toBe(true);
  });

  test("refuses when the provider is not configured, naming what is missing", async () => {
    const { config, service } = await settingsFor({}, secrets, { issuer: "", clientId: "", secretName: "" });

    const result = await service.setPasswordLogin({ enabled: false, actor: "admin" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/issuer/);
    expect(result.error).toMatch(/no way to sign in at all/);
    expect(config.dashboard.passwordLogin).toBe(true);
  });

  test("turning it back on is never refused", async () => {
    const empty = await SecretStore.open(dir, {});
    const { config, service } = await settingsFor({ passwordLogin: false }, empty);

    // Even with a provider that cannot work — this is the direction that
    // restores a way in, so refusing it would be refusing the fix.
    const result = await service.setPasswordLogin({ enabled: true, actor: "admin" });
    expect(result.ok).toBe(true);
    expect(config.dashboard.passwordLogin).toBe(true);
  });
});

/**
 * The page a link opened, kept through the provider's round trip (0.8.11): a dashboard link from a chat, opened signed
 * out, landed on Overview once signed in. Only a path inside the dashboard, or `next` is an open redirect.
 */
describe.skipIf(!HAS_PLUGIN)("signing in keeps the page a link opened", () => {
  /** Every cookie a `/start` set, as the browser sends them back. */
  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((one) => one.split(";")[0]).join("; ");

  test("the callback goes on to `next`, whole, its search with it; and the cookie that kept it is cleared", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });
    const started = await get(app, `/auth/oauth/start?next=${encodeURIComponent("/missions/msn_x?tab=1")}`);
    const kept = started.headers.getSetCookie().find((one) => one.startsWith("nouride_next="))!;
    expect(kept).toContain("HttpOnly");
    expect(kept).toContain("Path=/api/control/auth/oauth");
    const done = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, { cookie: cookiesOf(started) });
    expect(done.headers.get("location")).toBe("/dashboard/missions/msn_x?tab=1");
    expect(done.headers.getSetCookie().some((one) => one.startsWith("nouride_next=;") && one.includes("Max-Age=0"))).toBe(true);
  });

  test("another site, a scheme, the login page itself: none is kept, and the sign-in lands on Overview", async () => {
    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example", "/\t/evil.example", "javascript:alert(1)", "/login", "/LOGIN?next=/x"]) {
      const started = await get(app, `/auth/oauth/start?next=${encodeURIComponent(next)}`);
      expect(started.headers.getSetCookie().some((one) => one.startsWith("nouride_next="))).toBe(false);
    }
  });

  test("a `next` cookie written by hand is checked again when read", async () => {
    await users.create({ username: ACCOUNT, password: "local-password-1", role: "admin", createdBy: "test" });
    const started = await get(app, "/auth/oauth/start");
    const done = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, { cookie: `${flowCookie(started)}; nouride_next=${encodeURIComponent("//evil.example")}` });
    expect(done.headers.get("location")).toBe("/dashboard/");
  });

  test("a sign-in that did not finish goes back to the login page with `next`, so the next try keeps it", async () => {
    const started = await get(app, `/auth/oauth/start?next=${encodeURIComponent("/schedule?job=job_1")}`);
    const refused = await get(app, `/auth/oauth/callback?code=abc&state=${stateFrom(started)}`, { cookie: cookiesOf(started) });
    expect(refused.headers.get("location")).toBe(`/dashboard/login?error=no_account&next=${encodeURIComponent("/schedule?job=job_1")}`);
  });
});
