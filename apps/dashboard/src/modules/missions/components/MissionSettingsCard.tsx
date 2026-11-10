/**
 * `[missions]` on the Missions page: how many run at once, for one agent and on the box, and the three limits a
 * mission stops at to ask whether to go on. Live once saved — the slots at the next start, the limits for missions
 * started after it, since a mission keeps the limits it started with.
 *
 * A field at its default is empty, the default in grey, and an emptied field goes back to it (`lib/limits.ts`): the
 * slots on the box, left so, follow the agents that are on. Each field keeps to the bounds the daemon reports, which are
 * the schema's and the agents'; a value outside them is not sent, and one the daemon refuses anyway is its sentence,
 * under the form.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MissionSettingsPatch } from "@nouride/wire";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { fieldText, limitsPatch, range, shown, type LimitKey } from "../lib/limits";

const FIELDS: { key: LimitKey; label: string; hint: string; step: number | "any"; unit?: string }[] = [
  { key: "perAgent", label: "Per agent", hint: "running at once for one agent", step: 1 },
  { key: "maxRunning", label: "On this server", hint: "running at once across every agent", step: 1 },
  { key: "limitHours", label: "Hours", hint: "of work before it asks to go on (waits on you not counted)", step: 0.25 },
  { key: "limitTurns", label: "Turns", hint: "before it asks to go on", step: 1 },
  { key: "limitTokens", label: "Tokens", hint: "spent before it asks to go on, its helpers and reviewer included", step: "any", unit: "M" }, // plain-words-ok: tokens, the unit a model's use is billed in
];

const MISSION_SETTINGS_KEY = ["mission-settings"] as const;

export function MissionSettingsCard() {
  const me = useMe();
  const queryClient = useQueryClient();
  const saved = useSaved();
  const settings = useQuery({ queryKey: MISSION_SETTINGS_KEY, queryFn: api.missionSettings, retry: false });
  const [draft, setDraft] = useState<Partial<Record<LimitKey, string>>>({});

  const save = useMutation({
    mutationFn: (patch: MissionSettingsPatch) => api.setMissionSettings(patch),
    onSuccess: (result) => {
      // Cleared once saved, and only then: cleared whenever the settings were read again, what a person was typing
      // went the moment the page refetched them (a window brought back into focus), and Save never came on.
      setDraft({});
      queryClient.setQueryData(MISSION_SETTINGS_KEY, result);
      saved(result, "Mission limits saved", "New missions start with these limits.");
    },
  });

  const data = settings.data;
  if (!data) return <ErrorNote error={settings.error} />;
  const writable = canWrite(me.data ?? null) && data.editable;
  const { patch, bad } = limitsPatch(data, draft);
  const changed = Object.keys(patch).length > 0;
  const allDefault = FIELDS.every(({ key }) => (draft[key] ?? fieldText(data, key)).trim() === "");

  return (
    <Card title="Limits" description="How many missions run at once, and where each stops to ask you whether to go on. An empty field is its default.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {FIELDS.map(({ key, label, hint, step, unit }) => {
          const wrong = bad.includes(key);
          const fallback = `${shown(key, data.defaults[key])}${unit ?? ""}`;
          const input = (
            <input
              type="number"
              className={unit ? "min-w-0 grow tabular-nums" : `input input-sm w-full rounded-xl tabular-nums ${wrong ? "input-error" : ""}`}
              min={shown(key, data.bounds[key].min)}
              max={data.bounds[key].max === undefined ? undefined : shown(key, data.bounds[key].max)}
              step={step}
              placeholder={String(shown(key, data.defaults[key]))}
              value={draft[key] ?? fieldText(data, key)}
              disabled={!writable || save.isPending}
              aria-invalid={wrong}
              onChange={(event) => setDraft((d) => ({ ...d, [key]: event.target.value }))}
            />
          );
          return (
            <label key={key} className="block space-y-1">
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-base-content/80">
                {key === "perAgent" ? <Gauge size={12} aria-hidden="true" /> : null}
                {label}
              </span>
              {unit ? (
                <span className={`input input-sm w-full rounded-xl ${wrong ? "input-error" : ""}`}>
                  {input}
                  <span className="text-base-content/65">{unit}</span>
                </span>
              ) : (
                input
              )}
              <span className="block text-[11px] leading-snug text-base-content/65">
                {hint} · <span className="whitespace-nowrap">{range(key, data.bounds[key])}</span>
              </span>
              <span className="block text-[11px] leading-snug text-base-content/65">
                default {fallback}
                {key === "maxRunning" ? " (what this server has room for, at most 4)" : ""}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm rounded-xl"
          disabled={!writable || save.isPending || !changed || bad.length > 0}
          onClick={() => save.mutate(patch)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {Object.keys(draft).length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => setDraft({})}>
            Cancel
          </button>
        )}
        {writable && !allDefault && (
          <button
            type="button"
            className="btn btn-ghost btn-sm rounded-xl"
            onClick={() => setDraft(Object.fromEntries(FIELDS.map(({ key }) => [key, ""])))}
          >
            Back to defaults
          </button>
        )}
        {!writable && <span className="text-[11px] text-base-content/65">An operator or an admin changes these.</span>}
      </div>
      <div className="mt-3">
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}
