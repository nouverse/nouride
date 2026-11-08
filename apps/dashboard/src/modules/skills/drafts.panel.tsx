/**
 * Draft rows — skills the agents have proposed, waiting on a person.
 *
 * Three things a row has to make possible, in this order:
 *
 *   read it     — the whole `SKILL.md` body, editable in place, because the pass gets `requires:`
 *                 wrong in a predictable way and fixing one word should not mean rejecting the draft
 *   trace it    — the scrubbed transcript of the turn it came from. Approving a procedure you cannot
 *                 trace back is approving a model's word for it
 *   decide it   — keep (with whatever was edited) or discard, and discarding deletes
 *
 * The lists are exported without a card around them: the page decides where they sit, because they
 * appear in two places — pinned above the pool on **All**, and alone on **Pending**. Nothing here
 * expires, and the page says so where the list is shown.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, FileCode, Lightbulb, Pencil, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SkillDraft } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { DiffCounts, DiffView } from "@/commons/components/ui/DiffView";
import { diffCounts, diffLines } from "@/commons/lib/diff";

/** What the trigger badge says. The kind is a slug; this is the sentence it stands for. */
const TRIGGER_LABEL: Record<SkillDraft["triggerKind"], string> = {
  error_recovery: "failed, then worked",
  user_request: "you asked for it",
  sustained_effort: "a long piece of work",
  in_use: "found while using it",
  first_integration: "something new worked",
  external_install: "installed from a hub",
  curation: "weekly review",
};

export function DraftList({ drafts, editable }: { drafts: SkillDraft[]; editable: boolean }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <ul className="divide-base-content/10 divide-y">
      {drafts.map((draft) => (
        <DraftRow
          key={draft.id}
          draft={draft}
          editable={editable}
          expanded={open === draft.id}
          onExpand={() => setOpen(open === draft.id ? null : draft.id)}
        />
      ))}
    </ul>
  );
}

/**
 * What was decided recently, as one strip.
 *
 * Beside the queue rather than on a page of its own: a decision made two minutes ago is the context
 * for the drafts still waiting, and it is how you notice you already discarded this idea once.
 */
