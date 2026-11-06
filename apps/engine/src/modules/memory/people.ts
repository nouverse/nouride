/**
 * Who a sender is, as memory writes them.
 *
 * `[[people]]` already answers "which human is this" across platforms (`people/match.ts`). Memory
 * needs one more thing: an identity to put in an episode's `people` and a fact's readers — the
 * person's `key` when they have one, otherwise the platform-qualified id (`telegram:814…`).
 *
 * Platform-qualified rather than connection-qualified: which of the bots a message arrives on is
 * decided by which one was tagged, and the same person talking to two of them is one identity.
 *
 * Pure.
 */

import type { FactsMode, MemorySection, Person } from "@nouride/shared";
import { idFormsFor, idsOf, personIdMatches } from "@/modules/people/match.ts";

export interface Sender {
  gatewayId: string;
  senderId: string;
}

/** The `[[people]]` entry a sender is, if any. */
export function personOf(people: readonly Person[], sender: Sender): Person | undefined {
  return people.find((person) => idsOf(person).some((id) => personIdMatches(id, sender)));
}

export function identityOf(people: readonly Person[], sender: Sender): string {
  const key = personOf(people, sender)?.key;
  if (key) return key;
  const forms = idFormsFor(sender);
  return forms[forms.length - 1] ?? `${sender.gatewayId}:${sender.senderId}`;
}

/** Whether an identity is a person key (a profile can exist) rather than a platform id. */
export function isKey(identity: string): boolean {
  return !identity.includes(":");
}

/** How an identity is named in a transcript or a prompt. */
export function nameOf(people: readonly Person[], identity: string, fallback?: string): string {
  return people.find((person) => person.key === identity)?.name ?? fallback ?? identity;
}

/** What the nightly pass may do to this person's profile: their own `facts`, else `[memory] facts`. */
export function factsModeFor(config: { memory: Pick<MemorySection, "facts">; people: readonly Person[] }, key: string): FactsMode {
  return config.people.find((person) => person.key === key)?.facts ?? config.memory.facts;
}

/** Whether what is remembered about this person goes into prompts: their own `recall`, else `[memory] recall`. */
export function recallOn(config: { memory: Pick<MemorySection, "recall">; people: readonly Person[] }, key: string): boolean {
  return config.people.find((person) => person.key === key)?.recall ?? config.memory.recall;
}
