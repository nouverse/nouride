/**
 * A mission's own three limits, where it stops to ask whether to go on: the fields a draft is changed with and a new
 * mission is made with, the same in both so a person who learned one knows the other. Tokens are typed in millions, as
 * the Limits card takes them: 250, not 250000000, which nobody reads at a glance.
 */

import { Field } from "@/commons/components/ui/ui";

export const MILLION = 1_000_000;

export interface OwnLimitValues {
  hours: string;
  turns: string;
  /** In millions. */
  tokens: string;
}

/** What a limit typed is, as the daemon takes it: a number, tokens whole. Empty is none of its own. */
export function limitsTyped(values: OwnLimitValues): { hours?: number; turns?: number; tokens?: number } {
  const typed = (text: string) => (text.trim() === "" ? undefined : Number(text.trim()));
  const [hours, turns, tokens] = [typed(values.hours), typed(values.turns), typed(values.tokens)];
  return { ...(hours !== undefined ? { hours } : {}), ...(turns !== undefined ? { turns } : {}), ...(tokens !== undefined ? { tokens: Math.round(tokens * MILLION) } : {}) };
}

/** Whether every limit typed is a number: what is not is said under the fields, and nothing is sent. */
export function limitsAreNumbers(values: OwnLimitValues): boolean {
  return Object.values(limitsTyped(values)).every((value) => Number.isFinite(value));
}

export function OwnLimits({
  values,
  onChange,
  usual,
  note,
}: {
  values: OwnLimitValues;
  onChange: (key: keyof OwnLimitValues, value: string) => void;
  /** The limits every mission starts with, shown in an empty field: what leaving it empty gives. */
  usual?: OwnLimitValues;
  note: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-4 sm:max-w-md">
        <Field label="Hours">
          <input className="input input-sm w-full rounded-xl tabular-nums" inputMode="decimal" value={values.hours} placeholder={usual?.hours} onChange={(e) => onChange("hours", e.target.value)} />
        </Field>
        <Field label="Turns">
          <input className="input input-sm w-full rounded-xl tabular-nums" inputMode="numeric" value={values.turns} placeholder={usual?.turns} onChange={(e) => onChange("turns", e.target.value)} />
        </Field>
        <Field label="Tokens">{/* plain-words-ok: tokens, the unit a model's use is billed in, as the Limits card names it */}
          <span className="input input-sm w-full rounded-xl">
            <input className="min-w-0 grow tabular-nums" inputMode="decimal" value={values.tokens} placeholder={usual?.tokens} onChange={(e) => onChange("tokens", e.target.value)} />
            <span className="text-base-content/65">M</span>
          </span>
        </Field>
      </div>
      <p className="text-[11px] leading-snug text-base-content/65">{note}</p>
    </div>
  );
}
