/**
 * "When", the second of the job form's questions: an interval, a time of day, a cron expression, or once.
 *
 * Out of `JobForm.tsx`, which had grown past the size cap, along the seam that was already there: this part
 * edits one `TriggerDraft` and nothing else, and `lib/trigger.ts` is the only thing that reads one.
 */

import { dayName, describeDraft, WEEKDAYS, type TriggerDraft, type TriggerMode } from "../lib/trigger";
import { Field } from "@/commons/components/ui/ui";
import { Section, Segmented } from "./form-parts";

const TRIGGERS: { mode: TriggerMode; label: string }[] = [
  { mode: "interval", label: "Every…" },
  { mode: "daily", label: "At a time" },
  { mode: "cron", label: "Cron" },
  { mode: "once", label: "Once" },
];

export function TriggerFields({
  trigger,
  onChange,
  keepAfterRun,
  onKeepAfterRun,
}: {
  trigger: TriggerDraft;
  onChange: (patch: Partial<TriggerDraft>) => void;
  /** Whether a one-off job stays listed after it fires; `null` while editing, where it is not offered. */
  keepAfterRun: boolean | null;
  onKeepAfterRun: (keep: boolean) => void;
}) {
  return (
    <Section title="When">
      <Segmented
        options={TRIGGERS.map((t) => ({ value: t.mode, label: t.label }))}
        value={trigger.mode}
        onChange={(mode) => onChange({ mode: mode as TriggerMode })}
      />

      {trigger.mode === "interval" && (
        <div className="flex items-end gap-2">
          <Field label="Run every" hint="Measured from the end of the last run, so a slow job never queues against itself.">
            <div className="flex gap-2">
              <input
                className="input input-sm w-24 rounded-xl font-mono"
                type="number"
                min={1}
                value={trigger.everyCount}
                onChange={(e) => onChange({ everyCount: e.target.value })}
              />
              <select
                className="select select-sm rounded-xl"
                value={trigger.everyUnit}
                onChange={(e) => onChange({ everyUnit: e.target.value as TriggerDraft["everyUnit"] })}
              >
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
            </div>
          </Field>
        </div>
      )}

      {trigger.mode === "daily" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Time" hint="Read in the timezone below.">
              <input
                className="input input-sm w-full rounded-xl font-mono"
                type="time"
                value={trigger.time}
                onChange={(e) => onChange({ time: e.target.value })}
              />
            </Field>
            <Field label="Timezone" hint="A time zone such as Asia/Jakarta. Empty uses the server's.">
              <input
                className="input input-sm w-full rounded-xl font-mono"
                value={trigger.tz}
                onChange={(e) => onChange({ tz: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Days" hint="None selected means every day.">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day) => {
                const on = trigger.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all active:scale-95 ${
                      on
                        ? "bg-primary text-primary-content border-primary"
                        : "bg-base-100 text-base-content/65 border-base-content/10 hover:text-base-content"
                    }`}
                    onClick={() =>
                      onChange({
                        days: on
                          ? trigger.days.filter((d) => d !== day)
                          : [...trigger.days, day].sort(),
                      })
                    }
                  >
                    {dayName(day)}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      )}

      {trigger.mode === "cron" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Expression"
            hint="Five fields. Day-of-month and day-of-week are OR when both are set."
          >
            <input
              className="input input-sm w-full rounded-xl font-mono"
              value={trigger.expr}
              placeholder="0 9 * * 1-5"
              onChange={(e) => onChange({ expr: e.target.value })}
            />
          </Field>
          <Field label="Timezone" hint="IANA zone.">
            <input
              className="input input-sm w-full rounded-xl font-mono"
              value={trigger.tz}
              onChange={(e) => onChange({ tz: e.target.value })}
            />
          </Field>
        </div>
      )}

      {trigger.mode === "once" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="At" hint="Read in the timezone beside it, not the browser's.">
              <input
                className="input input-sm w-full rounded-xl font-mono"
                type="datetime-local"
                value={trigger.at}
                onChange={(e) => onChange({ at: e.target.value })}
              />
            </Field>
            <Field label="Timezone" hint="IANA zone.">
              <input
                className="input input-sm w-full rounded-xl font-mono"
                value={trigger.tz}
                onChange={(e) => onChange({ tz: e.target.value })}
              />
            </Field>
          </div>
          {keepAfterRun !== null && (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-primary checkbox-xs mt-0.5"
                checked={keepAfterRun}
                onChange={(e) => onKeepAfterRun(e.target.checked)}
              />
              <span className="text-xs text-base-content/75">
                Keep it in the list after it fires
                <span className="block text-[11px] text-base-content/65">
                  Off by default: a reminder that already happened is a row nobody reads.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      <p className="text-[11px] text-base-content/65 bg-base-200/60 rounded-lg px-2.5 py-1.5">
        {describeDraft(trigger)}
      </p>
    </Section>
  );
}
