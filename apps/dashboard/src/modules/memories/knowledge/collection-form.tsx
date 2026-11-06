/**
 * A collection made, or its settings changed (0.8.20, KNOWLEDGE_BASE §5): its name, the line agents read to know when
 * to look in it, who may be answered from it, which agents look in it, and whom it is about.
 *
 * Who may be answered is closed until opened: "Only me" unless an admin says wider. Everyone, one group or chosen people
 * are an admin's choices and shown to an admin alone, as the daemon refuses them from anyone else; an operator changes
 * the rest and reads who may be answered as it stands.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { CollectionInput, KnowledgeCollection, KnowledgeReaders } from "@/commons/lib/api.knowledge";
import { overPage } from "@/commons/components/ui/OverPage";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import type { KnowledgeNames } from "./names";
import { readersLine } from "./words";

type Choice = "me" | "admins" | "everyone" | "group" | "people";

/** The form's choice for readers as they stand. */
function choiceOf(readers: KnowledgeReaders, me: string | null): { choice: Choice; group: string; people: string[] } {
  if (readers.kind === "people") return readers.people.length === 1 && readers.people[0] === me ? { choice: "me", group: "", people: [] } : { choice: "people", group: "", people: [...readers.people] };
  if (readers.kind === "group") return { choice: "group", group: readers.chat, people: [] };
  return { choice: readers.kind, group: "", people: [] };
}

/** The readers a choice sends, or null for none: "Only me" on a new collection is the daemon's to fill in. */
export function readersOf(choice: Choice, picked: { group: string; people: readonly string[]; me: string | null }, making: boolean): KnowledgeReaders | null {
  switch (choice) {
    case "me":
      return making || !picked.me ? null : { kind: "people", people: [picked.me] };
    case "admins":
    case "everyone":
      return { kind: choice };
    case "group":
      return { kind: "group", chat: picked.group };
    case "people":
      return { kind: "people", people: [...picked.people] };
  }
}

const same = (a: readonly string[] | null, b: readonly string[] | null) => JSON.stringify(a) === JSON.stringify(b);

