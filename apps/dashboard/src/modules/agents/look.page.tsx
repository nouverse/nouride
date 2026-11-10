/**
 * An agent's Look (0.8.1): its cat in the Office, part by part, drawn as it will be. Each part is one a person picks or
 * the one its id gives — and the page says which that is — so an agent nobody styled keeps the look it always had.
 * Saved to `[look]` in its pack.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/commons/lib/api";
import { LOOK_PARTS, lookApi } from "@/commons/lib/api.look";
import type { AgentLook } from "@nouride/wire";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { looksOf, type Look } from "@/commons/cat/look";
import { CatPortrait } from "@/commons/cat/CatPortrait";
import type { Pose } from "@/commons/cat/compose";
import { CardLoading } from "@/commons/components/ui/Skeleton";

type Part = keyof AgentLook;
const PARTS: { part: Part; label: string }[] = [
  { part: "fur", label: "Fur" },
  { part: "pattern", label: "Pattern" },
  { part: "outfit", label: "Outfit" },
  { part: "outfitColor", label: "Outfit colour" },
  { part: "hat", label: "Hat" },
  { part: "accessory", label: "Accessory" },
  { part: "eyes", label: "Eyes" },
];
const POSES: { pose: Pose; label: string }[] = [
  { pose: "stand", label: "idle" },
  { pose: "wave", label: "waiting for you" },
  { pose: "sleep", label: "asleep" },
];

export default function AgentLookPage({ agentId }: { agentId: string }) {
  const me = useMe();
  const editable = canWrite(me.data ?? null);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agents = useMemo(() => status.data?.agents ?? [], [status.data]);
  const agent = agents.find((entry) => entry.id === agentId);
  const [picked, setPicked] = useState<AgentLook>({});
  useEffect(() => setPicked(agent?.look ?? {}), [agent?.look]);
  /**
   * The look the Office draws, from the looks it computes — every agent's, this one's parts as picked here. Taken
   * apart and put back together, it was not: the parts left to the id were worked out without the picked ones, which
   * can make another agent's twin, and the Office moves a twin's fur or colour on. Nix's fur was ginger here and grey
   * there (0.8.1).
   */
  const drawn = useCallback(
    (own: AgentLook) => looksOf(agents.map((entry) => ({ id: entry.id, ...(entry.id === agentId ? { look: own } : entry.look ? { look: entry.look } : {}) }))).get(agentId),
    [agents, agentId],
  );
  const look: Look | undefined = useMemo(() => drawn(picked), [drawn, picked]);
  // Each part as it is when left to the id, the others as picked: what "From its id" would draw.
  const fromId = useMemo(
    () =>
      Object.fromEntries(
        PARTS.map(({ part }) => {
          const { [part]: _left, ...rest } = picked;
          return [part, drawn(rest)?.[part] ?? ""];
        }),
      ) as Record<keyof Look, string>,
    [drawn, picked],
  );

  const save = useMutation({
    mutationFn: () => lookApi.setAgentLook(agentId, Object.fromEntries(PARTS.map(({ part }) => [part, picked[part] ?? ""]))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  if (status.isPending) return <CardLoading lines={4} />;
  if (!agent || !look) return <ErrorNote error={status.error} />;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[auto_1fr]">
      <Card title="As it will be">
        <div className="flex flex-wrap items-end justify-center gap-4">
          {POSES.map(({ pose, label }) => (
            <figure key={pose} className="flex flex-col items-center gap-1">
              <CatPortrait look={look} pose={pose} scale={pose === "stand" ? 6 : 4} />
              <figcaption className="text-base-content/70 font-mono text-[11px]">{label}</figcaption>
            </figure>
          ))}
        </div>
      </Card>
      <Card title="Look">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-base-content/70 text-sm">How {agent.displayName} is drawn in the Office. A part left to its id keeps the one it has always had.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PARTS.map(({ part, label }) => (
              <Field key={part} label={label}>
                <select
                  className="select select-sm w-full rounded-xl"
                  value={picked[part] ?? ""}
                  disabled={!editable}
                  aria-label={label}
                  onChange={(event) => setPicked((now) => ({ ...now, [part]: event.target.value || undefined }))}
                >
                  <option value="">From its id: {fromId[part]}</option>
                  {(LOOK_PARTS[part].values as readonly string[]).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm active:scale-95" disabled={!editable || save.isPending}>
              Save
            </button>
            {save.isSuccess ? <span className="text-success text-xs">Saved.</span> : null}
          </div>
          <ErrorNote error={save.error} />
        </form>
      </Card>
    </div>
  );
}
