/**
 * Deleting an agent, at the foot of its Settings page, for an admin.
 *
 * Everything that makes it run goes and does not come back, so the question is in layers: what goes, counted, with
 * how much its folders hold; the agent's id typed; then ten seconds before the button can be pressed. Its chats and
 * memories are kept, and the question says so in one line, since an agent made later under the same id is joined to
 * them, whatever it is for. The orchestrator is not deleted: another agent is made the orchestrator first.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { AgentDeletion, AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { formatBytes } from "@/commons/lib/format";
import { Card } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";

/** How long the last layer holds the button, once the id is typed. */
const WAIT_SECONDS = 10;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What goes with the agent, a line each, only what there is of it: the question's list. */
function whatGoes(found: AgentDeletion, codingCli: boolean): string[] {
  const size = found.folder.bytes === null ? "" : `, ${formatBytes(found.folder.bytes)}`;
  return [
    `Its own files${codingCli ? ", with its coding CLI's sign-ins" : ""}: ${found.folder.more ? "more than " : ""}${count(found.folder.files, "file")}${size}`,
    ...(found.missions > 0 ? [`${count(found.missions, "mission")} still open, stopped first`] : []),
    ...(found.jobs > 0 ? [`${count(found.jobs, "background job")} running now, ended first`] : []),
    ...(found.automations > 0 ? [`${count(found.automations, "automation")} of its own`] : []),
    ...(found.handed > 0 ? [`${count(found.handed, "automation")} of other agents with a step given to it: turned off, each saying why`] : []),
    ...(found.connections.length > 0 ? [`${count(found.connections.length, "connection")} only it answers. Its key stays in Secrets`] : []),
    ...(found.rooms > 0 ? [`Its seat in ${count(found.rooms, "room")}`] : []),
    ...(found.grants > 0 ? [`${count(found.grants, "standing permission")}`] : []),
    ...(found.signIns > 0 ? [`${count(found.signIns, "sign-in")} to connectors`] : []),
    ...(found.account ? ["Its own user on this machine"] : []),
  ];
}

export function DeleteAgent({ agent, orchestrator }: { agent: AgentSummary; orchestrator: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const name = agent.displayName || agent.id;

  const remove = useMutation({
    mutationFn: async () => {
      // Counted when the question is asked, not when the page was drawn: a mission started since is in it.
      const found = await api.agentDeletion(agent.id);
      const sure = await ask({
        title: `Delete ${name}?`,
        body: (
          <div className="space-y-3">
            <p>This cannot be undone. These go with it:</p>
            <ul className="list-disc space-y-1 pl-5" data-what-goes>
              {whatGoes(found, agent.external !== undefined).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>Its chats and memories are kept.</p>
          </div>
        ),
        typed: agent.id,
        waitSeconds: WAIT_SECONDS,
        confirmLabel: `Delete ${agent.id}`,
        cancelLabel: "Keep it",
      });
      return sure ? await api.deleteAgent(agent.id, agent.id) : null;
    },
    onSuccess: async (done) => {
      if (!done) return;
      // What could not be taken is said, each note whole: an account left on the machine is the person's to know.
      if (done.notes.length > 0) toast.info(`${name} was deleted`, done.notes.join(" "));
      else toast.success(`${name} was deleted`);
      await queryClient.invalidateQueries();
      void navigate({ to: "/agents" });
    },
    onError: (error) => toast.error("Could not delete it", error),
  });

  return (
    <Card title="Delete this agent" description="For good: what makes it run is removed and does not come back. Its chats and memories are kept.">
      {dialog}
      {orchestrator ? (
        <p className="text-sm leading-relaxed text-base-content/75" data-delete-refused>
          You need at least an orchestrator. Make another agent the orchestrator first.
        </p>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-xl text-error hover:bg-error/10" disabled={remove.isPending} onClick={() => remove.mutate()}>
          <Trash2 size={14} aria-hidden="true" /> Delete {name}
        </button>
      )}
    </Card>
  );
}
