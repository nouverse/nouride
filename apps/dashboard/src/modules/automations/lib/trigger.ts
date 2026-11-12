/**
 * Turning a trigger into something a form can hold, and back again.
 *
 * The daemon owns the parsing — `every`, `at` and `cron` all arrive as strings it validates and
 * refuses — so nothing here tries to be a second cron parser. What it does is the inverse: read a
 * stored trigger well enough to reopen the editor on the right tab with the right values in it.
 *
 * That reading is what was missing. The old editor checked `kind === "interval"` (the kind is
 * `"every"`) and read `schedule.every` (the field is `everyMs`), so every interval job opened on the
 * Cron tab with an empty expression — and saving from there rewrote a working `every 15m` job as a
 * cron expression, or as nothing at all.
 */

import type { JobScheduleInput } from "@nouride/wire";

export type TriggerMode = "interval" | "daily" | "cron" | "once";

export interface TriggerDraft {
  mode: TriggerMode;
  /** `interval`: a count and the unit it is counted in. */
  everyCount: string;
  everyUnit: "m" | "h" | "d";
  /** `daily`: `HH:MM` and the weekdays it runs on. Empty set means every day. */
  time: string;
  days: number[];
  /** `cron`: the five fields, as written. */
  expr: string;
  /** `once`: a `datetime-local` value, read in `tz`. */
  at: string;
  tz: string;
}

/** `0 9 * * 1-5` and friends — a cron expression the daily builder could have produced. */
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[\d,\-]+)$/;

export function draftFromTrigger(
  trigger: Record<string, unknown> | undefined,
  timezone: string,
): TriggerDraft {
  const base: TriggerDraft = {
    mode: "interval",
    everyCount: "15",
    everyUnit: "m",
    time: "09:00",
    days: [],
    expr: "0 9 * * *",
    at: "",
    tz: (typeof trigger?.tz === "string" && trigger.tz) || timezone,
  };
  if (!trigger) return base;

  if (trigger.kind === "every" && typeof trigger.everyMs === "number") {
    const { count, unit } = splitInterval(trigger.everyMs);
    return { ...base, mode: "interval", everyCount: String(count), everyUnit: unit };
  }

  if (trigger.kind === "at" && typeof trigger.at === "number") {
    return { ...base, mode: "once", at: localInputValue(trigger.at) };
  }

  if (trigger.kind === "cron" && typeof trigger.expr === "string") {
    const daily = DAILY.exec(trigger.expr.trim());
    if (daily) {
      // Reopened on the friendly tab when it can be: the person who set "weekdays at 09:00" should
      // not have to read `0 9 * * 1-5` back to check it.
      return {
        ...base,
        mode: "daily",
        time: `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`,
        days: parseDays(daily[3]!),
        expr: trigger.expr,
      };
    }
    return { ...base, mode: "cron", expr: trigger.expr };
  }

  return base;
}

/**
 * The trigger fields of a request body — `{}` when the draft says nothing usable.
 *
 * One of `every`, `cron` or `at`, never two: `parseScheduleInput` refuses a body carrying more than
 * one, which is the right refusal and a confusing one to meet from a form.
 */
export function triggerBody(draft: TriggerDraft): JobScheduleInput {
  const tz = draft.tz.trim();
  switch (draft.mode) {
    case "interval": {
      const count = Number(draft.everyCount);
      if (!Number.isFinite(count) || count <= 0) return {};
      return { every: `${Math.floor(count)}${draft.everyUnit}` };
    }
    case "daily": {
      const [hour, minute] = draft.time.split(":");
      if (!hour || !minute) return {};
      // Minute first: cron's field order is the one thing about it everybody gets wrong once.
      const days = draft.days.length > 0 ? [...draft.days].sort().join(",") : "*";
      return { cron: `${Number(minute)} ${Number(hour)} * * ${days}`, ...(tz ? { tz } : {}) };
    }
    case "cron":
      return draft.expr.trim() ? { cron: draft.expr.trim(), ...(tz ? { tz } : {}) } : {};
    case "once":
      // Sent as the operator wrote it, read in `tz` by the daemon — a browser that resolved it to an
      // instant would resolve it in the *browser's* zone, which is not the one on screen.
      return draft.at ? { at: draft.at.replace("T", " "), ...(tz ? { tz } : {}) } : {};
  }
}

/** `M H D * *`: a day of each month at one time, which reads as words without a parser. */
const MONTHLY = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/;
const clock = (hour: string, minute: string): string => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

/**
 * When a draft starts, in the words a person would say it: "every 10 minutes", "every day at 07:00", "on Mon, Wed at
 * 09:00", "once, on a day at 09:00". The zone is said only when it is not the server's own, `home`. A pattern the
 * page cannot read as words is shown as the pattern; an incomplete draft says nothing rather than something wrong.
 */
export function describeDraft(draft: TriggerDraft, home?: string): string {
  const zone = draft.tz.trim() && home && draft.tz.trim() !== home ? ` (${draft.tz.trim()} time)` : "";
  switch (draft.mode) {
    case "interval": {
      const count = Number(draft.everyCount);
      if (!Number.isFinite(count) || count <= 0) return "—";
      const unit = { m: "minute", h: "hour", d: "day" }[draft.everyUnit];
      return count === 1 ? `every ${unit}` : `every ${Math.floor(count)} ${unit}s`;
    }
    case "daily": {
      if (!/^\d{1,2}:\d{2}$/.test(draft.time)) return "—";
      const weekdays = draft.days.length === 5 && [1, 2, 3, 4, 5].every((day) => draft.days.includes(day));
      const when = draft.days.length === 0 || draft.days.length === 7 ? "every day" : weekdays ? "on weekdays" : `on ${draft.days.map(dayName).join(", ")}`;
      return `${when} at ${draft.time}${zone}`;
    }
    case "cron": {
      const expr = draft.expr.trim();
      if (!expr) return "—";
      const monthly = MONTHLY.exec(expr);
      return monthly ? `on day ${Number(monthly[3])} of each month at ${clock(monthly[2]!, monthly[1]!)}${zone}` : `on a pattern of its own (${expr})${zone}`;
    }
    case "once":
      return draft.at ? `once, on ${draft.at.replace("T", " at ")}${zone}` : "—";
  }
}

/** How an automation starts, from what the server keeps of it: a time in words, a call to its address, or a person. */
export function startWords(trigger: Record<string, unknown> | undefined, home: string): string {
  if (trigger?.kind === "manual") return "when you press Run now";
  if (trigger?.kind === "webhook") return "when its address is called";
  return describeDraft(draftFromTrigger(trigger, home), home);
}

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export function dayName(day: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] ?? String(day);
}

/** The largest whole unit the interval divides into, so `3600000` reads as `1h` and not `60m`. */
function splitInterval(ms: number): { count: number; unit: "m" | "h" | "d" } {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % 1440 === 0) return { count: minutes / 1440, unit: "d" };
  if (minutes % 60 === 0) return { count: minutes / 60, unit: "h" };
  return { count: minutes, unit: "m" };
}

/** `1-5` and `1,3,5` both spell a set of weekdays. */
function parseDays(field: string): number[] {
  if (field === "*") return [];
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let day = Number(range[1]); day <= Number(range[2]); day += 1) days.add(day);
      continue;
    }
    const single = Number(part);
    if (Number.isFinite(single)) days.add(single);
  }
  return [...days].sort();
}

/** A timestamp as `datetime-local` wants it: the browser's own zone, seconds dropped. */
function localInputValue(at: number): string {
  const when = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
