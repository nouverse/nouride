/**
 * The client every command that talks to a running daemon is handed.
 *
 * Port and data directory come from the same config the daemon read, so the CLI does not need its
 * own settings — and `$NOURIDE_URL` / `$NOURIDE_TOKEN` override for a remote daemon.
 */

import { expandHome, fileExists, fileExistsSync, join, readTextFile } from "@nouride/runtime";
import { installEnvPort } from "@/modules/config/global/dotenv.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { installFingerprint } from "@/modules/web/health.ts";
import { unauthorizedMessage } from "@/cli/diagnose.ts";
import { awaitControlToken } from "@/cli/token-wait.ts";
import { aside, fail, heard } from "@/cli/ui.ts";
import { lookAtHealth } from "@/cli/wait-back.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from "@/service/unit.ts";

/**
 * The wire, typed at the point of use.
 *
 * Every one of these returned `Promise<any>`, which is the one annotation that is worse than none:
 * `const { secrets } = await client.get("/secrets")` compiled whatever the route actually answered,
 * so the contract between the CLI and the daemon — two separately built artefacts that talk over
 * HTTP and are upgraded independently — was the only boundary in the tree with no checking at all.
 * A renamed field in a route was a `undefined` printed to a terminal, found by reading the output.
 *
 * Generic with an `unknown` default rather than a hand-written response type per route. The routes
 * are the daemon's and their shapes live there; what the CLI needs is to *say what it expects* and be
 * held to it. `client.get<{ secrets: SecretRow[] }>("/secrets")` is checked from the destructuring
 * outwards, and a call that says nothing gets `unknown` and has to narrow — which is the honest
 * default, and the reason this is not simply `any` with extra steps.
 */
export interface Client {
  baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /**
   * Like `get`, but a failure **throws** instead of exiting the process.
   *
   * For anything polled in the background. `fail()` calls `process.exit`, so a background poll against a
   * missing endpoint killed the whole chat session — observed against a daemon that predated the
   * progress feed: every message answered `✗ not_found` and the CLI exited, while `/message` was fine.
   *
   * A `.catch()` on the caller cannot help with that, because `fail` never rejects. The distinction has
   * to live here.
   */
  softGet<T = unknown>(path: string): Promise<T>;
  /** Like `post`, throwing instead of exiting — for a process that outlives one request (`nouride acp`). */
  softPost<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** For the routes that replace a value rather than create one — retention, a stored secret. */
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  /** A response that does not end — an event stream — to read as it arrives. Throws when it cannot be opened. */
  open(path: string): Promise<ReadableStream<Uint8Array>>;
}

/**
 * The install fingerprint the daemon reports, or undefined if it cannot be read.
 *
 * Never throws: this runs while diagnosing a failure, and a diagnostic that fails is worse than one that
 * says "unknown".
 */
async function daemonInstall(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { install?: unknown };
    return typeof body.install === "string" ? body.install : undefined;
  } catch {
    return undefined;
  }
}

/** Whether anything answered `/health` at all, and the install it named — told apart, because the two mean different things. */
async function probeInstall(baseUrl: string): Promise<{ reached: boolean; install?: string }> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json().catch(() => ({}))) as { install?: unknown };
    return { reached: true, ...(typeof body.install === "string" ? { install: body.install } : {}) };
  } catch {
    return { reached: false };
  }
}

/**
 * How to start the daemon on this machine, for when it cannot be reached.
 *
 * The hint was always "`nouride start`", which on a box where the install made it a service starts a second,
 * unsupervised copy beside the one systemd is restarting — the wrong advice exactly where most installs live.
 * The unit file says which supervisor it is; `paths` is for a test.
 */
export function startHint(paths: SupervisorPaths = {}): string {
  switch (supervisorHere(paths)) {
    case "systemd":
      return "It is a systemd service here: `sudo systemctl start nouride`, and `journalctl -u nouride -n 50` if it does not stay up.";
    case "launchd":
      return `It runs under launchd here: \`launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}\`.`;
    case "container":
      return "Inside a container: start it from the host, `docker compose up -d`.";
    default:
      return "Start it: `nouride start`, or `nouride service install` to keep it running.";
  }
}

/**
 * How to restart the daemon running on this machine — for what it reads only when it starts, as `nouride setup` writes
 * beside a running one (Docker's docs run it so). The same commands the first-run guide gives.
 */
export function restartHint(paths: SupervisorPaths = {}): string {
  switch (supervisorHere(paths)) {
    case "systemd":
      return "sudo systemctl restart nouride";
    case "launchd":
      return `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`;
    case "container":
      return "docker compose restart nouride   (from the host)";
    default:
      return "nouride stop, then nouride start";
  }
}

/** Where the files that say which supervisor runs the daemon are — for a test. */
interface SupervisorPaths {
  systemd?: string;
  launchd?: string;
  container?: string;
}

