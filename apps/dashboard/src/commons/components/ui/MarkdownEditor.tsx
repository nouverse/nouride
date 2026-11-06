/**
 * Markdown written and seen as it will read (0.8.20): the Edit and Preview switch, and the box it switches between. The
 * Files tab's, made one piece when the knowledge base's **Write a document** needed the same, so writing Markdown looks
 * and behaves alike wherever it is written. Rendered by `Markdown`, which writes no HTML of its own.
 */

import { Eye, Pencil } from "lucide-react";
import { cn } from "@/commons/lib/utils";
import { Markdown } from "./Markdown";

export type MarkdownMode = "edit" | "preview";

const segment = (active: boolean) =>
  `flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${active ? "bg-base-100 text-base-content shadow-xs" : "text-base-content/65"}`;

/** The two buttons: write it, or see how it reads. */
export function EditPreviewSwitch({ mode, onChange }: { mode: MarkdownMode; onChange: (mode: MarkdownMode) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-base-200 border border-base-content/10">
      <button type="button" aria-pressed={mode === "edit"} className={segment(mode === "edit")} onClick={() => onChange("edit")}>
        <Pencil size={12} /> Edit
      </button>
      <button type="button" aria-pressed={mode === "preview"} className={segment(mode === "preview")} onClick={() => onChange("preview")}>
        <Eye size={12} /> Preview
      </button>
    </div>
  );
}

/** The text being written, or how it reads: `className` sizes both alike. */
export function MarkdownArea({
  mode,
  value,
  onChange,
  readOnly,
  label,
  placeholder,
  className,
}: {
  mode: MarkdownMode;
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
}) {
  if (mode === "preview") {
    return (
      <div className={cn("border border-base-content/[0.08] bg-base-100/90 rounded-2xl p-5 sm:p-6 shadow-xs", className)}>
        {value.trim() ? <Markdown source={value} /> : <p className="text-base-content/65 text-sm">Nothing written yet.</p>}
      </div>
    );
  }
  return (
    <textarea
      className={cn("textarea w-full font-mono text-xs leading-relaxed rounded-2xl bg-base-100/90 p-4 focus:ring-2 focus:ring-primary/20", className)}
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      {...(label ? { "aria-label": label } : {})}
      {...(placeholder ? { placeholder } : {})}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
