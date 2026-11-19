/**
 * What a person is told when they write to an agent that is already working — `[queue] steer_reply` and
 * `[queue] steer_ack`, for every agent. The message itself is read at the agent's next step either way; these two say
 * only what is sent back at once. Both switches are saved together, as one answer to "what do people see".
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { MessageCircleReply } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useSaved } from "@/commons/hooks/use-saved";

type Switches = { reply: boolean; ack: boolean };

const ROWS: { key: keyof Switches; label: string; about: string }[] = [
  {
    key: "ack",
    label: "Say \"Got it\" at once when a message arrives while the agent works",
    about: "Off: only the agent's own line is sent, and nothing when there is none. On WhatsApp, which cannot change a sent message, \"Got it\" waits for that line either way.",
  },
  {
    key: "reply",
    label: "Answer in the agent's own words what it will do with the message",
    about: "One short line from the agent's model, in place of \"Got it\" where the app can change a sent message, under it where not.",
  },
];

export function SteeringControl() {
  const me = useMe();
  const policy = useQuery({ queryKey: ["steering"], queryFn: api.steeringPolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();
  const [draft, setDraft] = useState<Partial<Switches>>({});
  useEffect(() => setDraft({}), [policy.data?.reply, policy.data?.ack]);

  const save = useMutation({
    mutationFn: (input: Partial<Switches>) => api.setSteering(input),
    onSuccess: (answer) => {
      saved(answer, "Saved what people are told while an agent works");
      return queryClient.invalidateQueries({ queryKey: ["steering"] });
    },
  });

  // A daemon with no config file to write gets no control rather than a dead one.
  if (policy.error || !policy.data) return null;
  const data = policy.data;
  const current: Switches = { reply: draft.reply ?? data.reply, ack: draft.ack ?? data.ack };
  const changed = Object.fromEntries((["reply", "ack"] as const).filter((key) => current[key] !== data[key]).map((key) => [key, current[key]])) as Partial<Switches>;
  const writable = canWrite(me.data ?? null) && data.editable;

  return (
    <section aria-label="While an agent works" className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="min-w-0">
        <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
          <MessageCircleReply size={15} className="text-info" aria-hidden="true" />
          While an agent works
          <span className="badge badge-xs badge-ghost font-semibold font-mono">all agents</span>
        </p>
        <p className="text-base-content/65 text-sm mt-1 max-w-prose">
          A message sent to an agent that is busy is read at its next step. These say what is sent back at once.
        </p>
        {!data.editable && <NoSettingsFile keys={["[queue] steer_ack", "steer_reply"]} />}
      </div>
      <div className="space-y-3">
        {ROWS.map((row) => (
          <label key={row.key} className="flex min-h-11 cursor-pointer items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-base-content">{row.label}</span>
              <span className="block text-xs text-base-content/65 mt-0.5 max-w-prose">{row.about}</span>
            </span>
            <input
              type="checkbox"
              data-steering={row.key}
              className="toggle toggle-sm toggle-primary mt-0.5 shrink-0"
              checked={current[row.key]}
              disabled={!writable || save.isPending}
              onChange={(event) => setDraft((was) => ({ ...was, [row.key]: event.target.checked }))}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
        disabled={!writable || Object.keys(changed).length === 0 || save.isPending}
        onClick={() => save.mutate(changed)}
      >
        {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
        Save
      </button>
      <ErrorNote error={save.error} />
    </section>
  );
}
