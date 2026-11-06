/**
 * Explore — skills somebody else wrote, from skills.sh, ClawHub, a well-known index, or any GitHub
 * repository.
 *
 * Install here means "fetch it and put it in front of me": the skill becomes a pending draft, already
 * adjusted to Nouride's frontmatter, with where it came from and what was changed beside it. It is
 * read and approved on the Pending tab like a skill an agent drafted — nothing is in any agent's
 * prompt, and no script has run, until then. That is said on the page, because "Install" on a
 * button usually means something more final.
 */

import { ListLoading } from "@/commons/components/ui/Spinner";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FolderGit2, PackageSearch, Search, ShieldAlert } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SkillHubHit, SkillHubInstall } from "@/commons/lib/api.skills";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";

type Source = "" | "skills.sh" | "clawhub" | "well-known";

const SOURCE_LABEL: Record<SkillHubHit["source"], string> = {
  "skills.sh": "skills.sh",
  clawhub: "ClawHub",
  "well-known": "well-known",
  github: "GitHub",
};

export function ExplorePanel({ editable, onReview }: { editable: boolean; onReview: () => void }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("");
  const [ref, setRef] = useState("");
  /** The last install's outcome, keyed by what was installed, so it shows beside that row. */
  const [outcome, setOutcome] = useState<{ ref: string; result: SkillHubInstall } | null>(null);

  const search = useMutation({ mutationFn: (args: { query: string; source: Source }) => api.skillHubSearch(args.query, args.source || undefined) });
  const install = useMutation({
    mutationFn: (target: string) => api.skillHubInstall(target),
    onSuccess: (result, target) => {
      setOutcome({ ref: target, result });
      void queryClient.invalidateQueries({ queryKey: ["skill-drafts"] });
    },
    onError: (error, target) => setOutcome({ ref: target, result: { ok: false, error: error instanceof Error ? error.message : String(error) } }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) search.mutate({ query: query.trim(), source });
  };
  const installRef = (event: FormEvent) => {
    event.preventDefault();
    if (ref.trim()) install.mutate(ref.trim());
  };
  // Before a search, the most used skills — so the tab opens on something to pick from, not an empty box.
  const popular = useQuery({ queryKey: ["skill-hub-popular"], queryFn: api.skillHubPopular, staleTime: 10 * 60_000, retry: false, enabled: !search.data });
  const searched = Boolean(search.data);
  const hits = searched ? (search.data?.hits ?? []) : (popular.data?.hits ?? []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <Card
        title="Install from a repository or URL"
        description="Any GitHub repository or folder that holds skills. Every skill in it waits on the Pending tab."
      >
        <form onSubmit={installRef} className="flex flex-wrap items-center gap-2">
          <label className="input flex min-w-0 flex-1 items-center gap-2 rounded-xl">
            <FolderGit2 size={15} className="opacity-50" />
            <input
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder="anthropics/skills/skills/pdf  ·  https://github.com/owner/repo"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
              aria-label="Repository or URL"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn btn-primary rounded-xl gap-2" disabled={!editable || !ref.trim() || install.isPending}>
            {install.isPending && install.variables === ref.trim() ? <span className="loading loading-spinner loading-xs" /> : <Download size={15} />} Fetch
          </button>
        </form>
        {/* The forms a reference takes, for whoever knows them (0.8.19). */}
        <Details className="mt-2">
          <p>A folder with a SKILL.md. Also takes clawhub:slug, skills.sh:owner/repo/skill and well-known:https://site.</p>
        </Details>
        {outcome && outcome.ref === ref.trim() ? (
          <div className="mt-4">
            <Outcome result={outcome.result} onReview={onReview} />
          </div>
        ) : null}
      </Card>

      <Card
        title="Find a skill"
        description="Search skills.sh, ClawHub and other public lists of skills at once. Installing one puts it on the Pending tab for you to read and approve; nothing runs until you do." // plain-words-ok: skills.sh, a website's own name
        className="flex min-h-[22rem] flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col"
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="input flex min-w-0 flex-1 items-center gap-2 rounded-xl">
              <Search size={15} className="opacity-50" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="pdf, kubernetes, release notes…"
                className="min-w-0 flex-1 bg-transparent outline-none"
                aria-label="Search skill hubs"
              />
            </label>
            <button type="submit" className="btn btn-primary rounded-xl gap-2" disabled={!query.trim() || search.isPending}>
              {search.isPending ? <span className="loading loading-spinner loading-xs" /> : <Search size={15} />} Search
            </button>
          </div>
          <SegmentedTabs
            tabs={[
              { value: "" as Source, label: "All hubs" },
              { value: "skills.sh" as Source, label: "skills.sh" }, // plain-words-ok: a website's own name
              { value: "clawhub" as Source, label: "ClawHub" },
              { value: "well-known" as Source, label: "well-known" },
            ]}
            value={source}
            onChange={(next) => {
              setSource(next);
              if (query.trim()) search.mutate({ query: query.trim(), source: next });
            }}
          />
        </form>

        {/* Bounded: forty hits would push the rest of the page off the screen. The list scrolls inside. */}
        <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          <ErrorNote error={search.error} />
          {search.isPending ? <ListLoading /> : null}
          {!searched ? (
            popular.isPending ? (
              <div className="flex justify-center py-8">
                <span className="loading loading-spinner loading-md text-primary opacity-60" />
              </div>
            ) : popular.data?.error ? (
              <p className="flex items-center gap-2 text-xs text-warning">
                <ShieldAlert size={13} /> {popular.data.plain ?? `ClawHub did not answer: ${popular.data.error}`}
              </p>
            ) : hits.length > 0 ? (
              <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">Most used on ClawHub</p>
            ) : null
          ) : null}
          {(search.data?.errors ?? []).map((failure) => (
            <p key={failure.source} className="flex items-center gap-2 text-xs text-warning">
              <ShieldAlert size={13} /> {failure.source} did not answer: {failure.error}
            </p>
          ))}
          {search.isSuccess && hits.length === 0 ? (
            <EmptyState icon={PackageSearch} title="Nothing found" description="Try other words, or install straight from a GitHub repository above." />
          ) : null}
          {(search.isPending ? [] : hits).map((hit) => (
            <HitRow
              key={hit.ref}
              hit={hit}
              editable={editable}
              installing={install.isPending && install.variables === hit.ref}
              outcome={outcome?.ref === hit.ref ? outcome.result : undefined}
              onInstall={() => install.mutate(hit.ref)}
              onReview={onReview}
            />
          ))}
        </div>
      </Card>

    </div>
  );
}

function HitRow({
  hit,
  editable,
  installing,
  outcome,
  onInstall,
  onReview,
}: {
  hit: SkillHubHit;
  editable: boolean;
  installing: boolean;
  outcome?: SkillHubInstall;
  onInstall: () => void;
  onReview: () => void;
}) {
  return (
    <div className="rounded-2xl border border-base-content/[0.08] bg-base-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-base-content">{hit.name}</span>
            <span className="badge badge-ghost badge-sm rounded-md font-mono">{SOURCE_LABEL[hit.source]}</span>
            {hit.installs !== undefined ? (
              <span className="text-xs text-base-content/65">{hit.installs.toLocaleString("en-US")} installs</span>
            ) : null}
          </div>
          {hit.description ? <p className="line-clamp-2 text-xs leading-relaxed text-base-content/70">{hit.description}</p> : null}
          <p className="truncate font-mono text-[11px] text-base-content/65">{hit.ref}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <a href={hit.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm rounded-xl gap-1.5">
            <ExternalLink size={14} /> View
          </a>
          <button type="button" className="btn btn-primary btn-sm rounded-xl gap-1.5" disabled={!editable || installing} onClick={onInstall}>
            {installing ? <span className="loading loading-spinner loading-xs" /> : <Download size={14} />} Install
          </button>
        </div>
      </div>
      {outcome ? (
        <div className="mt-3">
          <Outcome result={outcome} onReview={onReview} />
        </div>
      ) : null}
    </div>
  );
}

/** What an install did: queued, refused, and why — with the way to the Pending tab. */
function Outcome({ result, onReview }: { result: SkillHubInstall; onReview: () => void }) {
  if (result.error) {
    return <p className="rounded-xl border border-error/20 bg-error/5 p-3 text-xs text-error">{result.error}</p>;
  }
  const queued = result.drafts ?? [];
  return (
    <div className="space-y-2 rounded-xl border border-base-content/[0.08] bg-base-200/40 p-3 text-xs">
      {queued.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-success">
            {queued.length === 1 ? `“${queued[0]!.name}” is` : `${queued.length} skills are`} waiting for your approval.
          </span>
          <button type="button" className="btn btn-success btn-xs rounded-lg" onClick={onReview}>
            Review in Pending
          </button>
        </div>
      ) : null}
      {queued.flatMap((draft) => draft.warnings.map((warning) => (
        <p key={`${draft.id}-${warning}`} className="flex items-center gap-1.5 text-warning">
          <ShieldAlert size={13} /> {draft.name}: {warning}
        </p>
      )))}
      {(result.refused ?? []).map((refused) => (
        <p key={refused.name} className="text-base-content/70">
          <span className="font-medium">{refused.name}</span> not queued: {refused.reason}
        </p>
      ))}
      {(result.notes ?? []).map((note) => (
        <p key={note} className="text-base-content/65">{note}</p>
      ))}
    </div>
  );
}
