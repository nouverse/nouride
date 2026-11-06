/**
 * Copy a piece of text, and say so for two seconds.
 *
 * There were two of these. The chat's cleared its timer when the button went away; the Integrations
 * page's did not, so leaving the page inside those two seconds set state on a component that was gone.
 * One button now, with the chat's timer, and each place keeps its own size through `className`.
 */

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/commons/lib/clipboard";

export function CopyButton({ text, className = "btn btn-ghost btn-xs shrink-0 gap-1 rounded-lg" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(text).then((ok) => ok && setCopied(true));
      }}
      className={className}
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      <span className={copied ? "text-success" : undefined}>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
