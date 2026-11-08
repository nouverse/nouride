/**
 * Whether agents can @mention each other, and how far a chain may go — for the **whole daemon**.
 *
 * It sits on the Agents index beside the other daemon-wide controls because `[agents]
 * mentions_enabled` and `mention_max_hops` are daemon-wide: a control inside one agent's page would
 * silently change what every other agent may do.
 *
 * The toggle and the hop count are saved together in one POST, because they answer one question —
 * "can my agents collaborate" — and saving them independently would mean the operator has to hit
 * Save twice for what feels like one decision.
 *
 * The hop count is an advanced setting (0.8.0): rarely changed, so it sits behind "Advanced" under the
 * switch rather than on the card's first line — the same disclosure the Skills page keeps its settings in.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { MessageSquareShare } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useSaved } from "@/commons/hooks/use-saved";

const MIN_HOPS = 1;
const MAX_HOPS = 20;

export function MentionSettings() {
  const me = useMe();
  const settings = useQuery({
    queryKey: ["mention-settings"],
    queryFn: api.mentionSettings,
    retry: false,
  });
  const queryClient = useQueryClient();

  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftHops, setDraftHops] = useState<string | null>(null);

  // Reset drafts whenever the daemon reports different values — another operator's change, or our
  // own save landing.
  useEffect(() => {
    setDraftEnabled(null);
    setDraftHops(null);
  }, [settings.data?.mentionsEnabled, settings.data?.mentionMaxHops]);

  const saved = useSaved();
  const save = useMutation({
    mutationFn: (input: { mentionsEnabled?: boolean; mentionMaxHops?: number }) =>
      api.setMentionSettings(input),
    onSuccess: (answer, input) => {
      saved(answer, input.mentionsEnabled === undefined ? `Mention chains stop after ${input.mentionMaxHops} hops` : `Agent mentions ${input.mentionsEnabled ? "on" : "off"}`);
      return queryClient.invalidateQueries({ queryKey: ["mention-settings"] });
    },
  });

  // A daemon with no config file to write gets no control rather than a dead one.
  if (settings.error || !settings.data) return null;

  const savedEnabled = settings.data.mentionsEnabled;
  const savedHops = settings.data.mentionMaxHops;

  const currentEnabled = draftEnabled ?? savedEnabled;
  const hopsValue = draftHops ?? String(savedHops);
  const parsedHops = Number.parseInt(hopsValue, 10);
  const hopsValid = Number.isInteger(parsedHops) && parsedHops >= MIN_HOPS && parsedHops <= MAX_HOPS;
  const editable = settings.data.editable !== false;
  const writable = canWrite(me.data ?? null);

  const dirtyEnabled = currentEnabled !== savedEnabled;
  const dirtyHops = hopsValid && parsedHops !== savedHops;
  const dirty = dirtyEnabled || dirtyHops;

  function handleSave() {
    const input: { mentionsEnabled?: boolean; mentionMaxHops?: number } = {};
    if (dirtyEnabled) input.mentionsEnabled = currentEnabled;
    if (dirtyHops) input.mentionMaxHops = parsedHops;
    save.mutate(input);
  }

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            <MessageSquareShare size={15} className={currentEnabled ? "text-info" : "text-base-content/40"} />
            Agent mentions
            <span className="badge badge-xs badge-ghost font-semibold font-mono">all agents</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            {currentEnabled
              ? "Agents can @mention each other in their replies. When one does, the mentioned agent receives the message and may reply, up to a hop limit (under Advanced)."
              : "Off. Agents cannot trigger each other. An @mention in a reply is treated as plain text and does not start a new turn."}
          </p>
          {!editable && <NoSettingsFile keys={["[agents] mentions_enabled", "mention_max_hops"]} />}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-base-content/65 font-medium">
              {currentEnabled ? "On" : "Off"}
            </span>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={currentEnabled}
              disabled={!writable || !editable || save.isPending}
              onChange={(event) => setDraftEnabled(event.target.checked)}
            />
          </label>

          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!writable || !editable || !dirty || save.isPending}
            onClick={handleSave}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Save
          </button>
        </div>
      </div>

      <details className="collapse-arrow bg-base-100 border-base-content/10 collapse rounded-2xl border">
        <summary className="collapse-title text-sm font-medium">
          Advanced
          <span className="ml-2 text-xs font-normal text-base-content/65">a chain stops after {savedHops} hops</span>
        </summary>
        <div className="collapse-content space-y-2">
          <p className="text-base-content/65 text-xs">
            The hop limit prevents runaway chains: after this many agent-to-agent exchanges in a row, the chain stops
            and the last reply is delivered without forwarding. A person saying anything resets the count.
          </p>
          <label className="input input-sm rounded-xl flex items-center gap-2 w-28">
            <input
              type="number"
              min={MIN_HOPS}
              max={MAX_HOPS}
              step={1}
              className="grow text-sm"
              aria-label="Max mention hops"
              value={hopsValue}
              disabled={!writable || !editable || !currentEnabled || save.isPending}
              onChange={(event) => setDraftHops(event.target.value)}
            />
            <span className="text-base-content/65 text-xs whitespace-nowrap">hops</span>
          </label>
        </div>
      </details>

      {!hopsValid && (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <span>Enter a whole number between {MIN_HOPS} and {MAX_HOPS}.</span>
        </div>
      )}

      <ErrorNote error={save.error} />
    </div>
  );
}
