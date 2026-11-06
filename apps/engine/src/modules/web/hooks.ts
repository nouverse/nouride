/**
 * `POST /hooks/:token` — the inbound trigger.
 *
 * The one route on this daemon that answers an unauthenticated request, which is the whole reason it
 * is a file of its own rather than four lines in `web/control/`: everything mounted there sits behind
 * a session check, and a public route added next to them is a public route somebody later assumes is
 * protected. The rules it lives by are all here.
 *
 * **The token is the credential.** 32 random bytes, minted by the store, matched by a unique index.
 * There is nothing else to check and nothing else to get wrong — no per-request signature scheme, no
 * allowlist. Anyone holding the URL can fire the job, which is exactly the contract of a webhook URL
 * and is why the dashboard offers rotation.
 *
 * **An unknown token is a 404, and so is a disabled job.** The same 404, with the same body. A
 * scanner must not be able to tell "no such webhook" from "that one exists but is switched off" —
 * the second answer confirms a token was guessed correctly, which is the one thing worth hiding.
 *
 * **It answers before the work finishes.** A GitHub delivery times out in ten seconds; an
 * `agentTurn` takes far longer than that. Holding the connection would turn every real job into a
 * failed delivery and a retry storm, so the run is started and 202 is returned with the job's id. Where
 * the caller genuinely wants the outcome — a person testing the thing they just built — `?wait=1`
 * asks for it explicitly.
 *
 * **It is rate limited, per token.** `Scheduler.runNow` refusing a second start while one is
 * running was described here as what stopped a leaked URL running up a provider bill, and it is
 * not: it serialises a flood rather than ending it, and the two payload kinds that need no model
 * finish fast enough to cycle. See `limiter` below for the shape and why the key is the token.
 */

import type { Hono } from "hono";
import { createLogger, rateLimit } from "@nouride/shared";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { CronScheduler } from "@/modules/cron/scheduler.ts";
import { TEST_HEADER, type HookTests } from "./hook-reach.ts";
import { publicBase } from "./links.ts";

const log = createLogger("hooks");

/**
 * Read no further than this from a request body.
 *
 * The model is shown less again (`MAX_TRIGGER_BODY_CHARS`), but the cap has to exist at the socket
 * too — an endpoint that buffers whatever it is sent is a way to exhaust memory with one request,
 * and it needs no credential to try.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The brake, counted per token.
 *
 * There was none until now, and `Scheduler.runNow` refusing a *concurrent* start is not one: it
 * serialises a flood without ending it. What that left open differed by payload kind and all three
 * were real — an `agentTurn` kept permanently busy is an unbounded provider bill, a `systemEvent`
 * finishes in about a millisecond so it can cycle as fast as HTTP allows and spam the target chat,
 * and a `command` runs a shell line per request.
 *
 * **Per token, not per address.** The token is the credential, so it is what is being abused and
 * what a legitimate caller keeps; an address is neither. Counting by IP would put a CI runner and a
 * crawler behind one NAT on a shared limit they have no relationship to, and would cost an attacker
 * holding the URL nothing at all to evade.
 *
 * 60 a minute, refilling continuously, so a build system firing a burst at the end of a run is
 * unaffected and a loop is held at one a second. A caller that genuinely needs more than that is
 * not what this endpoint is for; the limit is a constant rather than a config key until somebody
 * has that problem, because a knob nobody needs is a knob set wrong.
 */
const CALLS_PER_MINUTE = 60;

/**
 * The address to hand a person for a webhook.
 *
 * One implementation, because the daemon's bound interface and its reachable address are different
 * things and every caller that guesses gets it wrong the same way. `[dashboard] public_url` is the
 * answer when it is set; without it this is `host:port`, which is right for a local install and
 * reaches nobody from outside — so callers that show it to a human say which of the two they have.
 */
export function webhookUrl(
  dashboard: { publicUrl: string; host: string; port: number },
  token: string,
): { url: string; guessed: boolean } {
  const base = publicBase(dashboard);
  if (base) return { url: `${base}/hooks/${token}`, guessed: false };

  // `0.0.0.0` is a bind address, not somewhere anyone can connect to. Shown as localhost because
  // that is at least true from the machine the daemon is on.
  const host = dashboard.host === "0.0.0.0" || dashboard.host === "::" ? "localhost" : dashboard.host;
  return { url: `http://${host}:${dashboard.port}/hooks/${token}`, guessed: true };
}

export interface HooksDeps {
  cron?: { store: CronPort; scheduler: CronScheduler };
  /** The tests the daemon sends through its own public address (`hook-reach.ts`), counted here when they arrive. */
  tests?: HookTests;
}

