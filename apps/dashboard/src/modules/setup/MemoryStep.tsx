/**
 * The wizard's last step: whether the agent remembers, and what it may learn.
 *
 * Here rather than left on its default because the nightly pass spends model calls while nobody is
 * watching, and a person should choose that before the first night, not find it on a bill.
 *
 * Every switch starts on — the suggestion — and `[memory]` stays off until this step answers, so this
 * is what turns memory on. Three choices, one depending on the other two:
 *
 * - **Remember conversations** is the nightly pass, and when. Off, nothing is learned either.
 * - **Learn about you** keeps what the pass finds about a person at once (`facts = "auto"`): chosen
 *   here, it is meant to run on its own, with no Proposals to answer.
 * - **Learn shared knowledge** lets the pass suggest what every agent should know; each one still
 *   waits for a person, since it is read in every chat.
 *
 * "Skip for now" turns all of it off. Everything is under Dashboard → Memory afterwards, where the
 * words can be longer.
 */

import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Brain, Check, Loader2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SettingsPatch } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";

export interface MemoryChoice {
  remember: boolean;
  at: string;
  learn: boolean;
  shared: boolean;
}

/** What the step saves. Learning needs the pass: with it off, nothing is learned whatever the other switches say. */
export function memorySettingsFor(choice: MemoryChoice): SettingsPatch {
  if (!choice.remember) return { pass: false, facts: "off", proposeShared: false };
  return { pass: true, passAt: choice.at, facts: choice.learn ? "auto" : "off", proposeShared: choice.shared };
}

export function MemoryStep() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const [choice, setChoice] = useState<MemoryChoice>({ remember: true, at: "01:00", learn: true, shared: true });
  useEffect(() => {
    if (settings.data) setChoice((current) => ({ ...current, at: settings.data.passAt }));
  }, [settings.data]);
  const set = (patch: Partial<MemoryChoice>) => setChoice((current) => ({ ...current, ...patch }));

  const finish = useMutation({
    mutationFn: (chosen: MemoryChoice) => api.setMemorySettings(memorySettingsFor(chosen)),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      void navigate({ to: "/" });
    },
  });
  const busy = finish.isPending || settings.isLoading;

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-6 sm:p-8 shadow-soft space-y-5">
      <div className="flex items-center gap-2 text-success text-xs font-semibold">
        <Check size={16} />
        <span>Agent created. One last thing.</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-primary" />
          <h2 className="font-semibold">Let your agent get to know you</h2>
        </div>
        <p className="text-base-content/70 text-sm leading-relaxed">
          Each night, your agent looks back on the day's chats, so next time it remembers what matters. What you say in private stays private.
        </p>
      </div>

      {settings.error ? <ErrorNote error={settings.error} /> : null}

      <div className="rounded-2xl border border-base-content/[0.08] bg-base-200/40 p-4 space-y-4">
        <ToggleRow label="Remember conversations" hint="A short note about each chat, made once a night." checked={choice.remember} disabled={busy} onChange={(remember) => set({ remember })} />
        {choice.remember ? (
          <>
            <label className="ml-12 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-base-content/70">Every night at</span>
              <input type="time" className="input input-sm w-32 rounded-xl" value={choice.at} disabled={busy} onChange={(event) => set({ at: event.target.value })} />
            </label>
            <ToggleRow label="Learn about you" hint="Your preferences, plans and dates to remember. Kept right away." checked={choice.learn} disabled={busy} onChange={(learn) => set({ learn })} />
            <ToggleRow label="Learn shared knowledge" hint="Things every agent should know, like house rules. You approve each one." checked={choice.shared} disabled={busy} onChange={(shared) => set({ shared })} />
          </>
        ) : (
          <p className="text-base-content/65 ml-12 text-xs">Your chats are still kept. Your agent just won't learn from them.</p>
        )}
      </div>

      <p className="text-base-content/65 text-xs">Uses your model once a night. You can change this any time in Dashboard → Memory.</p>

      {finish.error ? <ErrorNote error={finish.error} /> : null}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button type="button" className="btn btn-primary rounded-xl sm:flex-1" disabled={busy} onClick={() => finish.mutate(choice)}>
          {finish.isPending ? <Loader2 size={16} className="animate-spin" /> : null} Finish setup
        </button>
        <button type="button" className="btn btn-ghost rounded-xl" disabled={busy} onClick={() => finish.mutate({ ...choice, remember: false })}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
