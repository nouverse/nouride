/**
 * An agent's tag, `@nouva`, in that agent's colour: in a person's words, an agent's answer, a quoted line, and a room's
 * member chips. Every tag there was plain text, the same as the words around it, so a room's message to three agents
 * read as one grey line. One function finds the tags (`splitTags`) and one piece draws them (`AgentTag`), so a tag reads
 * the same wherever it is.
 *
 * Only a name that is one of our agents' — its id or its name, as a group's tags are read (`readTags`) — is a tag: an
 * `@` that names nobody, an email address, and anything in backticks stay as they were written.
 */

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlainWords } from "@/commons/components/ui/Markdown";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";

export type TagPart = string | { tag: string; agentId: string };

/** The names a tag can be written with: each agent's id and its name. */
export interface TagName {
  name: string;
  agentId: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` cut into its words and its agents' tags, in order. A tag is an `@` and a name, not inside a word (an email's
 * `@`), not running on into one, and never in a code span: what is in backticks is quoted, not addressed.
 */
export function splitTags(text: string, names: readonly TagName[]): TagPart[] {
  const known = names.filter((one) => one.name.trim());
  if (known.length === 0 || !text.includes("@")) return [text];
  const byName = new Map(known.map((one) => [one.name.toLowerCase(), one.agentId]));
  const alternatives = [...byName.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  const tag = new RegExp(`(?<![\\w@.])@(${alternatives})(?![\\w-])`, "gi");
  const parts: TagPart[] = [];
  const push = (part: TagPart) => {
    const last = parts.at(-1);
    if (typeof part === "string" && typeof last === "string") parts[parts.length - 1] = last + part;
    else if (part !== "") parts.push(part);
  };
  // Odd pieces are code spans, kept whole.
  text.split(/(`[^`\n]*`)/).forEach((piece, at) => {
    if (at % 2 === 1) return push(piece);
    let from = 0;
    for (const match of piece.matchAll(tag)) {
      push(piece.slice(from, match.index));
      push({ tag: match[0], agentId: byName.get(match[1]!.toLowerCase())! });
      from = match.index + match[0].length;
    }
    push(piece.slice(from));
  });
  return parts.length > 0 ? parts : [text];
}

/** Every agent's names, from `/status`: what `splitTags` looks for. */
function useTagNames(): TagName[] {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agents = status.data?.agents;
  return useMemo(() => (agents ?? []).flatMap((agent) => [{ name: agent.id, agentId: agent.id }, ...(agent.displayName ? [{ name: agent.displayName, agentId: agent.id }] : [])]), [agents]);
}

/**
 * One tag, in its agent's colour: the tint its name wears over its replies, drawn a step further towards the text so it
 * reads on a person's lilac bubble and on the page alike, on a pill of the same colour faintly behind it.
 */
export function AgentTag({ agentId, bare = false, children, className }: { agentId: string; /** The colour alone, inside a chip of its own. */ bare?: boolean; children: ReactNode; className?: string }) {
  const face = useAgentFace(agentId);
  const style = face?.tint ? ({ "--tag": `color-mix(in oklab, ${face.tint} 75%, var(--color-base-content))` } as CSSProperties) : undefined;
  return (
    <span
      data-agent-tag={agentId}
      style={style}
      className={cn("font-semibold text-[color:var(--tag,currentColor)]", !bare && "rounded-md px-1 py-px [background:color-mix(in_oklab,var(--tag,transparent)_14%,transparent)]", className)}
    >
      {children}
    </span>
  );
}

/** Words with their agents' tags drawn as tags. */
export function TaggedText({ text }: { text: string }) {
  const names = useTagNames();
  return (
    <>
      {splitTags(text, names).map((part, at) => (typeof part === "string" ? part : <AgentTag key={at} agentId={part.agentId}>{part.tag}</AgentTag>))}
    </>
  );
}

/** An agent's answers read with their tags drawn as tags: `Markdown`'s plain words, never its code. */
export function TagsInMarkdown({ children }: { children: ReactNode }) {
  return <PlainWords.Provider value={(text) => <TaggedText text={text} />}>{children}</PlainWords.Provider>;
}