export function mountHooks(app: Hono, deps: HooksDeps): void {
  // Per mount, not per module: one daemon mounts once, and a module-level bucket map would be
  // shared between every test in a file — where one test firing sixty requests would silently
  // start refusing the next test's first one.
  const limiter = rateLimit({ name: "webhook", by: "token", limit: CALLS_PER_MINUTE, window: "1m" });

  app.post("/hooks/:token", async (c) => {
    if (!deps.cron) return c.json({ error: "the scheduler is not enabled" }, 501);

    const token = c.req.param("token");
    const job = deps.cron.store.byWebhookToken(token);

    // Deliberately identical for "no such token", "that job is not a webhook", and "it is switched
    // off". See the header: distinguishing them tells a scanner when it has guessed right.
    if (!job || job.trigger.kind !== "webhook" || !job.enabled) {
      log.warn("webhook rejected", { token_prefix: token.slice(0, 8), matched: Boolean(job) });
      return c.json({ error: "no such webhook" }, 404);
    }

    /**
     * After the token is matched, deliberately.
     *
     * Rate-limiting before the lookup would count unknown tokens too, which sounds stricter and is
     * worse: a scanner would then consume the allowance of whichever real token it eventually
     * guesses, and a 429 where a 404 belongs tells it that *something* about the request was
     * interesting. An unknown token still costs one indexed lookup and nothing else.
     */
    const verdict = limiter.check(token);
    if (!verdict.ok) {
      log.warn("webhook rate limited", { job: job.id, name: job.name, retry_after_ms: verdict.retryAfterMs });
      c.header("retry-after", String(Math.ceil(verdict.retryAfterMs / 1000)));
      return c.json(
        {
          error: `too many calls to this webhook: it accepts ${CALLS_PER_MINUTE} a minute`,
          retryAfterMs: verdict.retryAfterMs,
        },
        429,
      );
    }

    const body = await readBody(c.req.raw);
    if (body === null) {
      return c.json({ error: `the body is larger than the ${MAX_BODY_BYTES} byte limit` }, 413);
    }

    /**
     * A test through the public address (`hook-reach.ts`): counted, answered, and never run — a person checking whether
     * GitHub can reach the box must not start the job and post to its chat. A word this daemon did not hand out is
     * refused rather than run, so the header cannot be used to pass a call off as anything but a test either.
     */
    const testWord = c.req.header(TEST_HEADER);
    if (testWord !== undefined) {
      const counted = deps.tests?.arrived(testWord, job.id) ?? false;
      log.info("webhook test arrived", { job: job.id, counted });
      return counted ? c.json({ job: job.id, test: "arrived" }) : c.json({ error: "not a test this daemon is waiting for" }, 400);
    }

    const source = c.req.header("user-agent") ?? "unknown";
    log.info("webhook fired", {
      job: job.id,
      name: job.name,
      agent_id: job.agentId,
      source,
      body_bytes: body.length,
    });

    const trigger = { ...(body ? { body } : {}), source };

    // The caller asked to be told how it went. Only a person does this — it is how you find out
    // whether the job you just wrote works without going to look at the run list.
    if (c.req.query("wait") === "1" || c.req.query("wait") === "true") {
      const outcome = await deps.cron.scheduler.runNow(job.id, "webhook", trigger);
      const status = outcome.status === "unavailable" ? 409 : outcome.status === "error" ? 500 : 200;
      return c.json({ job: job.id, outcome }, status);
    }

    /**
     * Asked before starting, because the start is not awaited and its refusal would never reach the
     * caller: this answered 202 *accepted* for a delivery `runNow` then refused — the job still
     * running — and no run was recorded anywhere, so the event simply vanished. Checked here and
     * acted on in the same tick, so no other request can start the job in between.
     */
    if (deps.cron.scheduler.isRunning(job.id)) {
      log.info("webhook refused: the job is still running", { job: job.id, source });
      return c.json({ job: job.id, accepted: false, reason: "that job is already running" }, 409);
    }

    // Not awaited, and its rejection is handled rather than left to the process: `execute` records
    // every outcome against the job, so there is nothing here that needs to survive to be seen.
    void deps.cron.scheduler.runNow(job.id, "webhook", trigger).catch((err: unknown) => {
      log.error("webhook run threw", { job: job.id, error: String(err) });
    });

    return c.json({ job: job.id, accepted: true }, 202);
  });
}

/**
 * The body as text, or null when it is over the cap.
 *
 * Checked against `content-length` first and then against what actually arrived, because the header
 * is written by the caller and a request that lies about its length is exactly the request this cap
 * exists for.
 */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const text = await request.text().catch(() => "");
  return text.length > MAX_BODY_BYTES ? null : text;
}
