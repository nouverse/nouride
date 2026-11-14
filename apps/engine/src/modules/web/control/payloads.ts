/**
 * Turning request bodies into the shapes the stores accept.
 *
 * Kept out of the route modules because every one of these is a pure function of an untrusted
 * `Record<string, unknown>` — the part of a route worth testing on its own, and the part that reads
 * as noise inside a handler.
 */

import type { Attachment, Job, JobDelivery, JobPayload, JobSessionMode } from "@nouride/shared";
import type { WebhookSummary } from "@nouride/wire";
import { attachmentTypeFor } from "@nouride/gateways";
import type { JobInput } from "@/modules/cron/cron.store.ts";
import { CronValidationError, type CronField } from "@/modules/cron/validate.ts";
import { parseScheduleInput } from "@/modules/cron/parse.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import { webhookUrl } from "@/modules/web/hooks.ts";
import { hookReach } from "@/modules/web/hook-reach.ts";
import type { ControlDeps } from "./types.ts";

/**
 * A request's JSON body as an object, or null when it is missing, is not JSON, or is JSON of another shape — `null`,
 * an array, a number. Every route reads its body through this: `c.req.json()` answers a body of `null` with `null`,
 * which a `.catch(() => ({}))` lets through, and the route then read a field of it and answered 500 (seen with
 * `/policy/job-quiet`, `/stop` and `/message`).
 */
export async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A provider's extra headers as a form sends them: each name with its value, or with none for a saved header whose
 * value the form was never given (`settings/providers.ts` keeps it). Absent, or anything that is not that shape: the
 * caller leaves the headers it has alone, as a client from before the field does.
 */
export function providerHeaders(raw: unknown): Record<string, string | null> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, typeof value === "string" ? value : null]));
}

/**
 * `attachments: [{ path, mimeType?, filename? }]` from the control API.
 *
 * The path lands in `Attachment.url`, which is what the local gateway reads. Anything unparseable is
 * dropped rather than rejected: a malformed entry should not fail a message that also has text.
 */
export function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Attachment[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : undefined;
    if (!path) return [];

    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
    return [
      {
        type: attachmentTypeFor(mimeType),
        url: path,
        mimeType,
        filename: typeof record.filename === "string" ? record.filename : path.split("/").pop(),
      },
    ];
  });
}

/** A validation refusal from the cron layer, whichever of the two shapes it arrived in. */
export function isCronRefusal(err: unknown): boolean {
  return err instanceof CronValidationError || (err as Error)?.name === "CronParseError";
}

/** The field of a job a cron refusal is about (0.8.23): its own, or when it runs, for an expression or a zone refused. */
export function cronRefusalField(err: unknown): CronField | undefined {
  return err instanceof CronValidationError ? err.field : (err as Error)?.name === "CronParseError" ? "schedule" : undefined;
}

function cronPayloadFrom(raw: unknown): JobPayload {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const kind = payload.kind;

  if (kind === "systemEvent") return { kind, text: String(payload.text ?? "") };
  if (kind === "agentTurn") {
    return {
      kind,
      message: String(payload.message ?? ""),
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    };
  }
  if (kind === "command") {
    return {
      kind,
      argv: Array.isArray(payload.argv) ? payload.argv.map(String) : [],
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.timeoutMs === "number" ? { timeoutMs: payload.timeoutMs } : {}),
      // Defaulting to `deliver` and not `agentTurn`: the cheap answer is the safe default, and a
      // caller who wants the output interpreted has said so.
      then: payload.then === "agentTurn" ? "agentTurn" : "deliver",
    };
  }
  if (kind === "mission") {
    const checks = Array.isArray(payload.checks) ? payload.checks.map(String).map((check) => check.trim()).filter(Boolean) : [];
    return {
      kind,
      goal: String(payload.goal ?? "").trim(),
      ...(checks.length > 0 ? { checks } : {}),
      // `false` turns the reviewer off; criteria in words, or nothing for the goal itself.
      ...(payload.review === false ? { review: false } : typeof payload.review === "string" && payload.review.trim() ? { review: payload.review.trim() } : {}),
    };
  }
  if (kind === "steps") return { kind, steps: stepsFrom(payload.steps) };
  throw new CronValidationError('`payload.kind` must be "systemEvent", "agentTurn", "command", "mission" or "steps".', "kind");
}

