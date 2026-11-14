/**
 * One file, shown as what it is: a page of markdown drawn as a page (with its source a press away), code in its
 * colours with a button that copies it, a picture drawn, a video and a sound played where they stand, a PDF opened by
 * the browser's own reader in a tab of its own, and anything else said as what it is with a button in its middle that
 * downloads it. Above it, what the file is and what can be done with it: a copy to keep, and, for what agents and
 * chats left behind, a delete. What was hidden in its words and where they were cut short are said there too.
 *
 * From a laptop's width up the file scrolls inside the card, under its own bar, which stays; on a phone the page
 * scrolls as a document.
 */

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, ExternalLink, EyeOff, FileQuestion, FileText, Scissors, Trash2 } from "lucide-react";
import type { SystemFileEntry } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { CodeBlock } from "@/commons/components/ui/CodeBlock";
import { Markdown } from "@/commons/components/ui/Markdown";
import { ScrollArea } from "@/commons/components/ui/ScrollCard";
import { TextLoading } from "@/commons/components/ui/Skeleton";
import { Spinner } from "@/commons/components/ui/Spinner";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ago, formatBytes } from "@/commons/lib/format";
import { isMarkdown, languageOf } from "../lib/paths";
import type { FileActions } from "../lib/use-file-actions";

const NOTE = "flex items-start gap-2 rounded-xl bg-base-200/50 px-3 py-2 text-xs text-base-content/65";
const ACTION = "btn btn-ghost btn-sm gap-1.5 rounded-lg";

export function FileView({ entry, actions, onBack }: { entry: SystemFileEntry; actions: FileActions; onBack: () => void }) {
  const file = useQuery({ queryKey: ["system", "file", entry.path], queryFn: () => api.systemFile(entry.path), retry: false });
  const [source, setSource] = useState(false);
  /** A video in a form this browser cannot play: the player sits there black, so the file is offered to keep. */
  const [unplayable, setUnplayable] = useState(false);
  const read = file.data;
  const page = isMarkdown(entry.name);
  const media = api.systemMedia(entry.path);
  // A copy is the bytes as they are, which would undo what was hidden in its words.
  const keepable = read !== undefined && !(read.kind === "text" && read.masked);
  const downloading = actions.busy?.path === entry.path && actions.busy.doing === "download";
  const deleting = actions.busy?.path === entry.path && actions.busy.doing === "delete";

  const download = (primary: boolean) => (
    <button type="button" className={primary ? "btn btn-primary btn-sm gap-1.5 rounded-lg" : ACTION} disabled={actions.busy !== null} onClick={() => void actions.download(entry)}>
      {downloading ? <Spinner /> : <Download size={14} aria-hidden="true" />} Download
    </button>
  );
  /** What a page cannot show, with the way to it in the middle. */
  const offered = (icon: typeof FileQuestion, title: string, description: string, more?: ReactNode) => (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      className="py-8"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {more}
          {download(more === undefined)}
        </div>
      }
    />
  );

  return (
    <>
      <div className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" className={`${ACTION} -ml-2`} onClick={onBack}>
              <ArrowLeft size={14} aria-hidden="true" /> Back to its folder
            </button>
            <p className="text-xs text-base-content/65">
              {entry.sizeBytes === null ? null : formatBytes(entry.sizeBytes)}
              {entry.modifiedAt === null ? null : ` · changed ${ago(entry.modifiedAt)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {read?.kind === "text" && page ? (
              <button type="button" className={ACTION} aria-pressed={source} onClick={() => setSource((was) => !was)}>
                {source ? "Show as a page" : "Show its source"}
              </button>
            ) : null}
            {keepable ? download(false) : null}
            {entry.removable ? (
              <button type="button" className={`${ACTION} text-error hover:bg-error/10`} disabled={actions.busy !== null} onClick={() => void actions.remove(entry)}>
                {deleting ? <Spinner /> : <Trash2 size={14} aria-hidden="true" />} Delete
              </button>
            ) : null}
          </div>
        </div>
        {actions.failed?.path === entry.path ? <ErrorNote error={actions.failed.error} /> : null}
        {read?.kind === "text" && read.masked ? (
          <p className={NOTE}>
            <EyeOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            Something in this file looked like a credential, and is hidden where it was. A file like this is read here, and not downloaded.
          </p>
        ) : null}
        {read?.kind === "text" && read.truncated ? (
          <p className={NOTE}>
            <Scissors size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            This is the beginning of the file: it is longer than what is shown here.
          </p>
        ) : null}
      </div>
      <ScrollArea fill className="lg:-mr-6 lg:pr-6">
        {file.error ? (
          <ErrorNote error={file.error} />
        ) : !read ? (
          <TextLoading lines={8} />
        ) : read.kind === "picture" ? (
          <img src={media} alt={entry.name} className="max-h-[70dvh] max-w-full rounded-xl border border-base-content/10 bg-base-200/40 lg:max-h-full" />
        ) : read.kind === "video" && !unplayable ? (
          // `preload="metadata"`: its first frame and its length without the whole clip, which the daemon answers in ranges.
          <video src={media} controls playsInline preload="metadata" onError={() => setUnplayable(true)} className="max-h-[70dvh] max-w-full rounded-xl bg-black lg:max-h-full" />
        ) : read.kind === "video" ? (
          offered(FileQuestion, "This browser cannot play it", "The video is in a form this browser does not play. Download it to watch it with something that does.")
        ) : read.kind === "audio" ? (
          <audio src={media} controls preload="metadata" className="w-full max-w-xl" />
        ) : read.kind === "pdf" ? (
          offered(
            FileText,
            "A PDF",
            "It opens in a tab of its own, in the browser's reader.",
            <a href={media} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm gap-1.5 rounded-lg">
              <ExternalLink size={14} aria-hidden="true" /> Open it
            </a>,
          )
        ) : read.kind === "other" ? (
          offered(FileQuestion, "Not something to show here", "This file is not text, a picture, a video or a sound. Download it to open it with something that can.")
        ) : page && !source ? (
          <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
            <Markdown source={read.text ?? ""} />
          </div>
        ) : (
          <CodeBlock lang={page ? "markdown" : languageOf(entry.name)} text={read.text ?? ""} />
        )}
      </ScrollArea>
    </>
  );
}
