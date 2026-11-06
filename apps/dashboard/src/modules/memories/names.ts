/**
 * Person keys to names, for every Memory tab. A sender with no `[[people]]` key is shown as their
 * platform id, which is the only name memory has for them.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";

export function useNames(): (identity: string) => string {
  const people = useQuery({ queryKey: ["memory-people"], queryFn: api.memoryPeople });
  const names = new Map((people.data?.people ?? []).flatMap((person) => (person.key ? [[person.key, person.name] as const] : [])));
  return (identity) => names.get(identity) ?? identity;
}
