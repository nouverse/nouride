/**
 * Self-Improving Skill: the settings behind the Pending tab. That is `[skills.learning]`'s name on screen only; the
 * config, the CLI and the docs' setting keep `[skills.learning]`.
 *
 * On this page and not in a settings section elsewhere: whether learning is set right shows in the queue it produced,
 * so it belongs next to the thing you are watching. Collapsed by default — it is the page's setting, not its content.
 *
 * **Everything here is live.** The daemon reads it per turn, so a change applies to the next message, no restart. When
 * the pass looks and how often are its own (`reflection/tuning.ts` on the daemon), not settings: until 0.7.27 there
 * were five dials here, and the right answer for every one of them was to leave it alone.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sliders } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { LearningMode } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/**
 * The three modes, in order of how much runs without a person. A radio group rather than a toggle because the middle
 * one is the default and the interesting one: the question operators differ on is whether what it finds needs a human.
 */
const LEARNING_MODES = ["off", "ask", "auto"] as const;

const MODES: Record<LearningMode, { label: string; chip: string; badge: string; hint: (pending: number) => string }> = {
  off: {
    label: "Off: never propose anything",
    chip: "off",
    badge: "badge-ghost",
    hint: (pending) =>
      pending > 0
        ? `The ${pending} draft${pending === 1 ? "" : "s"} already queued stay exactly where they are, still decidable.`
        : "No turn is examined. Nothing is drafted.",
  },
  ask: {
    label: "Propose, and wait for me",
    chip: "asks",
    badge: "badge-success",
    hint: () => "Drafts a skill and leaves it queued. Nothing reaches the pool until you say yes.",
  },
  auto: {
    label: "Let it keep what it learns",
    chip: "automatic",
    badge: "badge-warning",
    hint: () =>
      "Approves its own drafts as it writes them, and tells you afterwards. A new skill is on only for the agent that learned it; the weekly review's proposals still wait for you.",
  },
};

/** `onShowPending` opens the Pending tab, where drafts are: the page's own way to them, not a command. */
export function LearningSettingsPanel({ canEdit, onShowPending }: { canEdit: boolean; onShowPending: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["learning-settings"], queryFn: api.learningSettings, retry: false });
  const [model, setModel] = useState<string | null>(null);
  const saved = useSaved();

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["learning-settings"] });
    await queryClient.invalidateQueries({ queryKey: ["skill-drafts"] });
  };
  // A switch applies on click; a typed value waits for Save.
  const save = useMutation({
    mutationFn: api.saveLearningSettings,
    onSuccess: async (answer, patch) => {
      saved(
        answer,
        patch.mode ? `Self-Improving Skill: ${MODES[patch.mode].chip}` : patch.notifyChat !== undefined ? (patch.notifyChat ? "New drafts are announced in their conversation" : "New drafts are not announced") : "Self-Improving Skill model",
      );
      setModel(null);
      await refresh();
    },
  });

  const review = useMutation({
    mutationFn: api.reviewSkills,
    onSuccess: async (report) => {
      const proposals = report.tighten.length + report.merge.length + report.archive.length;
      saved({ ok: true }, proposals > 0 ? `${proposals} proposal(s) from the review` : "The library needs nothing this week", proposals > 0 ? "They wait on the Pending tab." : undefined);
      await refresh();
    },
  });

  if (settings.isPending || !settings.data) return null;
  const live = settings.data;
  const last = live.lastReview;
  const summary = last
    ? [
        last.report.tighten.length ? `${last.report.tighten.length} to tighten` : "",
        last.report.merge.length ? `${last.report.merge.length} merge(s)` : "",
        last.report.archive.length ? `${last.report.archive.length} to archive` : "",
      ].filter(Boolean).join(", ") || "nothing to change"
    : "";
  const editable = live.editable && canEdit;
  const typed = model ?? live.model;

  return (
    <details className="collapse-arrow bg-base-100 border-base-content/10 collapse rounded-2xl border">
      {/* Wraps: in one row on a phone the name, its chip and the line beside them were three columns, the name a word a
          line. There the line goes under the name. */}
      <summary className="collapse-title flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <Sliders size={15} className="opacity-60" />
        <span className="whitespace-nowrap">Self-Improving Skill</span>
        <span className={`badge badge-sm ${MODES[live.mode]?.badge ?? "badge-ghost"}`}>{MODES[live.mode]?.chip ?? "asks"}</span>
        <span className="text-xs font-normal text-base-content/65 max-sm:basis-full">
          {live.mode === "off" ? "agents propose nothing" : "a procedure that comes back becomes a skill"}
        </span>
      </summary>

      <div className="collapse-content space-y-4">
        <ErrorNote error={save.error ?? review.error} />

        <p className="text-xs text-base-content/65">
          After a conversation that took real working out, a model reads it back and asks one question: is there a
          procedure here that an agent doing work like this again would follow? Facts about your machines belong in
          memory and a task's progress in its work notes, so neither becomes a skill. A new kind of work is only noted
          the first time, and becomes a skill when it comes back.
        </p>

        <fieldset className="space-y-2">
          <legend className="text-sm">
            What an agent may do with what it learns
            <span className="ml-2 text-xs font-normal text-base-content/65">{save.isPending ? "saving…" : "applies immediately"}</span>
          </legend>
          {LEARNING_MODES.map((mode) => (
            <label
              key={mode}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${
                live.mode === mode ? "border-primary/60 bg-primary/5" : "border-base-content/10 hover:border-base-content/25"
              } ${editable ? "" : "cursor-not-allowed opacity-60"}`}
            >
              <input
                type="radio"
                name="learning-mode"
                className="radio radio-sm radio-primary mt-0.5"
                checked={live.mode === mode}
                disabled={!editable || save.isPending}
                onChange={() => save.mutate({ mode })}
              />
              <span>
                {MODES[mode].label}
                <span className="block text-xs text-base-content/65">{MODES[mode].hint(live.pending)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block text-sm">
          Model for the pass
          <span className="mt-1 flex gap-2">
            <input
              className="input input-sm w-full rounded-xl"
              value={typed}
              placeholder="the agent's own model"
              disabled={!editable}
              onChange={(event) => setModel(event.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm rounded-xl" disabled={!editable || model === null || save.isPending} onClick={() => save.mutate({ model: typed })}>
              Save
            </button>
          </span>
          <span className="mt-1 block text-xs text-base-content/65">Empty uses the agent's own. It has to be one the agent's provider profile can serve.</span>
        </label>

        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={live.notifyChat}
            disabled={!editable || save.isPending}
            onChange={(event) => save.mutate({ notifyChat: event.target.checked })}
          />
          <span>
            Announce a new draft in the chat it came from
            <span className="block text-xs text-base-content/65">
              Off leaves the{" "}
              <button type="button" className="link link-primary" onClick={onShowPending}>
                Pending tab
              </button>{" "}
              as the only place to find one.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            Weekly review
            <span className="block text-xs text-base-content/65">
              {last ? `Last ${new Date(last.ranAt).toLocaleString()}: ${summary}.` : "Not run yet."} Once a week it tightens what grew, merges what overlaps and archives what nobody reads, as proposals that wait for you.
            </span>
          </span>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={!canEdit || review.isPending} onClick={() => review.mutate()}>
            {review.isPending ? "Reviewing…" : "Review now"}
          </button>
        </div>

        <p className="text-xs text-base-content/65">
          {editable ? "Live: applies to the next message, no restart." : live.editable ? "Read only: you need the operator role." : "This cannot be changed from the dashboard on this server."}
        </p>
      </div>
    </details>
  );
}
