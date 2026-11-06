/**
 * How much this agent asks before it runs a gated tool.
 *
 * The dashboard is the **only** place `trusted` can be set, and that is the design rather than an
 * omission. A chat command cannot set it: knowing the bot's username is not proof of who you are,
 * which is the entire reason pairing exists, so `/approvals trusted` in a Discord server would hand every
 * member one command to disarm the daemon. No CLI verb writes it either — the agent holds the
 * `nouride` tool, and this repo's notes record that the hardline classifier says nothing about
 * `nouride config set security.exec.ask off` (exit 2 now, a verb gone), so a CLI verb would be a way for an agent to be talked
 * into loosening its own gate.
 *
 * What is left is a page behind a login. Hence this component.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { api, type AgentSummary } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

type Level = AgentSummary["approvals"];

const OPTIONS: {
  value: Level;
  label: string;
  detail: string;
  icon: typeof ShieldCheck;
  danger?: boolean;
}[] = [
  {
    value: "per-person",
    label: "Follow each person",
    detail:
      "This agent does not decide. Whatever each person set for themselves applies, and the default covers anyone who has not.",
    icon: Users,
  },
  {
    value: "careful",
    label: "Careful: ask before anything new",
    detail:
      "A new command or change asks once, and “always” remembers it. Deleting outside the workspace, tearing infrastructure down, force-pushing, stopping or replacing Nouride and the rest of the fixed list ask every time.",
    icon: ShieldCheck,
  },
  {
    value: "balanced",
    label: "Balanced: only ask about the few that matter",
    detail:
      "Everything else runs unprompted. Changing Nouride's settings, giving someone access, stopping Nouride, replacing or deleting a stored secret, a credential leaving this machine, and changing its system packages still ask, as does everything Trusted still asks.",
    icon: ShieldAlert,
  },
  {
    value: "trusted",
    label: "Trusted: never ask",
    detail:
      "Nothing asks, including the changes above, except work nobody watches sending somewhere its job did not name, a program installed for every agent, a change to an agent's own persona, and a change to who People says a person is. Anyone who can message this agent can have it run anything else it is able to run.",
    icon: ShieldOff,
    danger: true,
  },
];

export function ApprovalLevel({ agent }: { agent: AgentSummary }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Level | null>(null);

  const saved = useSaved();
  const save = useMutation({
    mutationFn: (level: Level) => api.setAgentApprovals(agent.id, level),
    onSuccess: (answer, level) => {
      saved(answer, `${agent.displayName || agent.id} asks at “${level}”`);
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const current = agent.approvals;

  // `trusted` takes a second step. There is no undo for a command that has already run, and this is the
  // one setting on the page whose blast radius is "anything this agent can do".
  const choose = (level: Level) => {
    if (level === current) return;
    if (level === "trusted") {
      setConfirming(level);
      return;
    }
    save.mutate(level);
  };

  return (
    <Card
      title="Approvals"
      description="How much this agent asks before running a gated tool. Set here, it applies to everyone talking to it."
    >
      <div className="space-y-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={save.isPending}
              onClick={() => choose(option.value)}
              className={[
                "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
                selected
                  ? option.danger
                    ? "border-error/40 bg-error/5"
                    : "border-primary/40 bg-primary/5"
                  : "border-base-content/[0.08] hover:bg-base-content/[0.03]",
              ].join(" ")}
            >
              <Icon
                size={18}
                className={
                  option.danger ? "text-error mt-0.5 shrink-0" : "text-base-content/60 mt-0.5 shrink-0"
                }
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-medium">
                  {option.label}
                  {selected ? <span className="badge badge-sm font-mono">current</span> : null}
                </span>
                <span className="text-base-content/65 mt-0.5 block text-xs">{option.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {confirming === "trusted" ? (
        <div className="border-error/30 bg-error/5 mt-4 rounded-xl border p-3">
          <p className="text-sm font-medium">Turn every gate off for {agent.displayName}?</p>
          <p className="text-base-content/70 mt-1 text-xs">
            Nothing will ask again: not a change to the settings, not giving someone access, not stopping
            Nouride. Anyone who can message this agent inherits that. It stays off until you change
            it here.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn btn-error btn-sm rounded-xl"
              disabled={save.isPending}
              onClick={() => save.mutate("trusted")}
            >
              {save.isPending ? "Saving…" : "Turn off every gate"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-xl"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}
