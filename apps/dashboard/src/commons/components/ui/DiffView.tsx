/**
 * Every diff the dashboard draws, one way (0.8.8): a skill's draft against the skill on disk, an approval's change to a
 * file or a persona — the owner: "semua diff harusnya pakai komponen yang sama aja". Each drew its own, and the skill's
 * ran its lines past the box that tinted them: unwrapped in a `<pre>`, the text was cut on the left and the colour
 * stopped halfway along a long line.
 *
 * A line is wrapped, never scrolled sideways: its sign in a column of its own, its text beside it, so a wrapped line
 * stays under its text and the tint is the whole row. Unchanged runs away from a change are folded (`diffPieces`), a
 * press away. The tint carries the meaning and the text stays the ordinary foreground — a `-content` colour over a 12%
 * wash is dark on dark in the dark theme.
 */

import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { diffPieces, type DiffRow } from "@/commons/lib/diff";
import { cn } from "@/commons/lib/utils";

const ROW: Record<DiffRow["sign"], string> = {
  "+": "bg-success/12",
  "-": "bg-error/12",
  " ": "text-base-content/70",
};
const SIGN: Record<DiffRow["sign"], { mark: string; tone: string; said: string }> = {
  "+": { mark: "+", tone: "text-success", said: "added" },
  "-": { mark: "−", tone: "text-error", said: "removed" },
  " ": { mark: "", tone: "", said: "" },
};

function Line({ row }: { row: DiffRow }) {
  const sign = SIGN[row.sign];
  return (
    <div className={cn("grid grid-cols-[1.75rem_minmax(0,1fr)]", ROW[row.sign])}>
      <span aria-hidden="true" className={cn("select-none text-center font-semibold", sign.tone)}>
        {sign.mark}
      </span>
      <span className="pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {sign.said ? <span className="sr-only">{sign.said}: </span> : null}
        {row.text || " "}
      </span>
    </div>
  );
}

function Folded({ rows }: { rows: DiffRow[] }) {
  const [open, setOpen] = useState(false);
  if (open) return rows.map((row, index) => <Line key={index} row={row} />);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 bg-base-content/[0.04] px-2 py-1 text-left text-base-content/70 hover:bg-base-content/[0.08]"
      onClick={() => setOpen(true)}
    >
      <ChevronsUpDown size={12} aria-hidden="true" />
      {rows.length} unchanged line{rows.length === 1 ? "" : "s"}
    </button>
  );
}

export function DiffView({ rows, context = 3, className }: { rows: readonly DiffRow[]; context?: number; className?: string }) {
  const pieces = diffPieces(rows, context);
  return (
    <div className={cn("max-h-96 overflow-y-auto rounded-xl border border-base-content/[0.08] bg-base-200/60 py-1 font-mono text-xs leading-relaxed", className)}>
      {pieces.map((piece, index) =>
        piece.kind === "folded" ? <Folded key={index} rows={piece.rows} /> : piece.rows.map((row, at) => <Line key={`${index}-${at}`} row={row} />),
      )}
    </div>
  );
}

/** What a diff adds and takes out — "+3 −1" — beside its name. */
export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-error">−{removed}</span>
    </span>
  );
}
