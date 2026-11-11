/**
 * A markdown file opened to read, in a dialog (0.8.11): a mission's `report.md` on its page, and a `.md` file in a
 * chat. The report was folded into the page and a `.md` file was a download; now `report.md` opens in
 * the dashboard as a preview. Rendered by `Markdown`, which writes no HTML of its own: a file is shown, never run.
 * **Save as PDF** prints the rendered file alone, black on white, where the browser's print dialog saves it as a PDF —
 * text a reader can select, and no PDF library in the dashboard.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileDown, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { overPage } from "./OverPage";
import { TextLoading } from "@/commons/components/ui/Skeleton";

/** Whether a file is markdown, by its type or its name — a platform's file often comes as `application/octet-stream`. */
export function isMarkdownFile(name: string, mimeType = ""): boolean {
  return mimeType.split(";")[0]!.trim().toLowerCase() === "text/markdown" || /\.(md|markdown)$/i.test(name.trim());
}

/** The most a preview shows, in characters; a longer file is saved and read elsewhere. */
export const PREVIEW_CHARS = 2_000_000;

/** What the dialog shows for a file it read: its text, or why not. */
export function previewOf(body: string): { text: string } | { failure: string } {
  return body.length > PREVIEW_CHARS ? { failure: "it is too long to show here; save it to read it" } : { text: body };
}

/** How the printed page looks: a document's, whatever the dashboard's theme. */
const PRINT_CSS = [
  "@page { margin: 18mm; }",
  "body { font: 11pt/1.55 -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #111; background: #fff; margin: 0; }",
  "h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; break-after: avoid; }",
  "h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }",
  "p, ul, ol, blockquote, pre, table { margin: 0 0 0.8em; }",
  "code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5pt; background: #f3f4f6; border-radius: 4px; }",
  "code { padding: 0.1em 0.3em; } pre { padding: 0.7em; white-space: pre-wrap; overflow-wrap: anywhere; }",
  "table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }",
  "blockquote { border-left: 3px solid #ccc; padding-left: 0.8em; color: #444; }",
  "a { color: #0645ad; text-decoration: none; } svg { display: none; }",
  "tr, li, pre { break-inside: avoid; }",
].join("\n");

/**
 * The page the browser prints for **Save as PDF**: the rendered file's markup alone, under the file's name — which the
 * print dialog offers as the PDF's — and a document's look.
 */
export function printPage(name: string, body: string): string {
  const escape: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const title = name.replace(/\.(md|markdown)$/i, "").replace(/[&<>"]/g, (one) => escape[one]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

/** Print the rendered file in a frame of its own, so nothing of the dashboard is on the page; the frame goes after. */
function printAsPdf(name: string, rendered: HTMLElement): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("data-print", name);
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  frame.addEventListener(
    "load",
    () => {
      const view = frame.contentWindow;
      if (!view) return void frame.remove();
      view.addEventListener("afterprint", () => frame.remove());
      view.focus();
      view.print();
      // Where `afterprint` never comes — some phones — the frame still goes.
      setTimeout(() => frame.remove(), 60_000);
    },
    { once: true },
  );
  frame.srcdoc = printPage(name, rendered.innerHTML);
  document.body.appendChild(frame);
}

/**
 * `source`: the text, where the page has it (a mission's report). `url`: where the file is, read when the dialog opens —
 * the chat's attachment route, which serves it as a download, which a fetch reads all the same.
 */
export function MarkdownPreview({ name, source, url, onClose }: { name: string; source?: string; url?: string; onClose: () => void }) {
  const [read, setRead] = useState<{ text: string } | { failure: string } | null>(source === undefined ? null : { text: source });
  const rendered = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (source !== undefined || !url) return;
    let gone = false;
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Nouride could not open it (error ${response.status})`);
        const body = await response.text();
        if (!gone) setRead(previewOf(body));
      } catch (err) {
        if (!gone) setRead({ failure: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      gone = true;
    };
  }, [source, url]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Save: the file where it is, or the page's text as a file of that name.
  const href = useMemo(() => url ?? (source === undefined ? undefined : URL.createObjectURL(new Blob([source], { type: "text/markdown" }))), [url, source]);
  useEffect(
    () => () => {
      if (!url && href) URL.revokeObjectURL(href);
    },
    [href, url],
  );

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={name}>
      <div className="modal-box flex max-h-[90dvh] max-w-3xl flex-col gap-3 rounded-2xl">
        <div className="flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate font-mono text-sm font-semibold">{name}</h3>
          <div className="flex shrink-0 items-center gap-1">
            {read !== null && "text" in read && read.text.trim() ? (
              // Icons alone on a phone, the words from `sm`: with them, the file's name was cut to "report…".
              <button type="button" className="btn btn-ghost btn-sm gap-1 rounded-xl" aria-label="Save as PDF" title="Print it alone; the print dialog saves it as a PDF" onClick={() => rendered.current && printAsPdf(name, rendered.current)}>
                <FileDown size={14} aria-hidden="true" /> <span className="hidden sm:inline">Save as PDF</span>
              </button>
            ) : null}
            {href ? (
              <a href={href} download={name} className="btn btn-ghost btn-sm gap-1 rounded-xl" aria-label="Save" title={`Save ${name}`}>
                <Download size={14} aria-hidden="true" /> <span className="hidden sm:inline">Save</span>
              </a>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        {read === null ? (
          <TextLoading lines={10} className="py-3" />
        ) : "failure" in read ? (
          <p className="text-error text-sm">Could not show {name}: {read.failure}.</p>
        ) : (
          <div className="bg-base-200/40 min-h-40 overflow-auto overscroll-contain rounded-xl p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
            {read.text.trim() ? (
              <div ref={rendered}>
                <Markdown source={read.text} />
              </div>
            ) : (
              <p className="text-base-content/65">It is empty.</p>
            )}
          </div>
        )}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}
