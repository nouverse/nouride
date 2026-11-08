/**
 * The four ways `web_search` can be set up, as cards rather than a dropdown: the choice is the whole
 * page, and what each one costs (a key, a server, nothing) is what decides it — so it is on the card.
 */

import { Globe, Server, Sparkles, Waypoints, type LucideIcon } from "lucide-react";
import type { WebSearchMode } from "@nouride/wire";
import { cn } from "@/commons/lib/utils";

interface Choice {
  mode: WebSearchMode;
  title: string;
  icon: LucideIcon;
  badge: string;
  description: string;
}

const CHOICES: Choice[] = [
  {
    mode: "free",
    title: "Free sources",
    icon: Globe,
    badge: "No setup",
    description: "DuckDuckGo, Bing, Google News, Wikipedia, Reddit and more, asked at once. Works out of the box.",
  },
  {
    mode: "brave",
    title: "Brave Search API",
    icon: Sparkles,
    badge: "Recommended",
    description: "The steadiest results, and image search. Needs an API key; Brave has a free plan.",
  },
  {
    mode: "searxng",
    title: "SearXNG",
    icon: Server,
    badge: "Self-hosted",
    description: "Your own private metasearch server. Free, no key, image search included.",
  },
  {
    mode: "custom",
    title: "Another search service",
    icon: Waypoints,
    badge: "Advanced",
    description: "Any service that works like Brave's search: one of your own, or one that adds the key for you.",
  },
];

export function ProviderPicker({
  value,
  active,
  disabled,
  onChange,
}: {
  value: WebSearchMode;
  /** The one in use now, marked so a person can see what they would be changing from. */
  active: WebSearchMode;
  disabled?: boolean;
  onChange: (mode: WebSearchMode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Search provider" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {CHOICES.map(({ mode, title, icon: Icon, badge, description }) => {
        const selected = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={cn(
              "flex items-start gap-3 rounded-2xl border p-4 text-left transition-all active:scale-[0.99]",
              selected
                ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/40"
                : "border-base-content/[0.08] bg-base-100 hover:border-base-content/20 hover:bg-base-200/40",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl",
                selected ? "bg-primary text-primary-content" : "bg-base-200 text-base-content/70",
              )}
            >
              <Icon size={18} />
            </span>
            <span className="min-w-0 space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-base-content">{title}</span>
                <span className="badge badge-ghost badge-sm rounded-md text-[10px] font-semibold uppercase tracking-wide font-mono">
                  {badge}
                </span>
                {mode === active ? (
                  <span className="badge badge-success badge-outline badge-sm rounded-md text-[10px] font-semibold font-mono">In use</span>
                ) : null}
              </span>
              <span className="block text-xs leading-relaxed text-base-content/65">{description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
