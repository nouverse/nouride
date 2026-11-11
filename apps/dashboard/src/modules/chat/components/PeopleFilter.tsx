/**
 * Whose chats an admin reads, picked in one place beside the search: Mine, Everyone, each person in People by name, and
 * the private chats nobody in People is known for.
 *
 * One control in the search's row: Mine and Everyone as a bar of their own, with a field for the person under it, were
 * three rows stacked above the list before anything in it showed.
 *
 * The person the reader is in People is not named apart: Mine is theirs already, and lists the same chats and the
 * rooms they made. An admin read "Mine" and their own name as two choices for one person.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";
import { SearchSelect, type SearchSelectOption } from "@/commons/components/ui/SearchSelect";
import type { Whose } from "../hooks/use-whose";

/**
 * What the list offers: the reader's own first, everyone's, each other person by name, then nobody known. `mine` is
 * the key of the person the reader is, where they are one: left out of the names, since Mine is that person's.
 */
export function peopleOptions(people: readonly { key: string; name: string }[], mine?: string): SearchSelectOption<Whose>[] {
  return [
    { value: "mine", label: "Mine" },
    { value: "everyone", label: "Everyone" },
    ...people
      .filter((person) => person.key !== mine)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((person) => ({ value: `person:${person.key}` as Whose, label: person.name })),
    { value: "unknown", label: "Not known" },
  ];
}

export function PeopleFilter({ value, onChange, className }: { value: Whose; onChange: (next: Whose) => void; className?: string }) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  const me = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe, staleTime: 60_000 });
  const mine = me.data?.person?.key;
  // A choice kept in this browser from when their own name was one of the list's: it is Mine now.
  useEffect(() => {
    if (mine !== undefined && value === `person:${mine}`) onChange("mine");
  }, [mine, value, onChange]);
  return (
    <SearchSelect
      options={peopleOptions(people.data?.people ?? [], mine)}
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
