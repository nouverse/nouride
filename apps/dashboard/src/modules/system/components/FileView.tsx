/**
 * One file, read: a page of markdown drawn as a page (with its source a press away), code in its colours with a
 * button that copies it, a picture as a picture, and anything else said as what it is. What was hidden in its words
 * and where they were cut short are said above them.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EyeOff, FileQuestion, Scissors } from "lucide-react";
import type { SystemFileEntry } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { CodeBlock } from "@/commons/components/ui/CodeBlock";
import { Markdown } from "@/commons/components/ui/Markdown";
import { TextLoading } from "@/commons/components/ui/Skeleton";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ago, formatBytes } from "@/commons/lib/format";
import { isMarkdown, languageOf } from "../lib/paths";

const NOTE = "flex items-start gap-2 rounded-xl bg-base-200/50 px-3 py-2 text-xs text-base-content/65";

export function FileView({ entry }: { entry: SystemFileEntry }) {
  const file = useQuery({ queryKey: ["system", "file", entry.path], queryFn: () => api.systemFile(entry.path), retry: false });
  const [source, setSource] = useState(false);
  const read = file.data;
  const page = isMarkdown(entry.name);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs text-base-content/65">
          {entry.sizeBytes === null ? null : formatBytes(entry.sizeBytes)}
          {entry.modifiedAt === null ? null : ` · changed ${ago(entry.modifiedAt)}`}
        </p>
        {read?.kind === "text" && page ? (
          <button type="button" className="btn btn-ghost btn-xs rounded-lg" aria-pressed={source} onClick={() => setSource((was) => !was)}>
            {source ? "Show as a page" : "Show its source"}
          </button>
        ) : null}
      </div>
      {file.error ? (
        <ErrorNote error={file.error} />
      ) : !read ? (
        <TextLoading lines={8} />
      ) : read.kind === "picture" ? (
        <img src={api.systemPicture(entry.path)} alt={entry.name} className="max-h-[70dvh] max-w-full rounded-xl border border-base-content/10 bg-base-200/40" />
      ) : read.kind === "other" ? (
        <EmptyState icon={FileQuestion} title="Not something to read here" description="This file is not text or a picture, so there is nothing of it to show." className="py-8" />
      ) : (
        <>
          {read.masked ? (
            <p className={NOTE}>
              <EyeOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Something in this file looked like a credential, and is hidden where it was.
            </p>
          ) : null}
          {read.truncated ? (
            <p className={NOTE}>
              <Scissors size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              This is the beginning of the file: it is longer than what is shown here.
            </p>
          ) : null}
          {page && !source ? (
            <div className="rounded-xl border border-base-content/10 bg-base-100 p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
              <Markdown source={read.text ?? ""} />
            </div>
          ) : (
            <CodeBlock lang={page ? "markdown" : languageOf(entry.name)} text={read.text ?? ""} />
          )}
        </>
      )}
    </div>
  );
}