/** The supervisor the files on this machine say runs the daemon — its unit, its plist, a container. */
function supervisorHere(paths: SupervisorPaths): "systemd" | "launchd" | "container" | null {
  if (fileExistsSync(paths.systemd ?? `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`)) return "systemd";
  if (fileExistsSync(paths.launchd ?? expandHome(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`))) return "launchd";
  if (fileExistsSync(paths.container ?? "/.dockerenv")) return "container";
  return null;
}

/**
 * Build a client against the running daemon.
 *
 * Port and data directory come from the same config the daemon read, so the CLI does not need
 * its own settings — and `$NOURIDE_URL` / `$NOURIDE_TOKEN` override for a remote daemon.
 */
export async function connect(options: { soft?: boolean } = {}): Promise<Client> {
  /**
   * Exit for a command the user typed; throw for `doctor`, which has its offline checks on screen by
   * now and reports them before saying it could not get in. The hint rides on the error, as in `bail`.
   */
  const stop = (message: string, hint?: string): never => {
    if (options.soft) throw Object.assign(new Error(message), { hint });
    return fail(message, hint);
  };
  // As a client: `PORT` and `HOST` are the daemon's, and a web project's `.env` sets both (`applyEnvOverrides`).
  const { config } = await loadConfig({ client: true, ...(options.soft ? { soft: true } : {}) });
  // The port the daemon takes: `NOURIDE_PORT` when the caller names one, else its install's `.env` (`installEnvPort`),
  // else the config's.
  const port = process.env.NOURIDE_PORT ? config.dashboard.port : (installEnvPort(config.daemon.dataDir) ?? config.dashboard.port);
  // `||`, not `??`: `NOURIDE_URL= nouride status` means "not set", and an empty string is no URL to fetch.
  const baseUrl = process.env.NOURIDE_URL || `http://localhost:${port}`;

  const tokenPath = join(config.daemon.dataDir, ".control-token");
  let token = process.env.NOURIDE_TOKEN;
  if (!token) {
    const path = tokenPath;
    if (!(await fileExists(path))) {
      // Asked of `/health` before it is called missing: a daemon of this install that is starting writes it in a moment.
      const why = await awaitControlToken({
        look: () => lookAtHealth(baseUrl),
        tokenExists: () => fileExists(path),
        say: aside,
        install: installFingerprint(config.daemon.dataDir),
        path,
        baseUrl,
        controlEnabled: config.control.enabled,
        startHint: () => startHint(),
      });
      if (why) stop(why.message, why.hint);
    }
    try {
      token = (await readTextFile(path)).trim();
    } catch (err) {
      const isPermission =
        (err as { code?: string })?.code === "EACCES" ||
        String(err).includes("EACCES") ||
        String(err).includes("permission denied");
      if (isPermission) {
        stop(
          `Permission denied reading ${path}.`,
          `The control token is restricted to the service user and group.\n` +
            `Run with sudo (\`sudo nouride <command>\`), or add your user to the service group:\n` +
            `  sudo usermod -aG nouride $USER && newgrp nouride`,
        );
      }
      throw err;
    }
  }

  /**
   * This install's token goes to this install's daemon, and to no other process.
   *
   * The port is the config's, and a wrong one — another install's config, a variable meant for something else — named
   * a process that was not this daemon, and every request carried the token read from this install's data
   * directory. `/health` says which install answers; the token is sent only when it is this one. One local request,
   * unauthenticated. A token handed in as `$NOURIDE_TOKEN` is for whatever `$NOURIDE_URL` names, and goes there.
   */
  //
  // Asked before the first request rather than here, so a command asked wrongly still says so before anything is
  // reached for — and once, whatever follows.
  let checked: Promise<{ message: string; hint: string } | null> | undefined;
  const refusal = () =>
    (checked ??= (async () => {
      if (process.env.NOURIDE_TOKEN) return null;
      const answering = await probeInstall(baseUrl);
      const mine = installFingerprint(config.daemon.dataDir);
      if (!answering.reached) return { message: `Cannot reach the daemon at ${baseUrl}.`, hint: `Is it running? ${startHint()}` };
      if (answering.install === mine) return null;
      return {
        message:
          answering.install === undefined
            ? `What answers at ${baseUrl} is not this install's daemon, so its token was not sent.`
            : `The daemon at ${baseUrl} belongs to another install (${answering.install}), not this one (${mine}), so its token was not sent.`,
        hint: "Run it from the install whose daemon that is, or set $NOURIDE_URL with $NOURIDE_TOKEN for a daemon elsewhere.",
      };
    })());

  const request = async (method: string, path: string, body?: unknown, soft = false) => {
    /**
     * Exit for a command the user typed; throw for something polled behind their back.
     *
     * Annotated on the variable, not just the return type: TypeScript only narrows control flow through
     * a `never`-returning *function expression* when the annotation is on the binding, so without this
     * every use of `res` after the catch is reported as possibly-unassigned.
     */
    const bail: (message: string, hint?: string, status?: number) => never = (
      message,
      hint,
      status,
    ) => {
      // The hint rides along on the error: `doctor` reports rather than exits, and the hint is the half
      // that says what to do about it. Dropping it turned an actionable diagnosis into a bare complaint.
      //
      // So does the status, and for a sharper reason: a background poller has to tell "this daemon has
      // no such endpoint" (permanent, stop asking) from "that request failed" (transient, try again).
      // Without it both arrive as a bare Error and the only safe reading is the pessimistic one, which
      // is how one dropped connection came to disable the progress feed for a whole session.
      if (soft) throw Object.assign(new Error(message), { hint, status });
      fail(message, hint);
    };

    const refused = await refusal();
    if (refused) bail(refused.message, refused.hint);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/control${path}`, {
        method,
        headers: {
          "x-nouride-token": token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // A request the daemon took up and is still working on — a memory pass filing with a slow model — ends here too
      // when the wait runs out. "Cannot reach the daemon — is it running?" sent the operator to restart one that was
      // busy doing what it was asked (live, 2026-10-21).
      if (isTimeout(err)) {
        bail(
          `The daemon at ${baseUrl} did not answer in time. It may still be working on this.`,
          "Asking again while it runs is refused, not repeated. `nouride logs -n 30` shows what it is doing.",
        );
      }
      bail(`Cannot reach the daemon at ${baseUrl}.`, `Is it running? ${startHint()} (${String(err)})`);
    }

    if (res.status === 401) {
      // Asked only now, and unauthenticated, so the common path pays nothing for a check that only
      // matters when something has already gone wrong.
      const { message, hint } = unauthorizedMessage({
        baseUrl,
        localInstall: installFingerprint(config.daemon.dataDir),
        daemonInstall: await daemonInstall(baseUrl),
        tokenPath,
      });
      bail(message, hint);
    }

    const text = await res.text();
    /**
     * Narrowed once, here, rather than asserted at every call site.
     *
     * A failing route answers `{ error, note }` and this is the only place that shape matters — so it
     * is read defensively and the rest of the body is handed back as whatever the caller declared.
     * The cast on the return is the single unchecked step in the client, and it is where the
     * responsibility moves: the caller names the shape and is checked against it from there on.
     */
    let parsed: unknown = {};
    try {
      if (text) parsed = JSON.parse(text);
    } catch {
      // Not the daemon's answer: a proxy or a tunnel in front of it, answering for a daemon that is restarting or
      // gone — nginx's HTML 502. Said as that, rather than a SyntaxError and a page of this file's source.
      bail(
        `The daemon at ${baseUrl} did not answer: something in front of it did, with ${res.status} ${res.headers.get("content-type") ?? "and no content type"}.`,
        "A proxy answers like this while the daemon restarts. Try again in a moment, or check it with `nouride status`.",
        res.status,
      );
    }
    if (!res.ok) {
      const problem = (parsed ?? {}) as { error?: unknown; note?: unknown };
      bail(
        typeof problem.error === "string" ? problem.error : `HTTP ${res.status}`,
        typeof problem.note === "string" ? problem.note : undefined,
        res.status,
      );
    }
    // A background poll is not the command's answer.
    if (!soft) heard(parsed);
    return parsed;
  };

  return {
    baseUrl,
    get: <T>(path: string) => request("GET", path) as Promise<T>,
    post: <T>(path: string, body?: unknown) => request("POST", path, body) as Promise<T>,
    softGet: <T>(path: string) => request("GET", path, undefined, true) as Promise<T>,
    softPost: <T>(path: string, body?: unknown) => request("POST", path, body, true) as Promise<T>,
    put: <T>(path: string, body?: unknown) => request("PUT", path, body) as Promise<T>,
    patch: <T>(path: string, body?: unknown) => request("PATCH", path, body) as Promise<T>,
    del: <T>(path: string) => request("DELETE", path) as Promise<T>,
    open: async (path: string) => {
      const refused = await refusal();
      if (refused) throw Object.assign(new Error(refused.message), { hint: refused.hint });
      const res = await fetch(`${baseUrl}/api/control${path}`, { headers: { "x-nouride-token": token, accept: "text/event-stream" } });
      // The status kept on the error: a follower retries a dropped stream, and must not retry a refusal for ever.
      if (!res.ok || !res.body) throw Object.assign(new Error(`the daemon answered ${res.status}`), { status: res.status });
      return res.body;
    },
  };
}

/** A wait that ran out, as `fetch` reports it on this runtime or another. */
export function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || /timed out/i.test(String(err));
}
