/**
 * Whose chats an admin reads, picked in one place beside the search: Mine, Everyone, each person in People by name, and
 * the private chats nobody in People is known for.
 *
 * One control in the search's row: Mine and Everyone as a bar of their own, with a field for the person under it, were
 * three rows stacked above the list before anything in it showed.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";
import { SearchSelect, type SearchSelectOption } from "@/commons/components/ui/SearchSelect";
import type { Whose } from "../hooks/use-whose";

/** What the list offers: the reader's own first, everyone's, each person by name, then nobody known. */
export function peopleOptions(people: readonly { key: string; name: string }[]): SearchSelectOption<Whose>[] {
  return [
    { value: "mine", label: "Mine" },
    { value: "everyone", label: "Everyone" },
    ...[...people].sort((a, b) => a.name.localeCompare(b.name)).map((person) => ({ value: `person:${person.key}` as Whose, label: person.name })),
    { value: "unknown", label: "Not known" },
  ];
}

export function PeopleFilter({ value, onChange, className }: { value: Whose; onChange: (next: Whose) => void; className?: string }) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  return (
    <SearchSelect
      options={peopleOptions(people.data?.people ?? [])}
      value={value}
      onChange={onChange}
      label="Whose chats"
      searchLabel="Find a person"
      noMatch={(typed) => `Nobody called “${typed}”`}
      placeholder="Mine"
      className={cn("max-w-[9.5rem]", className)}
    />
  );
}
