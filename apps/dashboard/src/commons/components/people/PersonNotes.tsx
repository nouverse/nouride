/**
 * A person's notes — `notes` on their `[[people]]` entry — in the notes dialog. Opened from People and
 * from Memory, so both edit the one text.
 *
 * Who somebody is and what does not change. An admin writes anyone's here; the person changes their
 * own through an agent (`person_notes`), a line at a time and only ever theirs. Every agent reads them
 * whenever this person is the one speaking. What changes over time goes to their memory profile, which
 * keeps where each fact came from and who may read it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PersonRecord } from "@/commons/lib/api";
import { NotesModal } from "@/commons/components/ui/NotesModal";

/** Their entry, by key: the one name for them that never changes. */
function entryFor(people: PersonRecord[], person: { key: string }): PersonRecord | undefined {
  return people.find((entry) => entry.key === person.key);
}

export function PersonNotes({ person, editable, onClose }: { person: { key: string; name: string }; editable: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const entry = people.data ? entryFor(people.data.people, person) : undefined;
  const name = entry?.name ?? person.name;
  const gone = people.data && !entry ? new Error(`${person.name} is no longer in People.`) : null;

  return (
    <NotesModal
      title={`Notes about ${name}`}
      description={`Who ${name} is and what does not change. Every agent reads these whenever ${name} is the one speaking, and changes a line when ${name} asks. What changes over time is kept in Memory.`}
      content={entry ? (entry.notes ?? "") : undefined}
      error={people.error ?? gone}
      editable={editable && entry !== undefined}
      placeholder="e.g. Call her Kak Sam. Alex's sister; prefers short answers."
      onSave={async (text, opened) => {
        if (!entry) return;
        // By key, with their name as it is: only the notes change, and `ids` left out keeps every address.
        await api.savePerson({ key: entry.key, name: entry.name, notes: text.trim(), expectedNotes: opened });
        await queryClient.invalidateQueries({ queryKey: ["people"] });
        return text.trim();
      }}
      onReload={() => void queryClient.invalidateQueries({ queryKey: ["people"] })}
      onClose={onClose}
    />
  );
}