function cronDeliveryFrom(raw: unknown): JobDelivery | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const delivery = raw as Record<string, unknown>;
  const mode = delivery.mode;
  if (mode !== "announce" && mode !== "none" && mode !== "webhook") {
    throw new CronValidationError('`delivery.mode` must be "announce", "none" or "webhook".', "delivery");
  }
  return {
    mode,
    ...(typeof delivery.gatewayId === "string" ? { gatewayId: delivery.gatewayId } : {}),
    ...(typeof delivery.chatId === "string" ? { chatId: delivery.chatId } : {}),
    ...(typeof delivery.webhookUrl === "string" ? { webhookUrl: delivery.webhookUrl } : {}),
    ...(delivery.once === true ? { once: true as const } : {}),
    ...(delivery.atOnce === true ? { atOnce: true as const } : {}),
  };
}

/**
 * A webhook as its two callers need it.
 *
 * `path` is for the dashboard, which knows its own origin and should use it — the browser is already
 * talking to whatever name actually reaches this daemon. `url` is for the CLI, which has no such
 * luxury and would otherwise print the bind address. `urlGuessed` says which of the two `url` is,
 * so a caller showing it to a person can say so rather than asserting an address that reaches nobody.
 */
export function webhookView(job: Job, deps: ControlDeps): WebhookSummary {
  const built = webhookUrl(deps.ctx.config.dashboard, job.webhookToken ?? "");
  return {
    ...job,
    webhookToken: job.webhookToken ?? "",
    path: `/hooks/${job.webhookToken}`,
    url: built.url,
    urlGuessed: built.guessed,
    reach: hookReach(deps.ctx.config.dashboard, job),
  };
}

export function cronInputFrom(
  body: Record<string, unknown>,
  actor: string,
  timezone: string,
  /**
   * Fields the caller has already decided.
   *
   * Used by `/webhooks`, where the schedule is not something the request gets a say in — there is
   * nothing to parse, and letting `at`/`every`/`cron` through would accept a body that reads like it
   * scheduled something and did not.
   */
  override: Partial<JobInput> = {},
): JobInput {
  const target = (body.target ?? {}) as Record<string, unknown>;
  return {
    agentId: String(body.agentId ?? ""),
    name: String(body.name ?? ""),
    // Not parsed at all when the caller already decided: `parseScheduleInput` refuses a body with no
    // `at`/`every`/`cron`, which is every webhook request there will ever be.
    trigger:       override.trigger ??
      parseScheduleInput(
        {
          ...(typeof body.at === "string" ? { at: body.at } : {}),
          ...(typeof body.every === "string" ? { every: body.every } : {}),
          ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
          ...(typeof body.tz === "string" ? { tz: body.tz } : {}),
          ...(body.manual === true ? { manual: true } : {}),
        },
        Date.now(),
        timezone,
      ),
    payload: cronPayloadFrom(body.payload),
    target: { gatewayId: String(target.gatewayId ?? ""), chatId: String(target.chatId ?? "") },
    // Absent means the store's default (`fresh`), not `chat` — a caller that says nothing about
    // history is not asking for the target conversation's.
    ...(isSessionMode(body.session) ? { session: body.session } : {}),
    ...(cronDeliveryFrom(body.delivery) ? { delivery: cronDeliveryFrom(body.delivery)! } : {}),
    keepAfterRun: body.keepAfterRun === true,
    createdBy: actor,
    ...override,
  };
}

/** One of the three history modes, or nothing — an unknown string leaves the stored value alone. */
function isSessionMode(value: unknown): value is JobSessionMode {
  return value === "chat" || value === "isolated" || value === "fresh";
}

export function cronPatchFrom(body: Record<string, unknown>, timezone: string): Partial<JobInput> {
  const scheduleGiven =
    typeof body.at === "string" || typeof body.every === "string" || typeof body.cron === "string" || body.manual === true;
  const target = body.target as Record<string, unknown> | undefined;

  return {
    ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(scheduleGiven
      ? {
          trigger: parseScheduleInput(
            {
              ...(typeof body.at === "string" ? { at: body.at } : {}),
              ...(typeof body.every === "string" ? { every: body.every } : {}),
              ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
              ...(typeof body.tz === "string" ? { tz: body.tz } : {}),
              ...(body.manual === true ? { manual: true } : {}),
            },
            Date.now(),
            timezone,
          ),
        }
      : {}),
    ...(body.payload ? { payload: cronPayloadFrom(body.payload) } : {}),
    ...(cronDeliveryFrom(body.delivery) ? { delivery: cronDeliveryFrom(body.delivery)! } : {}),
    ...(target
      ? { target: { gatewayId: String(target.gatewayId ?? ""), chatId: String(target.chatId ?? "") } }
      : {}),
    ...(isSessionMode(body.session) ? { session: body.session } : {}),
    ...(typeof body.keepAfterRun === "boolean" ? { keepAfterRun: body.keepAfterRun } : {}),
  };
}
