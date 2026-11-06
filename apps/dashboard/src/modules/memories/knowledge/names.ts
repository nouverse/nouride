/**
 * The names a collection's settings are said with (0.8.20): people by name, groups by theirs, agents by theirs, and the
 * person this account is as "you". From the queries every page that lists them already holds.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { groupKey, type Names } from "./words";

export interface KnowledgeNames extends Names {
  agent: (id: string) => string;
  /** What a collection's settings can name, for the form's choices. */
  agents: { id: string; name: string }[];
  people: { key: string; name: string }[];
  groups: { key: string; name: string }[];
}

export function useKnowledgeNames(): KnowledgeNames {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const me = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  const personList = (people.data?.people ?? []).map((person) => ({ key: person.key, name: person.name }));
  const groupList = (groups.data?.groups ?? []).map((group) => ({ key: groupKey(group.gatewayId, group.chatId), name: group.name ?? group.platformTitle ?? group.chatId }));
  const agentList = (status.data?.agents ?? []).map((agent) => ({ id: agent.id, name: agent.displayName || agent.id }));
  const personName = new Map(personList.map((person) => [person.key, person.name]));
  const groupName = new Map(groupList.map((group) => [group.key, group.name]));
  const agentName = new Map(agentList.map((agent) => [agent.id, agent.name]));

  return {
    person: (key) => personName.get(key) ?? key,
    group: (chat) => groupName.get(chat),
    me: me.data?.person?.key ?? null,
    agent: (id) => agentName.get(id) ?? id,
    agents: agentList,
    people: personList,
    groups: groupList,
  };
}
