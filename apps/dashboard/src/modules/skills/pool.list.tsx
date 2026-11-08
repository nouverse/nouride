/**
 * The pool: one row per skill, one switch per agent, and the `SKILL.md` read in place.
 *
 * Lifted out of `workshop.page.tsx` when the page grew tabs. The page is now a composition root —
 * header, dials, tabs — and this is one of the three things it can show. Splitting on that seam
 * rather than on line count is what keeps "where do I change a row" answerable.
 *
 * A row expands rather than navigating away: reading the file is how you decide whether an agent
 * should carry it, so the decision and the evidence belong on one screen.
 */

import { Spinner } from "@/commons/components/ui/Spinner";
import { AgentName, useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronRight, CircleCheck, Package, Power, PowerOff, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { CatalogSkill } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { useConfirm } from "@/commons/components/ui/confirm";
import { SkillFiles } from "./pool.files";
import { useSaved } from "@/commons/hooks/use-saved";

export function PoolList({ skills, editable }: { skills: CatalogSkill[]; editable: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
  };

  const toggle = useMutation({
    mutationFn: (input: { skill: string; agent: string; enabled: boolean }) =>
      api.setSkillForAgent(input.skill, input.agent, input.enabled),
    onSuccess: invalidate,
  });

  const remove = useMutation({ mutationFn: (name: string) => api.deleteSkill(name), onSuccess: invalidate });

  const saved = useSaved();
  const global_ = useMutation({
    mutationFn: (input: { name: string; off: boolean }) => api.setSkillOffGlobally(input.name, input.off),
    onSuccess: (answer, input) => {
      saved(answer, `${input.name} ${input.off ? "off for every agent" : "back to each agent's own switch"}`, "From the next message.");
      return invalidate();
    },
  });

  /**
   * Confirmed on the way off, not on the way back on.
   *
   * Switching it off changes what every agent can do; switching it back on hands the decision back
   * to the per-agent switches, which is where it was. Asking twice would teach the operator to click
   * through the dialog, which is how the delete confirmation stops working too.
   */
  const confirmGlobal = async (skill: CatalogSkill) => {
    if (skill.offGlobally) {
      global_.mutate({ name: skill.name, off: false });
      return;
    }
    const carriers = skill.agents.filter((agent) => agent.enabled).length;
    const ok = await ask({
      title: `Switch ${skill.name} off for every agent?`,
      confirmLabel: "Switch off",
      body: (
        <>
          {carriers === 0
            ? "No agent is carrying it right now."
            : `${carriers} agent${carriers === 1 ? "" : "s"} would stop being offered it from the next message.`}{" "}
          Their own settings are left alone: this sits over the top of them, so switching it back on
          returns the decision to where it was.
          {skill.scope === "builtin" ? " For a built-in this is the only removal there is." : ""}
        </>
      ),
    });
    if (ok) global_.mutate({ name: skill.name, off: true });
  };

  /**
   * Named in the question, and the consequence spelled out.
   *
   * "Are you sure?" is not a question anybody can answer. What matters is that the file goes, that
   * it goes for *every* agent at once, and that nothing here brings it back — the pool is one
   * directory and this is the only copy unless somebody committed it.
   */
  const confirmDelete = async (skill: CatalogSkill) => {
    const carriers = skill.agents.filter((agent) => agent.enabled).length;
    const ok = await ask({
      title: `Delete ${skill.name}?`,
      confirmLabel: "Delete",
      body: (
        <>
          <p>
            The whole skill goes, with every file that came with it, and all agents reload.
          </p>
          <p className="mt-2">
            {carriers > 0
              ? `${carriers} of ${skill.agents.length} agents are carrying it right now and will stop.`
              : "No agent is carrying it right now."}{" "}
            Nothing here undoes this.
          </p>
          {/* The directory, not `SKILL.md`: that path read as "only this file goes", which it never did. */}
          <p className="mt-2 font-mono text-xs break-all text-base-content/65">{skill.path.replace(/\/SKILL\.md$/, "/")}</p>
        </>
      ),
    });
    if (ok) remove.mutate(skill.name);
  };

  return (
    <>
      <ErrorNote error={toggle.error ?? remove.error} />
      <ul className="divide-base-content/10 divide-y">
        {skills.map((skill) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            expanded={open === skill.name}
            onExpand={() => setOpen(open === skill.name ? null : skill.name)}
            editable={editable}
            busy={toggle.isPending || remove.isPending}
            switching={toggle.isPending && toggle.variables?.skill === skill.name ? toggle.variables.agent : undefined}
            onToggle={(agent, enabled) => toggle.mutate({ skill: skill.name, agent, enabled })}
            onDelete={() => void confirmDelete(skill)}
            onToggleGlobal={() => void confirmGlobal(skill)}
          />
        ))}
      </ul>
      {dialog}
      {!editable ? (
        <p className="pt-3 text-xs text-base-content/65">Read only: you need the operator role to switch skills.</p>
      ) : null}
    </>
  );
}

