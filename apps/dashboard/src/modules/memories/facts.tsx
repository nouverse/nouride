/**
 * A profile's facts, as a person reads them: under their topic headings, each with the conversation
 * it came from and who may read it.
 *
 * The file format is the engine's (`modules/memory/profile.ts`); this reads it for display only, so a
 * fact line `- Uses a MacBook M3. ([[2026-09-20-1405-nix]]) {gading}` shows as the sentence, a link
 * to its conversation, and "Gading". Editing is the document editor's, on the file itself.
 */

import { Link2 } from "lucide-react";

export interface Fact {
  section: string;
  text: string;
  source?: string;
  readers?: { people: string[]; chat?: string };
}

const HEADING = /^##\s+(.+?)\s*$/;
const FACT = /^[-*]\s+(.*?)(?:\s+\(\[\[([^\]|]+)\]\]\))?(?:\s+\{([^}]*)\})?\s*$/;

/** The body after the frontmatter. */
function bodyOf(text: string): string {
  const fence = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.exec(text);
  return fence ? text.slice(fence[0].length) : text;
}

export function factsOf(text: string): Fact[] {
  const facts: Fact[] = [];
  let section = "Notes";
  for (const line of bodyOf(text).split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const match = FACT.exec(line);
    if (!match?.[1]?.trim()) continue;
    const readers = match[3]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    facts.push({
      section,
      text: match[1].trim(),
      ...(match[2] ? { source: match[2] } : {}),
      ...(readers
        ? { readers: { people: readers.filter((item) => !item.startsWith("in ")), ...(readers.find((item) => item.startsWith("in ")) ? { chat: readers.find((item) => item.startsWith("in "))!.slice(3) } : {}) } }
        : {}),
    });
  }
  return facts;
}

/** Who may read a fact, in words. */
function readersLabel(fact: Fact, nameOf: (key: string) => string): string {
  if (!fact.readers) return "Written by hand";
  const people = fact.readers.people.map(nameOf).join(", ");
  return fact.readers.chat ? `Said in a group with ${people}` : `Only where ${people} ${fact.readers.people.length > 1 ? "are" : "is"}`;
}

export function FactList({ facts, nameOf, onOpenEpisode }: { facts: Fact[]; nameOf: (key: string) => string; onOpenEpisode: (id: string) => void }) {
  const sections = [...new Set(facts.map((fact) => fact.section))];
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section} className="space-y-1">
          <p className="text-base-content/65 text-[11px] font-semibold uppercase tracking-wider font-mono">{section}</p>
          <ul className="space-y-1">
            {facts
              .filter((fact) => fact.section === section)
              .map((fact) => (
                <li key={`${section}:${fact.text}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span>{fact.text}</span>
                  <span className="text-base-content/65 text-xs">{readersLabel(fact, nameOf)}</span>
                  {fact.source ? (
                    <button type="button" className="link link-hover text-base-content/65 inline-flex items-center gap-0.5 text-xs" onClick={() => onOpenEpisode(fact.source!)}>
                      <Link2 size={11} /> from a conversation
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
