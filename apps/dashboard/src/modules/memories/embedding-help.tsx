/**
 * How to get an embedding model, said where it is asked for.
 *
 * Semantic search needs a provider that serves embeddings over the OpenAI wire (`/v1/embeddings`), and
 * a fresh install usually has none: an Anthropic profile cannot embed, and a gateway that serves chat
 * models may not either. The card used to offer "Choose a provider" and leave it there, so a person
 * with no such provider had no way to learn what to add. Three ways, each a provider added on the
 * Models page and a model name to type here.
 *
 * A command to run on another machine (Ollama's download of the model) is under Details (0.8.19): the people who read
 * this are not technical, and it is for whoever runs that machine.
 */

import { Link } from "@tanstack/react-router";
import { Details } from "@/commons/components/ui/Details";

const WAYS: { name: string; where: string; baseUrl: string; model: string; note: string; command?: string }[] = [
  { name: "Ollama", where: "free, on your own network", baseUrl: "http://<its address>:11434/v1", model: "bge-m3", note: "That machine needs the model downloaded first. Any API key will do.", command: "ollama pull bge-m3" },
  { name: "OpenAI", where: "in the cloud", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", note: "Your OpenAI API key. Costs a fraction of a cent per thousand memories." },
  { name: "Google Gemini", where: "in the cloud", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-embedding-001", note: "A Gemini API key from Google AI Studio." },
];

export function EmbeddingHelp({ hasEmbedder }: { hasEmbedder: boolean }) {
  // Nothing folded away on this tab but a command: the whole guide when there is nothing to choose, one line when
  // there is.
  if (hasEmbedder) {
    return (
      <p className="text-base-content/65 text-xs leading-relaxed">
        Want another? Ollama, OpenAI or Gemini, added as OpenAI-compatible on the{" "}
        <Link to="/models" className="link link-primary">
          Models
        </Link>{" "}
        page.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-base-content/[0.08] bg-base-200/40 p-3 text-sm">
      <p className="font-medium">You need a provider that makes embeddings</p>
      <p className="text-base-content/65 mt-2 text-xs leading-relaxed">
        Add one on the{" "}
        <Link to="/models" className="link link-primary">
          Models
        </Link>{" "}
        page as <b>OpenAI-compatible</b>, then choose it above and type its model. Any of these works:
      </p>
      <ul className="mt-2 space-y-2">
        {WAYS.map((way) => (
          <li key={way.name} className="text-xs leading-relaxed">
            <span className="font-semibold">{way.name}</span> <span className="text-base-content/65">({way.where})</span>
            <div className="text-base-content/70">
              Base URL <code className="bg-base-200 rounded px-1 font-mono">{way.baseUrl}</code>, model <code className="bg-base-200 rounded px-1 font-mono">{way.model}</code>. {way.note}
            </div>
            {way.command ? (
              <Details className="mt-1">
                <p>On that machine: <code className="font-mono">{way.command}</code></p>
              </Details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-base-content/65 mt-2 text-xs">Keyword search works without any of this; semantic search adds finding things by meaning.</p>
    </div>
  );
}
