/**
 * What the agents know about each person — the Memory menu's first tab.
 *
 * Every `[[people]]` entry is here. Someone with a key has a profile the nightly pass keeps; someone
 * without one is only a name, and "Start learning" gives them a key made from it — nobody is asked to
 * type one. Each fact shows who may read it and links to the conversation it came from.
 *
 * What the nightly pass learns is set here too, beside what it learned: once for everyone
 * (`[memory] facts`, off until someone chooses), and per person over that.
 *
 * Who may do what follows the control API: starting to learn about someone, or forgetting them, is an
 * admin's; editing a profile is an operator's, because every edit is one undo away.
 *
 * Their notes open here too — the same text and dialog as on People, an admin's to edit there and here.
 * Notes are what the operator says about someone; the profile below them is what the agents learned.
 *
 * And the documents kept about them (0.8.20): those of every collection whose settings say it is about them.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Brain, ChevronDown, NotebookText, Pencil, UserX } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { FactsMode, PersonSummary } from "@/commons/lib/api.memory";
import { PersonNotes } from "@/commons/components/people/PersonNotes";
import { useToast } from "@/commons/components/ui/toast";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { RecentChanges } from "./changes";
import { DocumentEditor } from "./document-editor";
import { EpisodeView } from "./episode-view";
import { FactList, factsOf } from "./facts";
import { useNames } from "./names";
import { useSaved } from "@/commons/hooks/use-saved";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { DocumentDialog, type OpenDocument } from "./knowledge/document.dialog";
import { DocumentsAbout } from "./knowledge/documents-about";

const FACTS: { value: FactsMode; label: string }[] = [
  { value: "auto", label: "Save and update facts on their own" },
  { value: "ask", label: "Ask me before every change" },
  { value: "off", label: "Don't save facts" },
];
const factsLabel = (mode: FactsMode) => FACTS.find((option) => option.value === mode)?.label ?? mode;

/** A key the engine accepts — lower case, letters, digits, `-` and `_` — that nobody holds yet. */

