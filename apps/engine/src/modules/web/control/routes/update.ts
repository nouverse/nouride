/**
 * Is this daemon out of date, and can it do anything about it.
 *
 * Five routes and a deliberate asymmetry. The check is a read that any signed-in account may
 * make — knowing whether the thing you rely on is current is not a privilege. Everything that
 * *acts* is admin-only, and the reason is worth being precise about: an operator sitting in the
 * dashboard is not going through the agent's approval gate, so these routes are the last check
 * before the swap rather than one of two.
 *
 * The agent's path is entirely separate — the `update` tool's own gate puts it on the fixed list (`replace`): asked
 * every time under `careful`, and never grantable.
 *
 * ## Why downloading and installing are separate routes
 *
 * Because they have separate consequences and deserve separate answers. Downloading costs
 * bandwidth and disk and can be stopped; installing costs the daemon and cannot. A single
 * button that did both would be asking one question about two different things.
 */

import type { Context } from "hono";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import {
  checkForUpdate,
  describeInstall,
  discardDownload,
  downloadState,
  pauseDownload,
  startDownload,
  updateSupported,
} from "@/modules/update/index.ts";
import { busyWith, runSelfUpdate, workingJobs, type SelfUpdateTarget } from "@/modules/update/self-update.ts";
import type { ControlApp, ControlDeps, ControlEnv } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

/** A request on the control sub-app, as `ControlApp` types it, for a handler two routes share. */
type ControlContext = Context<{ Variables: { principal: Principal }; Bindings: ControlEnv }>;

/**
 * What these routes do to the update module: the module itself, or what a test hands in as `ControlDeps.updates`.
 *
 * The module's state is the process's — one provider, one transfer — so a route test could only reach it by
 * replacing the module, and a replaced module stays replaced for every test file after it in the run. Nothing
 * pinned the admin gate on the routes that swap the binary, the all-three-or-none rule, or the delay's bounds.
 */
export interface UpdateOps {
  updateSupported: typeof updateSupported;
  describeInstall: typeof describeInstall;
  checkForUpdate: typeof checkForUpdate;
  downloadState: typeof downloadState;
  startDownload: typeof startDownload;
  pauseDownload: typeof pauseDownload;
  discardDownload: typeof discardDownload;
  runSelfUpdate: typeof runSelfUpdate;
}

const MODULE_OPS: UpdateOps = {
  updateSupported,
  describeInstall,
  checkForUpdate,
  downloadState,
  startDownload,
  pauseDownload,
  discardDownload,
  runSelfUpdate,
};

/** The default turn an update comes back to, when the caller aimed one and said nothing about it. */
const DEFAULT_FOLLOW_UP = "Confirm the daemon came back on the new version and every gateway reconnected.";

/**
 * What a caller asked to happen once the update is done, or why it cannot be had. Pure, and shared by `apply` and
 * `install`, which carried a copy each.
 *
 * All three of agent, gateway and chat, or none. Two of three is a follow-up aimed at a conversation that does not
 * exist, which is worse than no follow-up: it fires, fails to deliver, and the person who asked hears nothing either
 * way. None is the watched case — an operator with the page open, or at a terminal — see `SelfUpdateTarget`.
 *
 * The delay is clamped to 10..600 seconds: the shutdown, the supervisor's restart delay and the new process's boot
 * have to fit before the turn fires, and a turn an hour later is one nobody connects to what it followed.
 */
export function followUpFrom(body: Record<string, unknown>): { error: string } | { target: SelfUpdateTarget; delaySeconds: number } {
  const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
  const gatewayId = typeof body.gateway_id === "string" ? body.gateway_id : "";
  const chatId = typeof body.chat_id === "string" ? body.chat_id : "";
  const aimed = [agentId, gatewayId, chatId].filter(Boolean).length;
  if (aimed !== 0 && aimed !== 3) return { error: "give agent_id, gateway_id and chat_id together, or none of them" };

  const message = typeof body.then === "string" && body.then.trim().length > 0 ? body.then.trim() : DEFAULT_FOLLOW_UP;
  const raw = typeof body.in_seconds === "number" ? body.in_seconds : 20;
  const delaySeconds = Math.min(600, Math.max(10, Math.floor(raw)));
  return { target: aimed === 3 ? { message, delaySeconds, agentId, gatewayId, chatId } : { watched: true }, delaySeconds };
}

