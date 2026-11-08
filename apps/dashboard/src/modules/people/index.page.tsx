/**
 * People management — identity mapping for known senders across chat platforms.
 * Remade with Apple HIG: clean table, platform badges, inline editing,
 * and tactile action buttons.
 *
 * Notes are a page of markdown each (what USER.md was), so a row has a button that opens them in the
 * notes dialog — the one Memory uses for them too.
 *
 * A person is their Person Key, set once: the name of their memory file, and how Access's "Approve as"
 * finds them. Their accounts are optional — somebody can be added by name and attached to their
 * accounts when they pair.
 */

import { platformName } from "@/commons/lib/platform";
import { isAdmin, useMe } from "@/commons/lib/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Lock, NotebookText, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { api, type PersonRecord } from "@/commons/lib/api";
import { PersonNotes } from "@/commons/components/people/PersonNotes";
import { MorningLine } from "./components/MorningLine";
import { Card, EmptyState, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { keyProblem, suggestKey, typedKey } from "@/commons/lib/person-key";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { useSaved } from "@/commons/hooks/use-saved";

export default function PeoplePage() {
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const me = useMe();
  const [adding, setAdding] = useState(false);
  // Held here, not in the row: the dialog is drawn outside the table, which a row cannot contain.
  const [notesOf, setNotesOf] = useState<PersonRecord | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["people"] });
  const list = people.data?.people ?? [];

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        title="People"
        description="Everyone your agents know, with the chat accounts each writes from. Add someone by name: their accounts can be added now, or approved as theirs when they first message an agent."
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
            onClick={() => setAdding(true)}
          >
            <Plus size={16} /> Add Person
          </button>
        }
      />

      {adding && (
        <PersonForm
          people={list}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      {people.isPending ? (
        <div className="flex justify-center py-16">
          <span className="loading loading-spinner loading-lg text-primary opacity-60" />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Nobody yet"
            description="Add the people in your household by name. Their WhatsApp, Telegram or Discord accounts can be added now, or approved as theirs when they first message an agent."
          />
        </Card>
      ) : (
        <ScrollCard fill title="Known People" description="One row per person. Your agents know who is writing, whichever of these accounts they write from.">
          <div className="overflow-x-auto -mx-4 -my-2 sm:-mx-6">
            {/*
              A card per person on a phone, the table from `sm` up: in four columns at phone width an account id had a
              column a few letters wide and broke after every one of them (0.8.0). Its cells lose the table's lines there,
              or one person read as four rows.
            */}
            <table className="table table-sm block w-full sm:table">
              {/* Sticky, so the column names stay while the rows scroll under them. */}
              <thead className="bg-base-100 sticky top-0 z-10 hidden sm:table-header-group">
                <tr className="border-b border-base-content/[0.08] text-base-content/65 text-[11px] uppercase tracking-wider font-mono">
                  <th className="pl-6">Display Name</th>
                  <th>Accounts</th>
                  <th>Notes</th>
                  <th className="text-right pr-6">Actions</th>
                </tr>
              </thead>
              <tbody className="block divide-y divide-base-content/[0.06] sm:table-row-group">
                {list.map((person) => (
                  <PersonRow key={person.key} person={person} people={list} editable={isAdmin(me.data ?? null)} onChanged={refresh} onNotes={() => setNotesOf(person)} />
                ))}
              </tbody>
            </table>
          </div>
        </ScrollCard>
      )}

      {notesOf ? <PersonNotes person={notesOf} editable={isAdmin(me.data ?? null)} onClose={() => setNotesOf(null)} /> : null}
    </div>
  );
}