function ForgetDialog({ person, onClose }: { person: PersonSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const forget = useMutation({
    mutationFn: (mode: "forget" | "anonymize") => api.forgetPerson(person.key, mode),
    onSuccess: async (report, mode) => {
      toast.success(
        mode === "forget" ? `${person.name} forgotten` : `${person.name}'s name hidden`,
        `${report.episodesDeleted} conversation(s) deleted, ${report.factsRemoved} fact(s) removed, ${report.summariesRewritten + report.summariesAnonymized} summary(ies) changed.` +
          (report.flagged.length ? ` ${report.flagged.length} still named them and were anonymized; read them on the Timeline.` : "") +
          (report.unreadable?.length ? ` ${report.unreadable.length} archived transcript(s) could not be read and still name them: ${report.unreadable.join(", ")}.` : ""),
      );
      for (const key of ["memory-people", "memory-episodes", "memory-document", "memory-proposals"]) await queryClient.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (err) => toast.error("Could not forget them", err),
  });
  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={`Forget ${person.name}`}>
      <div className="modal-box max-w-lg space-y-4 rounded-2xl">
        <h3 className="font-semibold">Forget {person.name}?</h3>
        <p className="text-base-content/70 text-sm">
          Either way, their profile and every conversation they took part in are deleted, with the facts those conversations taught, from every profile and every earlier version of one, and from Recent changes. Neither can be undone. The weekly backups of memory made before now keep it until they are replaced.
        </p>
        <p className="text-base-content/70 text-sm">
          Memory is not the conversation itself: a chat still open with them keeps what was said in it until it is started anew (/new) or rolls over, and the record of each answer keeps it for as long as conversations are kept.
        </p>
        <div className="space-y-2">
          <button type="button" className="btn btn-error btn-sm w-full justify-start rounded-xl" disabled={forget.isPending} onClick={() => forget.mutate("forget")}>
            Delete everything known about {person.name}
          </button>
          <p className="text-base-content/65 px-1 text-xs">Other people's conversations that mention them are rewritten without them. Takes a model call for each.</p>
          <button type="button" className="btn btn-outline btn-sm w-full justify-start rounded-xl" disabled={forget.isPending} onClick={() => forget.mutate("anonymize")}>
            Hide {person.name}'s name
          </button>
          <p className="text-base-content/65 px-1 text-xs">Their name becomes [forgotten] where others mention them. What was said stays.{/* plain-words-ok: the word a hidden name becomes, as it reads */}</p>
        </div>
        {forget.isPending ? <p className="text-base-content/65 text-sm">Working…</p> : null}
        <div className="flex justify-end">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={forget.isPending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}

/** What the nightly pass learns about one person: the everyone setting, or their own. Saved at once. */
function PersonFacts({ person, fallback, editable }: { person: PersonSummary; fallback: FactsMode; editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useSaved();
  const save = useMutation({
    mutationFn: (mode: FactsMode | null) => api.setPersonFacts(person.key, mode),
    onSuccess: (answer, mode) => {
      saved(answer, mode === null ? `${person.name} follows the memory setting` : `Facts about ${person.name}: ${mode}`);
      return queryClient.invalidateQueries({ queryKey: ["memory-people"] });
    },
    onError: (err) => toast.error("Could not save", err),
  });
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-base-content/70">From conversations</span>
      <select
        className="select select-xs rounded-lg"
        disabled={!editable || save.isPending}
        value={person.factsMode ?? ""}
        onChange={(event) => save.mutate((event.target.value || null) as FactsMode | null)}
      >
        <option value="">Same as everyone ({factsLabel(fallback).toLowerCase()})</option>
        {FACTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const RECALL: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "Put into prompts" },
  { value: "off", label: "Leave out of prompts" },
];

/** Whether what is remembered about one person goes into prompts: the everyone setting, or their own. Saved at once. */
function PersonRecall({ person, fallback, editable }: { person: PersonSummary; fallback: boolean; editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useSaved();
  const save = useMutation({
    mutationFn: (recall: boolean | null) => api.setPersonRecall(person.key, recall),
    onSuccess: (answer, recall) => {
      saved(answer, recall === null ? `${person.name} follows the memory setting` : `${person.name}: ${recall ? "put into prompts" : "left out of prompts"}`);
      return queryClient.invalidateQueries({ queryKey: ["memory-people"] });
    },
    onError: (err) => toast.error("Could not save", err),
  });
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-base-content/70">In prompts</span>
      <select
        className="select select-xs rounded-lg"
        disabled={!editable || save.isPending}
        value={person.recall === undefined ? "" : person.recall ? "on" : "off"}
        onChange={(event) => save.mutate(event.target.value === "" ? null : event.target.value === "on")}
      >
        <option value="">Same as everyone ({fallback ? "put into prompts" : "left out of prompts"})</option>
        {RECALL.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Profile({ person, mode, nameOf, onOpenEpisode }: { person: PersonSummary; mode: FactsMode; nameOf: (key: string) => string; onOpenEpisode: (id: string) => void }) {
  const doc = useQuery({ queryKey: ["memory-document", person.key], queryFn: () => api.memoryDocument(person.key) });
  if (doc.error) return <ErrorNote error={doc.error} />;
  const facts = factsOf(doc.data?.content ?? "");
  if (facts.length === 0) {
    return (
      <p className="text-base-content/65 text-sm">
        {mode === "off" ? "Nothing saved. Facts from conversations are off for them." : "Nothing saved yet. It shows up here the night after a conversation."}
      </p>
    );
  }
  return <FactList facts={facts} nameOf={nameOf} onOpenEpisode={onOpenEpisode} />;
}

/** `[memory] facts`, for everyone without a setting of their own. Saved at once. */
function EveryoneFacts({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const announce = useSaved();
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const save = useMutation({
    mutationFn: (facts: FactsMode) => api.setMemorySettings({ facts }),
    onSuccess: async (answer, facts) => {
      announce(answer, `Facts from conversations: ${facts}`);
      await queryClient.invalidateQueries({ queryKey: ["memory-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-people"] });
    },
    onError: (err) => toast.error("Could not save", err),
  });
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return null;
  return (
    <div className="border-base-content/[0.08] bg-base-200/40 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-3.5">
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">Save facts from conversations</span>
        <span className="text-base-content/65 block text-xs">For everyone, unless you set someone differently below. What you type into a profile, or ask an agent to remember, is kept either way.</span>
      </span>
      <select className="select select-sm rounded-xl" disabled={!editable || save.isPending} value={settings.data.facts} onChange={(event) => save.mutate(event.target.value as FactsMode)}>
        {FACTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PeopleTab({ editable, admin }: { editable: boolean; admin: boolean }) {
  const nameOf = useNames();
  const people = useQuery({ queryKey: ["memory-people"], queryFn: api.memoryPeople });
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  const everyone: FactsMode = settings.data?.facts ?? "off";
  const recallEveryone = settings.data?.recall ?? true;
  const [editing, setEditing] = useState<{ subject: string; title: string } | null>(null);
  const [forgetting, setForgetting] = useState<PersonSummary | null>(null);
  const [episode, setEpisode] = useState<string | null>(null);
  const [notesOf, setNotesOf] = useState<PersonSummary | null>(null);
  const [reading, setReading] = useState<OpenDocument | null>(null);

  const list = people.data?.people ?? [];
  return (
    <div className="space-y-4">
      {people.error ? <ErrorNote error={people.error} /> : null}
      <p className="text-base-content/70 text-sm">
        When it's on, your agents save what they learned from the day's conversations every night. You don't need to fill anything in. Open a profile to correct it.
      </p>
      <EveryoneFacts editable={editable} />
      <RecentChanges nameOf={nameOf} onOpenEpisode={setEpisode} />

      {list.length === 0 && !people.isLoading ? (
        <EmptyState icon={Brain} title="Nobody is known yet" description="People show up here after you add them on the People page or approve them in a chat." />
      ) : null}

      {list.length > 0 ? (
        // Its own scroll, one row per person, closed until opened: a household of ten is ten lines.
        <div className="max-h-[70vh] space-y-2 overflow-y-auto">
          {list.map((person) => (
            <details key={person.key} className="group border-base-content/[0.08] bg-base-100/80 rounded-2xl border">
              {/* Sticky, and the body below bounded: an open profile scrolls inside itself, so its header —
                  the name and the buttons that act on it — never scrolls away with the facts. */}
              <summary className="bg-base-100 sticky top-0 z-10 flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-2xl px-5 py-3.5 group-open:rounded-b-none">
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronDown size={14} className="text-base-content/50 shrink-0 transition-transform group-open:rotate-180" />
                  <span className="truncate font-semibold">{person.name}</span>
                  <span className="text-base-content/65 font-mono text-[11px]">{person.key}</span>
                  <span className="text-base-content/65 text-xs">{person.facts} fact(s)</span>
                  {person.factsMode ? <span className="badge badge-sm badge-ghost font-mono">{factsLabel(person.factsMode)}</span> : null}
                  {person.recall === false ? <span className="badge badge-sm badge-ghost font-mono">Left out of prompts</span> : null}
                </span>
                {/* Buttons inside a summary would also open and close it; preventDefault keeps them buttons. */}
                <span className="flex gap-1">
                  <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={(event) => { event.preventDefault(); setNotesOf(person); }}>
                    <NotebookText size={12} /> Notes
                  </button>
                  {editable ? (
                    <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={(event) => { event.preventDefault(); setEditing({ subject: person.key, title: person.name }); }}>
                      <Pencil size={12} /> Edit profile
                    </button>
                  ) : null}
                  {admin ? (
                    <button type="button" className="btn btn-ghost btn-xs text-error gap-1 rounded-lg" onClick={(event) => { event.preventDefault(); setForgetting(person); }}>
                      <UserX size={12} /> Forget
                    </button>
                  ) : null}
                </span>
              </summary>
              <div className="border-base-content/[0.06] max-h-[55vh] overflow-y-auto overscroll-contain border-t px-5 py-4">
                <div className="space-y-3">
                  <PersonFacts person={person} fallback={everyone} editable={editable} />
                  <PersonRecall person={person} fallback={recallEveryone} editable={editable} />
                  <Profile person={person} mode={person.factsMode ?? everyone} nameOf={nameOf} onOpenEpisode={setEpisode} />
                  <DocumentsAbout person={person.key} onOpen={setReading} />
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : null}

      <Leaving value={editing}>{(document) => <DocumentEditor subject={document.subject} title={document.title} editable={editable} onClose={() => setEditing(null)} />}</Leaving>
      <Leaving value={notesOf}>{(person) => <PersonNotes person={person} editable={admin} onClose={() => setNotesOf(null)} />}</Leaving>
      <Leaving value={forgetting}>{(person) => <ForgetDialog person={person} onClose={() => setForgetting(null)} />}</Leaving>
      <Leaving value={episode}>{(id) => <EpisodeView id={id} editable={editable} nameOf={nameOf} onOpen={setEpisode} onClose={() => setEpisode(null)} />}</Leaving>
      <Leaving value={reading}>{(at) => <DocumentDialog at={at} onOpen={setReading} onClose={() => setReading(null)} />}</Leaving>
    </div>
  );
}
