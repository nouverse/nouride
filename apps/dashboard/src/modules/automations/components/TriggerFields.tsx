/**
 * When a scheduled automation starts: every so often, at a time of day, on a pattern of its own, or once.
 *
 * This part edits one `TriggerDraft` and nothing else, and `lib/trigger.ts` is the only thing that reads one. Nothing
 * here decides whether a time is one the server takes: it is sent as written, and a refusal comes back in words.
 */

import { dayName, describeDraft, WEEKDAYS, type TriggerDraft, type TriggerMode } from "../lib/trigger";
import { Field } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { Segmented } from "./form-parts";

const TRIGGERS: { mode: TriggerMode; label: string }[] = [
  { mode: "interval", label: "Every…" },
  { mode: "daily", label: "At a time" },
  { mode: "once", label: "Once" },
  { mode: "cron", label: "Custom" },
];

const INPUT = "input w-full font-mono text-sm";

function Zone({ trigger, onChange }: { trigger: TriggerDraft; onChange: (patch: Partial<TriggerDraft>) => void }) {
  return (
    <Field label="Time zone" hint="Such as Asia/Jakarta. Empty: the server's own.">
      <input className={INPUT} value={trigger.tz} onChange={(e) => onChange({ tz: e.target.value })} />
    </Field>
  );
}

export function TriggerFields({
  trigger,
  onChange,
  keepAfterRun,
  onKeepAfterRun,
  home,
}: {
  trigger: TriggerDraft;
  onChange: (patch: Partial<TriggerDraft>) => void;
  /** Whether a start at one moment stays listed after it ran; `null` for one that exists, where it is not offered. */
  keepAfterRun: boolean | null;
  onKeepAfterRun: (keep: boolean) => void;
  /** The server's own time zone: one that differs is said in the line under the fields. */
  home: string;
}) {
  return (
    <div className="space-y-3.5">
      <Segmented
        options={TRIGGERS.map((t) => ({ value: t.mode, label: t.label }))}
        value={trigger.mode}
        onChange={(mode) => onChange({ mode: mode as TriggerMode })}
      />

      {trigger.mode === "interval" && (
        <Field label="Run every" hint="Counted from the end of the last run, so a slow one never piles up behind itself.">
          <div className="flex gap-2">
            <input className="input w-24 font-mono text-sm" type="number" min={1} value={trigger.everyCount} onChange={(e) => onChange({ everyCount: e.target.value })} />
            <select className="select w-auto text-sm" aria-label="Unit" value={trigger.everyUnit} onChange={(e) => onChange({ everyUnit: e.target.value as TriggerDraft["everyUnit"] })}>
              <option value="m">minutes</option>
              <option value="h">hours</option>
              <option value="d">days</option>
            </select>
          </div>
        </Field>
      )}

      {trigger.mode === "daily" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Time">
              <input className={INPUT} type="time" value={trigger.time} onChange={(e) => onChange({ time: e.target.value })} />
            </Field>
            <Zone trigger={trigger} onChange={onChange} />
          </div>
          <Field label="Days" hint="None picked means every day.">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day) => {
                const on = trigger.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    className={`min-h-8 rounded-full border px-3 text-xs font-semibold transition-all active:scale-95 ${
                      on ? "border-secondary/30 bg-secondary/10 text-secondary" : "border-base-content/10 bg-base-100 text-base-content/65 hover:text-base-content"
                    }`}
                    onClick={() => onChange({ days: on ? trigger.days.filter((d) => d !== day) : [...trigger.days, day].sort() })}
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
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Pattern" hint="For a time the other tabs cannot say, such as the first of each month.">
              <input className={INPUT} value={trigger.expr} placeholder="0 9 1 * *" onChange={(e) => onChange({ expr: e.target.value })} />
            </Field>
            <Zone trigger={trigger} onChange={onChange} />
          </div>
          <Details>
            <p>Five fields, as a cron expression has them: minute, hour, day of the month, month, day of the week. When both days are set, either one starts it.</p>
          </Details>
        </div>
      )}

      {trigger.mode === "once" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="At" hint="Read in the time zone beside it, not this browser's.">
              <input className={INPUT} type="datetime-local" value={trigger.at} onChange={(e) => onChange({ at: e.target.value })} />
            </Field>
            <Zone trigger={trigger} onChange={onChange} />
          </div>
          {keepAfterRun !== null && (
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" className="checkbox checkbox-primary checkbox-xs mt-0.5" checked={keepAfterRun} onChange={(e) => onKeepAfterRun(e.target.checked)} />
              <span className="text-xs text-base-content/75">
                Keep it in the list after it ran
                <span className="block text-base-content/65">Off unless you say so: something that already happened is a row nobody reads.</span>
              </span>
            </label>
          )}
        </div>
      )}

      <p className="rounded-[14px] bg-base-200/60 px-3 py-2 text-xs text-base-content/75">
        <span className="font-semibold">It starts </span>
        {describeDraft(trigger, home)}
      </p>
    </div>
  );
}