function PersonRow({
  person,
  people,
  editable,
  onChanged,
  onNotes,
}: {
  person: PersonRecord;
  people: PersonRecord[];
  /** An admin: their entry is theirs to change, the morning line with it. */
  editable: boolean;
  onChanged: () => void;
  onNotes: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const saved = useSaved();
  const { ask, dialog } = useConfirm();
  const remove = useMutation({
    mutationFn: () => api.deletePerson(person.key),
    onSuccess: (answer) => {
      saved(answer, `${person.name} removed from People`);
      onChanged();
    },
    onError: (err) => toast.error(`Could not remove ${person.name}`, err),
  });
  const ids = person.ids ?? [];

  /**
   * What removing somebody does, said before it is done — and the one thing it does not do: what memory
   * learned about them stays, under their key, and Knowledge & Memory → People stops listing them once they are
   * gone, so Forget is only reachable before.
   */
  const confirmRemove = async () => {
    const yes = await ask({
      title: `Remove ${person.name} from People?`,
      body: (
        <div className="space-y-2">
          <p>
            {ids.length > 0
              ? `Every agent meets ${ids.length === 1 ? "their account" : `their ${ids.length} accounts`} as a stranger again, and their notes go with them.`
              : "Their notes go with them."}
          </p>
          <p>
            What memory has learned about them stays in <span className="font-mono">people/{person.key}.md</span>. To delete that
            too, use Forget in Knowledge & Memory → People first: once they are gone from People, it no longer lists them.
          </p>
        </div>
      ),
      confirmLabel: "Remove",
    });
    if (yes) remove.mutate();
  };

  return editing ? (
    <tr className="block sm:table-row">
      <td colSpan={4} className="block p-4 bg-base-200/50 sm:table-cell">
        <PersonForm
          existing={person}
          people={people}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          embedded
        />
      </td>
    </tr>
  ) : (
    <tr className="block py-2 hover:bg-base-200/40 transition-colors sm:table-row sm:py-0">
      <td className="block px-4 py-1.5 align-top max-sm:border-0 sm:table-cell sm:py-3 sm:pl-6 sm:pr-3">
        <div className="font-semibold text-sm text-base-content">{person.name}</div>
        <div className="font-mono text-[11px] text-base-content/65" title="Person key: what is remembered about them is kept under it">
          {person.key}
        </div>
      </td>
      <td className="block px-4 py-1.5 font-mono text-xs align-top max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
        {ids.length > 0 ? (
          <div className="space-y-1">
            {ids.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <span className="badge badge-sm badge-ghost font-semibold shrink-0 font-mono">{platformName(id)}</span>
                <span className="text-base-content/85 break-all">{id}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="font-sans text-base-content/65" title="Approve their account as this person in Access when they pair, or add one with Edit.">
            No account yet
          </span>
        )}
      </td>
      <td className="block px-4 py-1.5 text-xs text-base-content/70 align-top max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
        {/* Just the button: a line of the notes read cut off mid-sentence and widened the table. */}
        <div className="flex flex-col items-start gap-1">
          <button type="button" className="btn btn-ghost btn-xs shrink-0 gap-1 rounded-lg font-medium" onClick={onNotes}>
            <NotebookText size={12} /> {person.notes?.trim() ? "Notes" : "Add notes"}
          </button>
          <MorningLine person={person} editable={editable} onChanged={onChanged} />
        </div>
      </td>
      <td className="block px-4 py-1.5 align-top max-sm:border-0 sm:table-cell sm:py-3 sm:pr-6 sm:pl-3 sm:text-right">
        <div className="flex items-center justify-start gap-1 sm:justify-end">
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg font-medium hover:bg-base-200"
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} /> Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
            onClick={() => void confirmRemove()}
            disabled={remove.isPending}
            title={`Remove ${person.name}`}
            aria-label={`Remove ${person.name}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
        {/* In the cell rather than the row: a dialog is not a table's child, and as a modal it is not in the flow. */}
        {dialog}
      </td>
    </tr>
  );
}

function PersonForm({
  existing,
  people,
  onClose,
  onSaved,
  embedded = false,
}: {
  existing?: PersonRecord;
  people: PersonRecord[];
  onClose: () => void;
  onSaved: () => void;
  embedded?: boolean;
}) {
  /**
   * Every account this person is reachable at, all equal — and none at all is fine.
   *
   * Until 0.7.0 the first account was the person, so the form marked it "primary", would not let the
   * last original one go, and could not add somebody without one. The key is the person now.
   */
  const [ids, setIds] = useState<string[]>(() => existing?.ids ?? []);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState(existing?.name ?? "");
  // Only when adding: an existing person's notes are edited in the notes dialog, and left out of
  // this save so it keeps them.
  const [notes, setNotes] = useState("");

  /**
   * The person key: made from the name as it is typed, until the operator types one of their own —
   * then theirs, kept to what a key can be. Emptied, it follows the name again.
   */
  const taken = new Set(people.map((person) => person.key));
  const [ownKey, setOwnKey] = useState<string | null>(null);
  const key = existing?.key ?? ownKey ?? (name.trim() ? suggestKey(name, taken) : "");
  const problem = existing ? null : keyProblem(key, people);

  /** The one in the box counts too, so a half-typed id is not silently dropped by Save. */
  const pending = draft.trim();
  const allIds = pending && !ids.includes(pending) ? [...ids, pending] : ids;

  const addDraft = () => {
    if (!pending || ids.includes(pending)) {
      setDraft("");
      return;
    }
    setIds([...ids, pending]);
    setDraft("");
  };

  const announce = useSaved();
  const save = useMutation({
    mutationFn: () =>
      api.savePerson({
        key,
        name: name.trim(),
        // Always sent, including empty — the daemon reads an empty list as "no account" and an absent
        // one as "leave it". Dropping it meant an emptied list did nothing.
        ids: allIds,
        // With what it opened with: a list replaces theirs, so an account paired while this was open is
        // refused (409) rather than taken away again.
        ...(existing ? { expectedIds: existing.ids ?? [] } : {}),
        ...(existing ? {} : { notes: notes.trim(), create: true }),
      }),
    onSuccess: (answer) => {
      announce(answer, name.trim());
      onSaved();
    },
  });

  const body = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Display Name" hint="How the agent should address this person.">
        <input
          className="input w-full text-sm rounded-xl"
          value={name}
          placeholder="e.g. Kak Sam"
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>

      <Field
        label="Person Key"
        hint={
          existing
            ? "Fixed: what is remembered about them is kept under it, and changing it would leave that behind."
            : `Made from the name; type your own if you like. Lowercase letters and digits, words joined by "-". What is remembered about them is kept under it, so it cannot be changed later.`
        }
      >
        {existing ? (
          <div className="input w-full font-mono text-sm rounded-xl flex items-center gap-2 bg-base-200/60 text-base-content/70">
            <Lock size={13} className="shrink-0 opacity-60" />
            {key}
          </div>
        ) : (
          <input
            className={`input w-full font-mono text-sm rounded-xl ${problem && key ? "input-error" : ""}`}
            value={key}
            placeholder="e.g. sam"
            aria-label="Person Key"
            aria-invalid={Boolean(problem && key)}
            onChange={(e) => {
              const typed = typedKey(e.target.value);
              setOwnKey(typed === "" ? null : typed);
            }}
          />
        )}
      </Field>
      {problem && key ? <p className="-mt-2 text-xs text-error">{problem}</p> : null}

      <Field
        label="Accounts (optional)"
        hint='One per account, with its platform: "whatsapp:100000000000003@lid", "telegram:5550001111", "discord:214…". Leave it empty to attach them later, and approve their account as this person in Access when they pair.'
      >
        <div className="space-y-2">
          {ids.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ids.map((entry) => (
                <span
                  key={entry}
                  className="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-xl border font-mono text-xs bg-base-200/70 border-base-content/10 text-base-content/85"
                >
                  <span className="break-all">{entry}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-circle size-5 max-sm:size-7 min-h-0 hover:bg-error/15 hover:text-error"
                    onClick={() => setIds(ids.filter((candidate) => candidate !== entry))}
                    title={`Remove ${entry}`}
                    aria-label={`Remove ${entry}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={draft}
              placeholder="whatsapp:123456789@lid"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds an id rather than submitting: this box is inside the form, and a person
                // halfway through a list does not mean "save now".
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
              // Not added on blur. Clicking Save blurs this box first, and a first chip appearing then
              // pushed the button down under the pointer, so the click landed beside it and nothing was
              // saved — for a person with no account yet, every time. What is typed here is saved anyway.
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm h-auto rounded-xl gap-1.5 border border-base-content/10 shrink-0"
              onClick={addDraft}
              disabled={!pending || ids.includes(pending)}
            >
              <Plus size={14} /> Add id
            </button>
          </div>
        </div>
      </Field>

      {existing ? null : (
        <Field
          label="Notes (optional)"
          hint="Markdown. Every agent reads it whenever this person is the one speaking: what to call them, who they are, what is worth knowing. Later, open it from Notes on their row."
        >
          <textarea
            className="textarea w-full rounded-xl font-mono text-sm"
            rows={notes.includes("\n") ? 10 : 3}
            value={notes}
            placeholder={"e.g. Call her Kak Sam. Alex's sister; prefers short answers."}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      )}

      <ErrorNote error={save.error} />

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="submit"
          className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
          disabled={save.isPending || !name.trim() || Boolean(problem)}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          {existing ? "Save Changes" : "Add Person"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );

  if (embedded) return body;
  return (
    <Card title={existing ? "Edit Person" : "Add Person"} className="border-primary/30 shadow-lg">
      {body}
    </Card>
  );
}
