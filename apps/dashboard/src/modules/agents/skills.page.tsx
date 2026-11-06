/**
 * What this agent knows how to do, and which of it is switched on.
 *
 * Every skill in the pool is listed, on or off, because the page *is* a set of switches and a switch
 * you cannot see is one you cannot flip. Skills are shared by default now: the pool lives in
 * `agents/skills/`, every agent starts with all of it, and this page writes one file —
 * `agents/<id>/skills.toml`.
 *
 * A project skill is listed and not switchable. It comes from a repository the operator pointed at,
 * so it is switched off by removing the root from `[workspace] skill_roots` — a different act with
 * different consequences, and one control that quietly did both would be a trap.
 *
 * The list filters and scrolls inside its card, as the workshop's does (`ScrollCard`): with forty skills the
 * page was one long scroll, and finding one meant reading every row.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FolderGit2, Package, TriangleAlert } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { api, type AgentSkill } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useSaved } from "@/commons/hooks/use-saved";
import { ExternalNote } from "./components/ExternalNote";

const SCOPE: Record<AgentSkill["scope"], { label: string; icon: typeof BookOpen; hint: string }> = {
  shared: {
    label: "Shared",
    icon: BookOpen,
    hint: "Every agent draws from the same pool.",
  },
  builtin: {
    label: "Built in",
    icon: Package,
    hint: "Ships with Nouride and updates when you upgrade.",
  },
  project: {
    label: "Project",
    icon: FolderGit2,
    hint: "From a folder named in the server's settings.",
  },
};

/** What the filter reads on a row: its name, what it is for, where it comes from, and what it still needs. */
export function agentSkillText(skill: AgentSkill): string[] {
  return [skill.name, skill.description, SCOPE[skill.scope].label, ...skill.missing];
}

export default function AgentSkillsPage({ agentId }: { agentId: string }) {
  const me = useMe();
  const [query, setQuery] = useState("");
  const skills = useQuery({
    queryKey: ["agent-skills", agentId],
    queryFn: () => api.agentSkills(agentId),
    retry: false,
  });
  const queryClient = useQueryClient();

  const saved = useSaved();
  const save = useMutation({
    mutationFn: (changes: Record<string, boolean>) => api.saveAgentSkills(agentId, changes),
    onSuccess: async (answer, changes) => {
      saved(answer, `Skills for ${agentId}: ${Object.entries(changes).map(([skill, on]) => `${skill} ${on ? "on" : "off"}`).join(", ")}`);
      await queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] });
      await queryClient.invalidateQueries({ queryKey: ["skill-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const list = skills.data?.skills ?? [];
  const visible = useTextFilter(list, query, agentSkillText);

  if (skills.isPending) {
    return (
      <div className="flex justify-center py-20">
        <span className="loading loading-spinner loading-lg text-primary opacity-60" />
      </div>
    );
  }
  const editable = Boolean(skills.data?.editable) && canWrite(me.data ?? null);
  // What reaches the prompt: this agent's switch, and the operator's global one over it.
  const carried = (skill: AgentSkill) => skill.enabled && !skill.offGlobally;
  const off = list.filter((skill) => !carried(skill)).length;

  /**
   * The switch sends the one decision it changes, and the daemon merges it into the agent's file as it is
   * when the save lands. The whole map used to go, on the idea that it kept two tabs from overwriting each
   * other — it did the reverse: each tab's copy of the map undid the other tab's switch.
   */
  function toggle(name: string, on: boolean): void {
    save.mutate({ [name]: on });
  }

  return (
    <div className="space-y-6">
      <ExternalNote
        agentId={agentId}
        says={({ name, cli, skills }) =>
          // A CLI lists its skills as a conversation's session opens, and keeps that list (0.8.1, Claude Code on the box).
          skills
            ? `${cli} gets the skills switched on here. A change reaches a conversation as it starts. In a chat already going, send /new or /reset.`
            : `Nouride's skills do not reach ${cli} yet: it uses its own. What you switch here applies when ${name} goes back to its model.`
        }
      />
      <ScrollCard
        title="Skills"
        description="Instructions the agent reaches for when a task matches. Every skill in the pool is on until you switch it off here; only this agent is affected."
        {...(list.length > 0 ? { search: { value: query, onChange: setQuery, placeholder: "Filter skills" } } : {})}
      >
        <ErrorNote error={skills.error ?? save.error} />

        {list.length === 0 ? (
          <div className="space-y-2 py-4 text-sm text-base-content/65">
            <p>No skills yet. An agent writes one when it works out how to do something, or you can find one on the Skills Workshop's Explore tab.</p>
            <Details>
              <p>
                They live in <code>agents/skills/</code>. An agent writes one with its <code>skill_create</code> tool, or you
                can add a directory with a <code>SKILL.md</code> by hand.
              </p>
            </Details>
          </div>
        ) : list.length > 0 && visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{query}”.</p>
        ) : null}

        <ul className="divide-base-content/10 divide-y">
          {visible.map((skill) => {
            const scope = SCOPE[skill.scope];
            const Icon = scope.icon;
            return (
              <li
                // By name: one per name is what the daemon lists, as the prompt has it — the pool's copy over a built-in.
                key={skill.name}
                className={`flex items-start gap-3 py-3 ${carried(skill) ? "" : "text-base-content/65"}`}
              >
                <Icon size={16} className="mt-0.5 shrink-0 opacity-50" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`truncate text-sm font-medium ${carried(skill) ? "" : "line-through"}`}>
                      {skill.name}
                    </span>
                    <span className="badge badge-ghost badge-sm shrink-0 font-mono" title={scope.hint}>
                      {scope.label}
                    </span>
                    {skill.offGlobally ? (
                      <span
                        className="badge badge-warning badge-outline badge-sm shrink-0 font-mono"
                        title="Turned off for every agent. Turn it back on in the Skills Workshop."
                      >
                        Off for every agent
                      </span>
                    ) : null}
                    {skill.missing.length > 0 ? (
                      <span
                        className="badge badge-warning badge-sm shrink-0 gap-1 font-mono"
                        title={`Not installed on this server: ${skill.missing.join(", ")}`}
                      >
                        <TriangleAlert size={11} />
                        needs {skill.missing.join(", ")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-base-content/65">{skill.description || "No description."}</p>
                </div>
                {skill.toggleable ? (
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-primary mt-0.5 shrink-0"
                    checked={skill.enabled}
                    disabled={!editable || save.isPending}
                    onChange={(event) => toggle(skill.name, event.target.checked)}
                    aria-label={`${skill.enabled ? "Switch off" : "Switch on"} ${skill.name}`}
                  />
                ) : (
                  // Not a disabled switch: a control that cannot move invites clicking to find out
                  // why. The scope badge above already says where this one is changed.
                  <span className="mt-0.5 shrink-0 text-xs text-base-content/65" title={scope.hint}>
                    always on
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </ScrollCard>

      {/* Under the card, not in it: the count and the way out stay in view however far the list is scrolled. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-base-content/65">
        <span>
          {off > 0 ? `${off} of ${list.length} not carried by this agent. ` : null}
          Curate the pool itself in the{" "}
          <Link to="/skills" className="link">
            Skills Workshop
          </Link>
          .
        </span>
        {!editable ? <span>Read only: you need the operator role to change this.</span> : null}
      </div>
    </div>
  );
}