export function DecidedStrip({ drafts }: { drafts: SkillDraft[] }) {
  if (drafts.length === 0) return null;

  return (
    <div className="border-base-content/10 mt-4 border-t pt-3">
      <p className="mb-2 text-xs text-base-content/65">Recently decided</p>
      <ul className="space-y-1">
        {drafts.map((draft) => (
          <li key={draft.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`badge badge-sm ${draft.status === "approved" ? "badge-success" : "badge-ghost"}`}>
              {draft.status === "approved" ? "kept" : "discarded"}
            </span>
            <span className="font-medium">{draft.name}</span>
            <span className="text-base-content/65">by {draft.decidedBy ?? "someone"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DraftRow({
  draft,
  editable,
  expanded,
  onExpand,
}: {
  draft: SkillDraft;
  editable: boolean;
  expanded: boolean;
  onExpand: () => void;
}) {
  const queryClient = useQueryClient();

  /**
   * The edited copy lives here, not in the query cache.
   *
   * Keyed by the row and thrown away when it collapses, which is the honest behaviour: an edit that
   * was never approved was never saved, and a draft that quietly kept a half-typed procedure across
   * a page reload would be worse than losing it.
   */
  const [edits, setEdits] = useState<{ description: string; requires: string; body: string } | null>(null);
  const working = edits ?? { description: draft.description, requires: draft.requires, body: draft.body };
  const changed = edits !== null;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-drafts"] });
    await queryClient.invalidateQueries({ queryKey: ["skill-catalog"] });
  };

  const approve = useMutation({
    mutationFn: () => api.approveSkillDraft(draft.id, changed ? working : undefined),
    onSuccess: refresh,
  });
  const deny = useMutation({ mutationFn: () => api.denySkillDraft(draft.id), onSuccess: refresh });

  const busy = approve.isPending || deny.isPending;

  return (
    <li className="py-3">
      {/* Its words hold 16rem before Keep and delete share their line: on a phone they go under, at the right. Beside
          them, the description was a column a third of the screen wide (0.8.12, the live box's Skills page). */}
      <div className="flex flex-wrap items-start gap-3">
        <button
          type="button"
          onClick={onExpand}
          className="btn btn-ghost btn-xs mt-0.5 shrink-0 px-1"
          aria-label={expanded ? `Collapse ${draft.name}` : `Review ${draft.name}`}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <Lightbulb size={16} className="text-warning mt-1 shrink-0 opacity-70" />

        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{draft.name}</span>
            {/*
              An improvement and a new skill are different decisions and must not look alike: one
              rewrites something six agents already rely on, the other adds a line to their prompts.
            */}
            {/*
              What approving does, said on the row: a weekly review's archive moves the skill out of the pool and writes
              nothing, a merge rewrites one and archives the others.
            */}
            {draft.retire?.includes(draft.name) ? (
              <span className="badge badge-warning badge-sm shrink-0 font-mono">archives</span>
            ) : draft.target ? (
              <span className="badge badge-info badge-sm shrink-0 gap-1 font-mono">
                <Pencil size={10} /> {draft.retire?.length ? `merges ${draft.retire.join(", ")} into` : "improves"}
              </span>
            ) : (
              <span className="badge badge-success badge-sm shrink-0 font-mono">new</span>
            )}
            <span className="badge badge-ghost badge-sm shrink-0 font-mono">{TRIGGER_LABEL[draft.triggerKind]}</span>
            {draft.requires ? (
              <span className="badge badge-ghost badge-sm shrink-0 font-mono">needs {draft.requires}</span>
            ) : null}
            {draft.files.length > 0 ? (
              <span className="badge badge-ghost badge-sm shrink-0 gap-1 font-mono">
                <FileCode size={10} /> {draft.files.length} file{draft.files.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-base-content/65">{draft.description}</p>
          {/*
            The reason is what somebody reads before deciding, so it cannot be the faintest thing on
            the row. It was `text-base-content/65`, which in the dark theme sat below the description above it
            — the wrong way round for the one sentence that argues for the change.
          */}
          <p className="mt-0.5 text-xs text-base-content/65">
            {draft.agentId} · {draft.triggerReason} · {new Date(draft.createdAt).toLocaleString()}
          </p>
          {/*
            What this draft absorbed before the reason above it.

            A second improvement to the same skill is built on the first draft rather than on the
            file — four competing rewrites of one skill would otherwise keep the last and drop the
            rest on approval. The cost is that the reason above describes only the pass that wrote
            it, so without this the operator approves several changes having read one sentence.
            Warning-coloured because it enlarges the decision rather than describing it.
          */}
          {draft.carries?.length > 0 ? (
            <p className="text-warning/80 mt-1 text-xs">
              Also carries {draft.carries.length} earlier lesson
              {draft.carries.length === 1 ? "" : "s"}:{" "}
              <span className="opacity-70">{draft.carries.join(" · ")}</span>
            </p>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 gap-1">
          <button
            type="button"
            className="btn btn-primary btn-xs gap-1"
            disabled={!editable || busy}
            onClick={() => approve.mutate()}
            title="Write it into the pool. Every agent has it from the next message."
          >
            <Check size={12} /> {changed ? "Save & keep" : draft.target ? "Apply" : "Keep"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs gap-1"
            disabled={!editable || busy}
            onClick={() => deny.mutate()}
            title="Delete the draft and its transcript."
            aria-label={`Delete the draft ${draft.name}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <ErrorNote error={approve.error ?? deny.error} />

      {expanded ? (
        <DraftDetail
          draft={draft}
          editable={editable}
          working={working}
          onChange={(next) => setEdits({ ...working, ...next })}
        />
      ) : null}
    </li>
  );
}

/**
 * The body, editable, and the transcript it came from.
 *
 * The transcript is fetched only when the row opens — it is the largest thing on the page and the
 * list has no use for it.
 */
function DraftDetail({
  draft,
  editable,
  working,
  onChange,
}: {
  draft: SkillDraft;
  editable: boolean;
  working: { description: string; requires: string; body: string };
  onChange: (next: Partial<{ description: string; requires: string; body: string }>) => void;
}) {
  const full = useQuery({
    queryKey: ["skill-draft", draft.id],
    queryFn: () => api.skillDraft(draft.id),
    retry: false,
  });

  return (
    <div className="mt-3 ml-10 space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-base-content/65">
          When it applies
          <input
            className="input input-sm mt-1 w-full rounded-xl"
            value={working.description}
            disabled={!editable}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </label>
        <label className="text-xs text-base-content/65">
          Programs it needs on this server
          <input
            className="input input-sm mt-1 w-full rounded-xl"
            value={working.requires}
            disabled={!editable}
            placeholder="none"
            onChange={(event) => onChange({ requires: event.target.value })}
            title="A local PATH lookup. A procedure that runs commands over ssh needs `ssh` here, not the remote's tooling."
          />
        </label>
      </div>

      <textarea
        className="textarea textarea-sm h-64 w-full rounded-xl font-mono text-xs leading-relaxed"
        value={working.body}
        disabled={!editable}
        onChange={(event) => onChange({ body: event.target.value })}
        aria-label={`${draft.name} instructions`}
      />

      {draft.target ? <SkillDiff name={draft.target} proposed={working.body} /> : null}

      {draft.files.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-base-content/65">
            Comes with the skill. Each is read only when the skill's text points at it, which keeps a
            thorough skill cheap.
          </p>
          {draft.files.map((file) => (
            <details key={file.path} className="collapse-arrow bg-base-200/40 collapse rounded-xl">
              <summary className="collapse-title font-mono text-xs opacity-80">{file.path}</summary>
              <div className="collapse-content">
                <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">{file.content}</pre>
              </div>
            </details>
          ))}
        </div>
      ) : null}

      <details className="collapse-arrow bg-base-200/40 collapse rounded-xl">
        <summary className="collapse-title text-xs opacity-70">
          {draft.triggerKind === "external_install" ? "Where this came from, and what was adjusted" : "The turn this came from"}{" "}
          {full.data?.model ? `· written by ${full.data.model}` : null}
        </summary>
        <div className="collapse-content">
          {full.isPending ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <pre className="max-h-80 overflow-auto text-xs leading-relaxed whitespace-pre-wrap">
              {full.data?.transcript ?? "No transcript was kept for this draft."}
            </pre>
          )}
          <p className="mt-2 text-xs text-base-content/65">
            Anything that looked like a credential was masked before this was stored or sent anywhere.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * What actually changes, against the skill on disk.
 *
 * The reason this is not just two `<pre>` blocks: an improvement is usually one added pitfall in a
 * sixty-line file, and asking somebody to spot it by eye is asking them to click Apply without
 * reading. A line diff makes the decision the size of the change.
 *
 * The diff and its drawing are every diff's (`commons/lib/diff.ts`, `DiffView`, 0.8.8): a longest-common-subsequence
 * over lines, wrapped, the unchanged runs folded.
 */
function SkillDiff({ name, proposed }: { name: string; proposed: string }) {
  const source = useQuery({
    queryKey: ["skill-source", name],
    queryFn: () => api.skillSource(name),
    retry: false,
  });

  if (source.isPending) {
    return (
      <div className="flex items-center gap-2 text-xs text-base-content/65">
        <span className="loading loading-spinner loading-xs" /> Reading the current version…
      </div>
    );
  }
  if (source.error) return <ErrorNote error={source.error} />;

  // The body only: the frontmatter is regenerated on write, so diffing it would show churn the
  // reviewer has no decision to make about.
  const current = stripFrontmatter(source.data?.source ?? "");
  const rows = diffLines(current.split("\n"), proposed.split("\n"));
  const { added, removed } = diffCounts(rows);

  return (
    <details className="collapse-arrow bg-base-200/40 collapse rounded-xl" open>
      <summary className="collapse-title text-xs opacity-70">
        Changes to <code>{name}</code>: <DiffCounts added={added} removed={removed} />
        {added + removed === 0 ? " (nothing)" : null}
      </summary>
      <div className="collapse-content min-w-0">
        <DiffView rows={rows} />
      </div>
    </details>
  );
}

function stripFrontmatter(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source);
  return (match ? source.slice(match[0].length) : source).trim();
}
