/**
 * What a mission handed back — its report and its result files — across the page under its meters (0.8.8), folded to a
 * screenful until opened. It was a card in the side column, and a report of a few hundred words made that column a
 * scroll of its own, the questions and what decides "done" far below it.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { Markdown } from "@/commons/components/ui/Markdown";
import { MarkdownPreview } from "@/commons/components/ui/MarkdownPreview";
import { cn } from "@/commons/lib/utils";
import { inFolder } from "../lib/mission";
import { FilePath } from "@/commons/components/ui/FilePath";
import { Leaving } from "@/commons/components/ui/OverPage";

export function MissionResult({ report, files, workdir }: { report: string | null; files: string[]; workdir: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  /** `report.md` opened whole, as the chat received it (0.8.11). */
  const [reading, setReading] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // The press to open only where the fold cuts it, measured as the goal's is (`Goal.tsx`).
  useLayoutEffect(() => {
    const shown = body.current;
    if (!shown || open) return;
    const measure = () => setCut(shown.scrollHeight > shown.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [report, open]);

  return (
    <div className="space-y-3">
      {report && (
        <div className="relative">
          <div ref={body} className={cn("text-sm leading-relaxed [overflow-wrap:anywhere]", !open && "max-h-72 overflow-hidden")}>
            <Markdown source={report} />
          </div>
          {cut && !open && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-base-100 to-transparent" />}
        </div>
      )}
      {report && (
        <div className="flex flex-wrap items-center gap-1 -ml-2">
          <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg font-mono" onClick={() => setReading(true)}>
            <FileText size={12} aria-hidden="true" /> Full report
          </button>
          {(cut || open) && (
            <button type="button" className="btn btn-ghost btn-xs rounded-lg" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
              {open ? "Show less" : "Show the whole result"}
            </button>
          )}
        </div>
      )}
      <Leaving value={reading && report}>{(source) => <MarkdownPreview name="report.md" source={source} onClose={() => setReading(false)} />}</Leaving>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((file) => (
            <li key={file} className="badge badge-ghost h-auto max-w-full gap-1.5 py-1 font-mono text-[11px] break-all">
              <FileText size={12} className="shrink-0" aria-hidden="true" />
              <FilePath text={file} link="text-primary hover:underline">
                {inFolder(file, workdir)}
              </FilePath>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