function SkillRow({
  skill,
  expanded,
  onExpand,
  editable,
  busy,
  onToggle,
  onDelete,
  onToggleGlobal,
  switching,
}: {
  /** The agent whose switch for this skill is being saved, which spins. */
  switching?: string;
  skill: CatalogSkill;
  expanded: boolean;
  onExpand: () => void;
  editable: boolean;
  busy: boolean;
  onToggle: (agent: string, enabled: boolean) => void;
  onDelete: () => void;
  onToggleGlobal: () => void;
}) {
  const on = skill.agents.filter((agent) => agent.enabled);
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst(skill.agents, (agent) => agent.id);
  const Icon = skill.scope === "builtin" ? Package : BookOpen;

  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onExpand}
          className="btn btn-ghost btn-xs mt-0.5 shrink-0 px-1"
          aria-label={expanded ? `Collapse ${skill.name}` : `Read ${skill.name}`}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <Icon size={16} className="mt-1 shrink-0 opacity-50" />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            {skill.scope === "builtin" ? (
              <span className="badge badge-ghost badge-sm shrink-0 font-mono" title="Ships with Nouride.">
                Built in
              </span>
            ) : null}
            {skill.missing.length > 0 ? (
              <span className="badge badge-warning badge-sm shrink-0 gap-1 font-mono">
                <TriangleAlert size={11} /> needs {skill.missing.join(", ")}
              </span>
            ) : skill.requires.length > 0 ? (
              <span className="badge badge-ghost badge-sm shrink-0 gap-1 font-mono">
                <CircleCheck size={11} /> {skill.requires.join(", ")}
              </span>
            ) : null}
            {/*
              A second axis, and it says who rather than whether: host software is missing for the
              whole box, a tool is missing for one agent. The names go here; the per-agent gap is on
              the agent's own chip below, where the decision about that agent is made.
            */}
            {skill.needsTools.length > 0 ? (
              <span className="badge badge-ghost badge-sm shrink-0 gap-1 font-mono" title="Nouride tools this skill calls">
                <Wrench size={11} /> {skill.needsTools.join(", ")}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-base-content/65">{skill.description || "No description."}</p>

          {/*
            Toggles, one per agent, on the row itself. A matrix column per agent looked tidier and
            broke at four agents on a phone — and this is a page an operator opens from a phone.
          */}
          <div className="mt-2 flex flex-wrap gap-2">
            {agents.map((agent) =>
              // A coding CLI's agent that is never given a tool this needs (0.8.13): not a warning to act on — no pack
              // edit changes it, and its CLI is not given the skill — so a quiet mark, not a switch.
              agent.notForCli && agent.notForCli.length > 0 ? (
                <span
                  key={agent.id}
                  className="badge badge-sm badge-ghost gap-1 font-mono text-base-content/65"
                  title={`${agent.displayName} answers through a coding CLI, which is never given ${agent.notForCli.join(", ")}: this skill is not given to it.`}
                >
                  – <AgentName id={agent.id} orchestrator={orchestrator} size={10} />
                </span>
              ) : (
                <button
                  key={agent.id}
                  type="button"
                  disabled={!editable || busy}
                  onClick={() => onToggle(agent.id, !agent.enabled)}
                  className={`badge badge-sm cursor-pointer gap-1 ${
                    agent.enabled
                      ? agent.missingTools.length > 0
                        ? "badge-warning"
                        : "badge-primary"
                      : "badge-ghost text-base-content/65"
                  }`}
                  title={
                    agent.missingTools.length > 0 && agent.enabled
                      ? `${agent.displayName} has this skill but not ${agent.missingTools.join(", ")}, so it will fail partway through. Add the tool to its pack, or switch the skill off here.`
                      : agent.enabled
                        ? `On for ${agent.displayName}${agent.decided ? " (chosen)" : " (default)"}. Click to switch off`
                        : `Off for ${agent.displayName}. Click to switch on`
                  }
                >
                  {switching === agent.id ? <Spinner className="size-2.5" /> : agent.enabled ? (agent.missingTools.length > 0 ? "!" : "✓") : "✕"} <AgentName id={agent.id} orchestrator={orchestrator} size={10} />
                </button>
              ),
            )}
            {skill.agents.length === 0 ? (
              <span className="text-xs text-base-content/65">No agents are loaded.</span>
            ) : null}
          </div>
        </div>

        <div className="mt-1 hidden shrink-0 text-right text-xs text-base-content/65 sm:block">
          <div>
            {on.length}/{skill.agents.length} on
          </div>
          <div>{skill.lastUsedAt ? `read ${new Date(skill.lastUsedAt).toISOString().slice(0, 10)}` : "no read on record"}</div>
        </div>

        {/*
          Off for every agent at once: the other axis from the per-agent chips above.

          A built-in has no other removal: it ships inside the executable, so deleting it is refused
          and would be undone by the next upgrade anyway. Switching it off one agent at a time is the
          same intent expressed six times, and it does not hold — the next agent created would carry
          the skill again with nothing to say why.

          Shown for pool skills too. The mechanism does not care, and "off everywhere but not
          deleted" is a real state: kept for reference, or paused while it is rewritten.
        */}
        <button
          type="button"
          className={`btn btn-xs mt-0.5 shrink-0 ${skill.offGlobally ? "btn-warning" : "btn-ghost"}`}
          disabled={!editable || busy}
          onClick={onToggleGlobal}
          aria-label={`${skill.offGlobally ? "Switch on" : "Switch off"} ${skill.name} for every agent`}
          title={
            skill.offGlobally
              ? "Off for every agent. Click to hand it back to the per-agent switches."
              : "Switch off for every agent, whatever their own settings say"
          }
        >
          {skill.offGlobally ? <PowerOff size={13} /> : <Power size={13} />}
        </button>

        {/*
          Absent for a built-in rather than present and disabled. A greyed-out button invites a
          click and then explains itself; there is no version of this page where deleting one is
          possible, so the honest control is no control. The badge beside the name already says why.
        */}
        {skill.scope === "builtin" ? null : (
          <button
            type="button"
            className="btn btn-ghost btn-xs text-error mt-0.5 shrink-0"
            disabled={!editable || busy}
            onClick={onDelete}
            aria-label={`Delete ${skill.name}`}
            title="Delete this skill for every agent"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {expanded ? (
        <>
          <SkillSource name={skill.name} editable={editable && skill.scope !== "builtin"} />
          <SkillFiles name={skill.name} editable={editable && skill.scope !== "builtin"} />
        </>
      ) : null}
    </li>
  );
}

/**
 * The `SKILL.md` itself, fetched only when a row is opened.
 *
 * Not preloaded with the catalogue: a body is a few KB and a pool of thirty would make the page's
 * first render carry everything nobody asked to read.
 */
function SkillSource({ name, editable }: { name: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const source = useQuery({
    queryKey: ["skill-source", name],
    queryFn: () => api.skillSource(name),
    retry: false,
  });
  /**
   * `null` until somebody types, then the local copy.
   *
   * Dropped on save so the box shows what the daemon actually wrote — it rewrites the frontmatter,
   * stamping `updated:` and forcing `name:` back to the directory, so what comes back is not byte
   * for byte what was sent and the editor should not pretend otherwise.
   */
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: string) => api.saveSkillSource(name, next),
    onSuccess: async () => {
      setText(null);
      await queryClient.invalidateQueries({ queryKey: ["skill-source", name] });
      // The catalogue too: `description` is in this file, and it is what the list renders.
      await queryClient.invalidateQueries({ queryKey: ["skill-catalog"] });
    },
  });

  if (source.isPending) {
    return (
      <div className="mt-3 ml-10 flex items-center gap-2 text-xs text-base-content/65">
        <span className="loading loading-spinner loading-xs" /> Reading the skill…
      </div>
    );
  }
  if (source.error) return <div className="mt-3 ml-10"><ErrorNote error={source.error} /></div>;

  const saved = source.data?.source ?? "";
  const value = text ?? saved;

  return (
    <div className="mt-3 ml-10 space-y-2">
      <Details>
        <p className="font-mono break-all">{source.data?.path}</p>
      </Details>
      <ErrorNote error={save.error} />
      {editable ? (
        <>
          <textarea
            className="textarea bg-base-200/60 h-96 w-full font-mono text-xs leading-relaxed"
            value={value}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            aria-label={`${name}: the skill's text`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              disabled={text === null || save.isPending || !value.trim()}
              onClick={() => save.mutate(value)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={text === null || save.isPending}
              onClick={() => setText(null)}
            >
              Revert
            </button>
            <span className="text-xs text-base-content/65">
              {text === null
                ? "Every agent picks it up on its next message, no restart."
                : "Unsaved. `description:` is what a task is matched against, so keep it."}
            </span>
          </div>
        </>
      ) : (
        /*
          Read-only for a built-in, and shown rather than hidden. The file is worth reading — it is
          often the best example of how a skill is written — and the daemon refuses to write it
          anyway: it ships inside the executable, so an edit here would look permanent and be undone
          by the next upgrade. Switching it off per agent is the operation that exists.
        */
        <>
          {/* Wide content scrolls inside its own box; the page body must never scroll sideways. */}
          <pre className="bg-base-200/60 max-h-96 overflow-auto rounded-xl p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {saved}
          </pre>
          <p className="text-xs text-base-content/65">
            Built-in skills ship with Nouride and cannot be edited. Switch it off for the agents
            that should not carry it, or copy it into the pool under another name.
          </p>
        </>
      )}
    </div>
  );
}
