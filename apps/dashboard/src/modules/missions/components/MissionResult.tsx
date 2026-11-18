/**
 * What a mission handed back — its report and its result files — across the page under its meters (0.8.8), folded to a
 * screenful until opened. It was a card in the side column, and a report of a few hundred words made that column a
 * scroll of its own, the questions and what decides "done" far below it.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Markdown } from "@/commons/components/ui/Markdown";
import { OwnPictures } from "@/commons/components/ui/markdown/Picture";
import { MarkdownPreview } from "@/commons/components/ui/MarkdownPreview";
import { cn } from "@/commons/lib/utils";
import { inFolder } from "../lib/mission";
import { FilePath } from "@/commons/components/ui/FilePath";
import { Leaving } from "@/commons/components/ui/OverPage";

/** The endings the daemon serves as a result's picture (`GET /missions/:id/files/:index`). */
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Which of a mission's result files a report means by a picture's name: the file as its folder has it
 * (`charts/flow.png`), or its name alone (`flow.png`), with or without a leading `./`. The address to draw it from,
 * or null where the name is none of them or is no picture.
 */
export function ownPicture(missionId: string, files: readonly string[], workdir: string, name: string): string | null {
  // As written, or as a link writes a space: a name that does not decode is taken as it stands.
  let asked = name.trim();
  try {
    asked = decodeURIComponent(asked);
  } catch {
    /* as it stands */
  }
  asked = asked.replace(/^\.\//, "");
  const index = files.findIndex((file) => PICTURE.test(file) && (inFolder(file, workdir) === asked || file === asked || file.slice(file.lastIndexOf("/") + 1) === asked));
  return index < 0 ? null : api.missionPictureUrl(missionId, index);
}

export function MissionResult({ missionId, report, files, workdir }: { missionId: string; report: string | null; files: string[]; workdir: string }) {
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

  // A picture the report names among the mission's own result files is drawn in place, here and in the report opened whole.
  const pictures = (name: string) => ownPicture(missionId, files, workdir, name);
  return (
    <OwnPictures.Provider value={pictures}>
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
    </OwnPictures.Provider>
  );
}
