/**
 * A block of code in a reply: its language, a button that copies it, and its words coloured by what they are.
 *
 * It was a grey box. A command to run had to be selected by hand, on a phone by dragging two handles, and forty lines
 * of TypeScript read as forty lines of the same grey. The button copies the code as it was written, nothing of the
 * colouring in it. The colours are the theme's own, so they follow light and dark, and each was measured against the
 * box behind it on both.
 *
 * The highlighter is asked for only when a block names a language it could know (`commons/lib/highlight.ts`, a chunk
 * of its own). Until it arrives, and whenever it does not, the block is the plain text it always was: the same words
 * in the same place, so nothing moves when the colours come.
 *
 * A block in a language that names a viewer (`viewers/index.ts`: a picture, a formula, a diagram) is drawn as what it
 * is, the viewer a chunk of its own asked for when such a block is drawn. A switch beside the copy button goes between
 * the drawing and the code. Until the viewer is here, while the block is still being written, and when the viewer does
 * not load or cannot draw it, the block is its code as above, with no error box: the code is what was written, and an
 * error says less than it does.
 */

import { Component, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import { viewerFor, type Viewer, type ViewerProps } from "@/commons/components/ui/viewers";
import type { CodePiece } from "@/commons/lib/highlight";

type Highlighter = typeof import("@/commons/lib/highlight");

/**
 * Past this many characters a block is drawn plain. Measured on a laptop: 50,000 characters of TypeScript are 10 ms
 * for the highlighter and 3,300 elements for the page, and four times that are 37 ms and 12,800; a phone is slower.
 * A block this long is a log or a dump, read by searching it and not by its colours.
 */
const COLOURED_UP_TO = 50_000;

/**
 * What each kind of piece is drawn in: the theme's own colours, each read against the block's box at 4.5 to 1 or
 * better on both themes. A kind not here is plain code.
 */
const TONE: Record<string, string> = {
  keyword: "text-secondary",
  built_in: "text-secondary",
  literal: "text-secondary",
  type: "text-secondary",
  "selector-tag": "text-secondary",
  doctag: "text-secondary",
  string: "text-success",
  regexp: "text-success",
  addition: "text-success",
  number: "text-warning",
  symbol: "text-warning",
  bullet: "text-warning",
  title: "text-primary",
  section: "text-primary font-semibold",
  name: "text-primary",
  "selector-id": "text-primary",
  "selector-class": "text-primary",
  attr: "text-accent",
  attribute: "text-accent",
  property: "text-accent",
  variable: "text-accent",
  "template-variable": "text-accent",
  deletion: "text-error",
  comment: "text-base-content/65 italic",
  quote: "text-base-content/65 italic",
  meta: "text-base-content/65",
};

let arriving: Promise<Highlighter> | null = null;
let arrived: Highlighter | null = null;

/** The highlighter, once it is here; null until then, and for a block that does not want it. */
function useHighlighter(wanted: boolean): Highlighter | null {
  const [here, setHere] = useState(arrived);
  useEffect(() => {
    if (!wanted || here) return;
    let drawn = true;
    arriving ??= import("@/commons/lib/highlight");
    arriving.then(
      (module) => {
        arrived = module;
        if (drawn) setHere(module);
      },
      // It did not load (an old tab after an update, a dropped connection): the block stays plain, and the next one asks again.
      () => {
        arriving = null;
      },
    );
    return () => {
      drawn = false;
    };
  }, [wanted, here]);
  return here;
}

type Drawn = ComponentType<ViewerProps>;

/** Each viewer's module once it is here, and the one load in flight for each: a page of ten diagrams asks once. */
const viewersHere = new Map<Viewer, Drawn>();
const viewersArriving = new Map<Viewer, Promise<Drawn>>();

/** The viewer's component once it is here; null until then, for a block with none, and when it did not load. */
function useViewer(viewer: Viewer | null): Drawn | null {
  const [here, setHere] = useState<{ viewer: Viewer; drawn: Drawn } | null>(() => {
    const drawn = viewer ? viewersHere.get(viewer) : undefined;
    return viewer && drawn ? { viewer, drawn } : null;
  });
  useEffect(() => {
    if (!viewer || here?.viewer === viewer) return;
    let mounted = true;
    let arriving = viewersArriving.get(viewer);
    if (!arriving) {
      arriving = viewer.load().then((module) => module.default);
      viewersArriving.set(viewer, arriving);
    }
    arriving.then(
      (drawn) => {
        viewersHere.set(viewer, drawn);
        if (mounted) setHere({ viewer, drawn });
      },
      // It did not load (an old tab after an update, a dropped connection): the block stays code, and the next one asks again.
      () => {
        viewersArriving.delete(viewer);
      },
    );
    return () => {
      mounted = false;
    };
  }, [viewer, here]);
  return here && here.viewer === viewer ? here.drawn : null;
}

/** A viewer that throws while drawing is a block that cannot be drawn: its code, not a broken page. */
class Fallible extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {
    this.props.onFail();
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const SWITCH = "btn btn-ghost btn-xs max-sm:btn-sm rounded-lg px-2 font-medium aria-pressed:bg-base-100 aria-pressed:text-base-content text-base-content/65";

export function CodeBlock({ lang, text, growing = false }: { lang?: string | undefined; text: string; /** Still being written: coloured once it is whole. */ growing?: boolean }) {
  const viewer = growing ? null : viewerFor(lang);
  const [failed, setFailed] = useState<string | null>(null);
  const [asCode, setAsCode] = useState(false);
  // A failure is of this text: a block whose text changes is tried again.
  const Drawn = useViewer(failed === text ? null : viewer);
  const drawing = Drawn !== null;
  const pictured = drawing && !asCode;
  const colourable = Boolean(lang) && !growing && !pictured && text.length <= COLOURED_UP_TO;
  const highlighter = useHighlighter(colourable);
  const coloured = useMemo<CodePiece[] | null>(() => (colourable && highlighter ? highlighter.pieces(lang ?? "", text) : null), [colourable, highlighter, lang, text]);
  return (
    <div className="rounded-xl border border-base-content/10 bg-base-200/60 overflow-hidden shadow-xs" data-viewer={pictured ? "picture" : "code"}>
      <div className="flex min-h-7 items-center justify-between gap-2 border-b border-base-content/10 bg-base-300/40 py-0.5 pl-3 pr-1">
        <span className="text-[11px] font-mono font-medium text-base-content/65 uppercase tracking-wider">{lang}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {drawing && viewer && (
            <span role="group" aria-label="Show as" className="flex items-center gap-0.5">
              <button type="button" className={SWITCH} aria-pressed={!asCode} onClick={() => setAsCode(false)}>
                {viewer.label}
              </button>
              <button type="button" className={SWITCH} aria-pressed={asCode} onClick={() => setAsCode(true)}>
                Code
              </button>
            </span>
          )}
          <CopyButton text={text} className="btn btn-ghost btn-xs max-sm:btn-sm shrink-0 gap-1 rounded-lg" />
        </span>
      </div>
      {pictured && Drawn ? (
        <div className="overflow-x-auto p-3.5">
          <Fallible key={text} onFail={() => setFailed(text)}>
            <Drawn text={text} onFail={() => setFailed(text)} />
          </Fallible>
        </div>
      ) : (
      <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-base-content/90">
        <code>
          {coloured
            ? coloured.map((piece, index) => {
                const tone = piece.scope ? TONE[piece.scope] : undefined;
                return tone ? (
                  <span key={index} className={tone}>
                    {piece.text}
                  </span>
                ) : (
                  piece.text
                );
              })
            : text}
        </code>
      </pre>
      )}
    </div>
  );
}
