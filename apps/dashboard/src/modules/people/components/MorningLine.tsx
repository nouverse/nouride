/**
 * A person's morning line (0.8.0): off, or a time of day — 07:00 when first turned on — at which their own chat gets
 * what happened while they were away: runs that failed, what waits on them, missions finished, and for an admin what
 * was spent. A quiet morning sends nothing. Where it goes is theirs to pick among their chat accounts; unpicked, it goes
 * where they last wrote from — it went to the first account in their list before, a Discord its owner did not read.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sun } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { PersonRecord } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";

/** What a morning line is set to the first time it is turned on. */
const FIRST_AT = "07:00";

/** A platform as a person names it. */
const PLATFORM: Record<string, string> = { telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp" };

/** Their accounts a message can reach — every one but the dashboard's — as `telegram:555` and its words. */
function chatAccounts(person: PersonRecord): { id: string; label: string }[] {
  return (person.ids ?? [])
    .filter((id) => !id.startsWith("web:"))
    .map((id) => {
      const at = id.indexOf(":");
      const platform = id.slice(0, at);
      return { id, label: `${PLATFORM[platform] ?? platform} · ${id.slice(at + 1)}` };
    });
}

export function MorningLine({ person, editable, onChanged }: { person: PersonRecord; editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(person.morning ?? FIRST_AT);
  const accounts = chatAccounts(person);
  const save = useMutation({
    mutationFn: (line: { at: string | null; to?: string | null }) => api.setMorningLine(person.key, line.at, line.to),
    onSuccess: (_answer, { at }) => {
      toast.show({ message: at ? `${person.name}'s morning line comes at ${at}` : `${person.name}'s morning line is off`, kind: "success" });
      onChanged();
    },
    onError: (err) => toast.error(`Could not save ${person.name}'s morning line`, err),
  });

  if (!person.morning) {
    return (
      <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg font-medium" disabled={!editable || save.isPending} onClick={() => save.mutate({ at: FIRST_AT })} title="A message each morning on what happened while they were away">
        <Sun size={12} aria-hidden="true" /> Morning line: off
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Sun size={12} aria-hidden="true" className="text-warning" />
      <span className="text-[11px] text-base-content/75">Morning line at</span>
      <input
        type="time"
        className="input input-xs w-24 rounded-lg font-mono"
        aria-label={`${person.name}'s morning line time`}
        value={draft}
        disabled={!editable || save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft && draft !== person.morning && save.mutate({ at: draft })}
      />
      <span className="text-[11px] text-base-content/75">to</span>
      {/* Shrinks to its cell: on a phone the People table is narrow, and a select its own width was cut off at the card. */}
      <select
        className="select select-xs w-auto max-w-full rounded-lg"
        aria-label={`Where ${person.name}'s morning line goes`}
        value={person.morningTo ?? ""}
        disabled={!editable || save.isPending}
        onChange={(e) => save.mutate({ at: person.morning ?? FIRST_AT, to: e.target.value || null })}
      >
        <option value="">where they last wrote from</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-ghost btn-xs rounded-lg" disabled={!editable || save.isPending} onClick={() => save.mutate({ at: null })}>
        Turn off
      </button>
    </div>
  );
}
