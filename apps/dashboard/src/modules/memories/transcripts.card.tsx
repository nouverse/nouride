/** How long the timeline's transcripts stay readable, and what happens to them after (`[memory] transcript_days`, `archive`). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { formatBytes } from "@/commons/lib/format";
import { useSaved } from "@/commons/hooks/use-saved";

/** Days a transcript stays readable when it is not kept forever, and what a switch back to days restores. */
const DEFAULT_DAYS = 180;

/**
 * How long a transcript stays readable, and what happens after. Saved at once: days on blur or Enter.
 * Kept forever is `transcript_days = 0`: nothing is ever compacted, so archiving has nothing to do.
 */
export function TranscriptsCard({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useSaved();
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const status = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus });
  const [days, setDays] = useState("");
  useEffect(() => {
    if (settings.data) setDays(String(settings.data.transcriptDays));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: api.setMemorySettings,
    onSuccess: (answer, patch) => {
      saved(answer, patch.transcriptDays === undefined ? "Transcripts" : patch.transcriptDays === 0 ? "Transcripts are kept forever" : `Transcripts readable for ${patch.transcriptDays} day(s)`);
      return queryClient.invalidateQueries({ queryKey: ["memory-settings"] });
    },
    onError: (err) => {
      toast.error("Could not save", err);
      if (settings.data) setDays(String(settings.data.transcriptDays));
    },
  });
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return null;
  const current = settings.data;
  const forever = current.transcriptDays === 0;
  const commit = () => {
    const next = Number(days);
    if (next !== current.transcriptDays) save.mutate({ transcriptDays: next });
  };
  return (
    <Card title="Transcripts" description="A conversation's full transcript stays readable for a while; its summary is kept forever.">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="space-y-3">
          <ToggleRow
            label="Keep transcripts forever"
            hint="Every transcript stays readable. Nothing is compacted, and ones archived before come back at the next pass."
            disabled={!editable || save.isPending}
            checked={forever}
            onChange={(on) => save.mutate({ transcriptDays: on ? 0 : DEFAULT_DAYS })}
          />
          {forever ? null : (
            <label className="ml-12 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-base-content/70">Keep for</span>
              <input
                type="number"
                min={1}
                max={3650}
                className="input input-sm w-24 rounded-xl"
                disabled={!editable || save.isPending}
                value={days}
                onChange={(event) => setDays(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => event.key === "Enter" && commit()}
              />
              <span className="text-base-content/70">days</span>
            </label>
          )}
        </div>
        <ToggleRow
          label="Archive old transcripts"
          hint={forever ? "Off while transcripts are kept forever: none ever gets old enough." : "Keeps a compressed copy agents can't read, so a conversation can be filed again later."}
          disabled={!editable || save.isPending || forever}
          checked={current.archive && !forever}
          onChange={(archive) => save.mutate({ archive })}
        />
      </div>
      {/* Optional-chained: a daemon older than the dashboard does not send it. */}
      {status.data?.archive?.files ? (
        <p className="text-base-content/65 mt-4 text-sm">
          The archive holds {status.data.archive.files} transcript{status.data.archive.files === 1 ? "" : "s"}, {formatBytes(status.data.archive.bytes)}.
        </p>
      ) : null}
    </Card>
  );
}
