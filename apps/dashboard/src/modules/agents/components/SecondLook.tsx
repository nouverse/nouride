/**
 * The second look for this agent (0.8.0, `[security] model_guard`): before work nobody watches sends something off the
 * machine after reading outside content, a model weighs the action against what the work is for, and may add a
 * question. It never removes one. By the level that work is a mission; an automation a person turned on has their yes,
 * and is looked at only where the look is always on.
 *
 * Three choices a person makes here: follow the daemon's setting, always on (the agent's high tier, even at `trusted`,
 * automations too), or off. A model named by id stays the config file's to say; it shows here as what it is.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Settings2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/**
 * What a setting means, in words — unset is by the approval level the work runs at, and not on an automation: a
 * person turned that on, which is their yes.
 */
function meaning(setting: string): string {
  if (!setting) return "on a mission at Careful and Balanced, off at Trusted, and off on an automation you turned on";
  if (setting === "off") return "off";
  return `on at every level, on ${["small", "default", "high"].includes(setting) ? `the ${setting} tier` : setting}`;
}

export function SecondLook({ agent }: { agent: AgentSummary }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const save = useMutation({
    mutationFn: (value: string | null) => api.setAgentModelGuard(agent.id, value),
    onSuccess: (answer) => {
      saved(answer, `${agent.displayName || agent.id}'s second look saved`);
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  if (!agent.secondLook) return null;
  const { own, install } = agent.secondLook;
  const options: { value: string | null; label: string; detail: string; icon: typeof Eye }[] = [
    { value: null, label: "Follow the default", detail: `As the default for every agent says: ${meaning(install)}.`, icon: Settings2 },
    { value: "high", label: "Always look", detail: "On at every level, Trusted too, on this agent's high tier, and on automations: a send it holds waits for your yes on the automation's page.", icon: Eye },
    { value: "off", label: "Off", detail: "Work nobody watches sends without a second look. The fixed list still asks what it asks.", icon: EyeOff },
  ];
  const custom = own !== null && !options.some((option) => option.value === own);

  return (
    <Card
      title="Second look"
      description="When a mission has read something from outside (a web page, an email, a webhook) and then sends something off this machine, another model first checks that the send fits the work. If it does not, you are asked before it goes. It can only add a question, never skip one. An automation you turned on is not checked, since turning it on is your yes, unless you choose Always look."
    >
      <div className="space-y-2">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = own === option.value;
          return (
            <button
              key={option.label}
              type="button"
              disabled={save.isPending}
              onClick={() => !selected && save.mutate(option.value)}
              className={[
                "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
                selected ? "border-primary/40 bg-primary/5" : "border-base-content/[0.08] hover:bg-base-content/[0.03]",
              ].join(" ")}
            >
              <Icon size={18} className="text-base-content/60 mt-0.5 shrink-0" aria-hidden="true" />
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
        {custom && <p className="text-base-content/65 text-xs">Its pack names {own}: {meaning(own)}. Choosing above replaces it.</p>}
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}