export function registerUpdateRoutes(control: ControlApp, deps: ControlDeps): void {
  const dataDir = (): string => deps.ctx.config.daemon.dataDir;
  const ops = deps.updates ?? MODULE_OPS;

  control.get("/update", async (c) => {
    const install = await ops.describeInstall(dataDir());
    if (!ops.updateSupported()) {
      // 200, not an error: "this build cannot check" is an answer about the build, and the
      // dashboard renders it as a state rather than as a failed request.
      return c.json({ supported: false, install, download: ops.downloadState() });
    }
    try {
      return c.json({
        supported: true,
        install,
        download: ops.downloadState(),
        // `?force=1` is the Check again button. A poll must never force — that is the
        // rate-limit outage the cache exists to prevent, wearing a query parameter.
        check: await ops.checkForUpdate(dataDir(), c.req.query("force") === "1"),
      });
    } catch (err) {
      /**
       * The channel being unreachable is not a server error here — it is the answer, and it is
       * the common one on a box behind a proxy that does not allow it out. Reported as data so
       * the dashboard can say "could not reach the release channel" instead of showing a
       * spinner that never resolves.
       */
      return c.json({
        supported: true,
        install,
        download: ops.downloadState(),
        error: err instanceof Error ? err.message : String(err),
        plain: "Nouride could not check for updates just now. Try again in a moment.",
      });
    }
  });

  /**
   * Progress, and nothing else.
   *
   * Separate from `GET /update` because the two are asked at completely different rates. A
   * transfer needs a reading every second to look alive; the release check needs one every few
   * minutes at most, and asking it every second is what exhausted an hourly API budget in
   * under a minute. One endpoint served both, so the cheap question dragged the expensive one
   * along behind it.
   *
   * Nothing here touches the channel — it reads a counter the download is already keeping.
   */
  control.get("/update/progress", (c) => c.json({ download: ops.downloadState() }));

  /**
   * The track (0.8.18): `latest` or `lts`. Admin, as everything that decides what replaces the binary is. The answer
   * is the check on the new track, so the page shows what it now offers without asking twice.
   */
  control.post("/update/track", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.setUpdateTrack({ track: typeof body.track === "string" ? body.track : "", actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    const track = deps.ctx.config.update.track;
    if (!ops.updateSupported()) return c.json({ ok: true, track });
    try {
      return c.json({ ok: true, track, check: await ops.checkForUpdate(dataDir()) });
    } catch (err) {
      return c.json({ ok: true, track, error: err instanceof Error ? err.message : String(err), plain: "Saved, but Nouride could not check for updates just now. Try again in a moment." });
    }
  });

  /** Start, or pick up where a pause left off. Returns immediately; progress is on `/update/progress`. */
  control.post("/update/download", async (c) => {
    const denied = guard(c, ops);
    if (denied) return denied;
    try {
      const started = await ops.startDownload(dataDir());
      deps.audit.record({
        action: "daemon_update_download",
        actor: c.get("principal").actor,
        details: { to: started.check.latest },
      });
      return c.json({ ok: true, ...started });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), plain: "The update did not download. Try again in a moment." }, 409);
    }
  });

  control.post("/update/pause", (c) => {
    const denied = guard(c, ops);
    if (denied) return denied;
    return c.json({ ok: true, download: ops.pauseDownload() });
  });

  /** Throw the partial away. Separate from pause: one is "later", the other is "no". */
  control.post("/update/discard", async (c) => {
    const denied = guard(c, ops);
    if (denied) return denied;
    return c.json({ ok: true, download: await ops.discardDownload() });
  });

  /**
   * The one-shot: download, verify, swap, restart — and schedule the turn that reports back.
   *
   * Restored, because removing it broke the only path the CLI has. The commit that gave the
   * dashboard its three steps replaced this route with `download`/`pause`/`discard`/`install` and
   * did not touch `cli/commands/update.ts`, which still posts here — so `nouride update --then …`
   * answered `not_found` on every install from v0.4.0 onward, in the CLI, and for the agent, which
   * is told to use exactly that command. It reads as the release being missing rather than as a
   * route being gone, and an agent met by it goes looking for a way to do the job by hand.
   *
   * Kept beside the three rather than rebuilt out of them. The dashboard splits the steps because a
   * person watching a progress bar can stop it; a CLI invocation and an agent turn cannot pause
   * anything, and asking them to poll would be a worse answer to the same question.
   */
  control.post("/update/apply", (c) => selfUpdate(c, false));

  /**
   * The dashboard's second step. It downloads first, so by here the file is on disk and only the swap is left —
   * which is what `staged` says, and what stops the install starting a second download.
   */
  control.post("/update/install", (c) => selfUpdate(c, true));

  /** `apply` and `install`: the same gate, the same follow-up, the same audit record — one difference, `staged`. */
  async function selfUpdate(c: ControlContext, install: boolean): Promise<Response> {
    const denied = guard(c, ops);
    if (denied) return denied;
    if (!deps.cron) return c.json({ error: "the scheduler is off, so no follow-up turn can be scheduled" }, 409);

    const principal = c.get("principal");
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const followUp = followUpFrom(body);
    if ("error" in followUp) return c.json({ error: followUp.error, plain: INCOMPLETE }, 400);

    try {
      const result = await ops.runSelfUpdate(
        {
          dataDir: dataDir(),
          cron: deps.cron.store,
          requestRestart: (reason) => deps.requestRestart?.(reason),
          // Waits for idle, so an update never cuts a turn or a background job in half — unless the caller said now.
          busy: busyWith(deps.pipeline, deps.jobs),
          jobs: workingJobs(deps.jobs, deps.pipeline),
          immediately: body.now === true,
          ...(install ? { staged: ops.downloadState().status === "ready" } : {}),
        },
        followUp.target,
      );
      deps.audit.record({ action: "daemon_update", actor: principal.actor, details: { to: result.to } });
      // Worded for the page from when it restarts (0.8.20): the note names the files it replaced and where the old ones are.
      const plain =
        result.restart === "jobs"
          ? `The update to ${result.to} is installed. Nouride restarts once its background work is done, however long that takes.`
          : result.restart === "idle"
            ? `The update to ${result.to} is installed. Nouride restarts as soon as nothing is running, within ten minutes.`
            : `The update to ${result.to} is installed. Nouride is restarting now.`;
      return c.json({ ok: true, ...result, plain, wake_in_seconds: followUp.delaySeconds });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), plain: "The update did not install. Try again in a moment." }, 409);
    }
  }
}

/**
 * Admin only, and only on a build that can do it at all.
 *
 * One answer for every route that acts, because a copy of the same two checks per route is how one of them ends up
 * missing a check the others have: `apply` carried its own, and was the one the CLI and the agent use.
 */
interface GuardedContext {
  get(key: "principal"): Parameters<typeof atLeast>[0];
  json(body: unknown, status: 403 | 501): Response;
}

function guard(c: GuardedContext, ops: Pick<UpdateOps, "updateSupported">): Response | null {
  if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
  if (!ops.updateSupported()) return c.json({ error: "this build has no update provider" }, 501);
  return null;
}