function Chip({ on, onToggle, children }: { on: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`btn btn-xs rounded-lg ${on ? "btn-primary btn-soft" : "btn-ghost border border-base-content/15 text-base-content/65"}`}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

const toggled = (list: readonly string[], item: string) => (list.includes(item) ? list.filter((other) => other !== item) : [...list, item]);

function Choose({ checked, label, hint, onChoose, children }: { checked: boolean; label: string; hint?: string; onChoose: () => void; children?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="radio" className="radio radio-sm radio-primary mt-0.5" checked={checked} onChange={onChoose} />
        <span>
          <span className="font-medium">{label}</span>
          {hint ? <span className="text-base-content/65 block text-xs">{hint}</span> : null}
        </span>
      </label>
      {checked && children ? <div className="pl-7">{children}</div> : null}
    </div>
  );
}

export function CollectionForm({ collection, names, admin, onClose, onSaved }: { collection?: KnowledgeCollection; names: KnowledgeNames; admin: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const making = !collection;
  const start = collection ? choiceOf(collection.readers, names.me) : { choice: "me" as Choice, group: "", people: [] as string[] };
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [choice, setChoice] = useState<Choice>(start.choice);
  const [group, setGroup] = useState(start.group);
  const [people, setPeople] = useState<string[]>(start.people);
  const [agents, setAgents] = useState<string[] | null>(collection?.agents ?? null);
  const [about, setAbout] = useState<string[]>(collection?.about ?? []);

  const readers = readersOf(choice, { group, people, me: names.me }, making);
  const problem = !name.trim()
    ? "A collection needs a name."
    : choice === "group" && !group
      ? "Choose the group."
      : choice === "people" && people.length === 0
        ? "Choose at least one person."
        : agents !== null && agents.length === 0
          ? "Choose at least one agent, or let every agent look in it."
          : null;

  const save = useMutation({
    mutationFn: async () => {
      if (making) {
        const made = await api.createCollection({ name: name.trim(), description: description.trim(), agents, about, ...(readers ? { readers } : {}) });
        return made.collection?.id ?? null;
      }
      const patch: CollectionInput = {};
      if (name.trim() !== collection.name) patch.name = name.trim();
      if (description.trim() !== collection.description) patch.description = description.trim();
      if (!same(agents, collection.agents)) patch.agents = agents;
      if (!same(about, collection.about)) patch.about = about;
      if (admin && readers && JSON.stringify(readers) !== JSON.stringify(collection.readers)) patch.readers = readers;
      await api.updateCollection(collection.id, patch);
      return collection.id;
    },
    onSuccess: async (id) => {
      toast.success(making ? `${name.trim()} made` : `${name.trim()} saved`);
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-graph"] });
      if (id) onSaved?.(id);
      onClose();
    },
  });

  const noPerson = names.me === null;
  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={making ? "New collection" : `Settings of ${collection.name}`}>
      <form
        className="modal-box max-h-[90vh] max-w-lg space-y-4 overflow-y-auto rounded-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) save.mutate();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold">{making ? "New collection" : `Settings of ${collection.name}`}</h3>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <Field label="Name">
          <input className="input w-full rounded-xl text-sm" value={name} maxLength={80} placeholder="Mum's health" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="What is in it" hint="One line your agents read, so they know when to look in it.">
          <input className="input w-full rounded-xl text-sm" value={description} maxLength={300} placeholder="Lab results and check-up dates" onChange={(event) => setDescription(event.target.value)} />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-base-content/85 mb-1.5 text-xs font-semibold uppercase tracking-wider font-mono">Who may be answered from it</legend>
          {!admin && !making ? (
            <p className="text-sm">
              {readersLine(collection.readers, names)} <span className="text-base-content/65">Only an admin changes this.</span>
            </p>
          ) : (
            <>
              {!(noPerson && !making) ? (
                <Choose
                  checked={choice === "me"}
                  label="Only me"
                  hint={noPerson ? "Your account is not linked to anyone in People, so only the admins can be answered from it." : "In a chat with just you."}
                  onChoose={() => setChoice("me")}
                />
              ) : null}
              {!making && (collection.readers.kind === "admins" || noPerson) ? (
                <Choose checked={choice === "admins"} label="Only the admins" hint="Each in a chat with just them." onChoose={() => setChoice("admins")} />
              ) : null}
              {admin ? (
                <>
                  <Choose checked={choice === "everyone"} label="Everyone" hint="Anyone your agents talk with, in any chat." onChoose={() => setChoice("everyone")} />
                  <Choose checked={choice === "group"} label="One group" hint="Everyone in that group chat, there." onChoose={() => setChoice("group")}>
                    {names.groups.length ? (
                      <select className="select select-sm w-full rounded-xl" aria-label="The group" value={group} onChange={(event) => setGroup(event.target.value)}>
                        <option value="">Choose a group</option>
                        {names.groups.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-base-content/65 text-xs">No group chat is known yet. Groups show up once an agent has talked in one.</p>
                    )}
                  </Choose>
                  <Choose checked={choice === "people"} label="Chosen people" hint="Each in a chat with just them, never in a group." onChoose={() => setChoice("people")}>
                    <div className="flex flex-wrap gap-1.5">
                      {names.people.map((person) => (
                        <Chip key={person.key} on={people.includes(person.key)} onToggle={() => setPeople(toggled(people, person.key))}>
                          {person.name}
                        </Chip>
                      ))}
                    </div>
                  </Choose>
                </>
              ) : (
                <p className="text-base-content/65 text-xs">An admin can open it to more people later.</p>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-base-content/85 mb-1.5 text-xs font-semibold uppercase tracking-wider font-mono">Which agents look in it</legend>
          <Choose checked={agents === null} label="Every agent" onChoose={() => setAgents(null)} />
          <Choose checked={agents !== null} label="Only these agents" onChoose={() => setAgents(agents ?? [])}>
            <div className="flex flex-wrap gap-1.5">
              {names.agents.map((agent) => (
                <Chip key={agent.id} on={agents?.includes(agent.id) ?? false} onToggle={() => setAgents(toggled(agents ?? [], agent.id))}>
                  {agent.name}
                </Chip>
              ))}
            </div>
          </Choose>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-base-content/85 mb-1.5 text-xs font-semibold uppercase tracking-wider font-mono">Who it is about</legend>
          <div className="flex flex-wrap gap-1.5">
            {names.people.map((person) => (
              <Chip key={person.key} on={about.includes(person.key)} onToggle={() => setAbout(toggled(about, person.key))}>
                {person.name}
              </Chip>
            ))}
          </div>
          <p className="text-base-content/65 text-xs">Optional. Their profile, in the People tab here, lists these documents. It does not let them be answered from it.</p>
        </fieldset>

        {problem && (name || !making) ? <p className="text-warning text-xs">{problem}</p> : null}
        <ErrorNote error={save.error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm rounded-xl" disabled={Boolean(problem) || save.isPending}>
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            {making ? "Make collection" : "Save"}
          </button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>,
  );
}
