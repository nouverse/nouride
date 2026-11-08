/**
 * Files in the conversation, in both directions.
 *
 * The rule is the one a person expects and no chat UI explains: **media plays or shows where it is,
 * everything else is something you open.** An image gets a thumbnail that grows into a popup, audio
 * and video get a player in place, and a file gets a row you click to open in a new tab — where the
 * browser renders it or downloads it according to what the daemon says it is (`INLINE_TYPES` in the
 * chat route decides, and deliberately refuses to render anything that can carry script).
 *
 * The rule used to say "an image is something you look at, everything else is something you open",
 * and both halves of the media case were bolted on afterwards — audio first, then video, which until
 * then rendered as a file row nobody recognised as a video. Rewritten rather than amended, because a
 * stated rule with two exceptions is not the rule anybody is following.
 *
 * A file with no `url` is one whose bytes were never saved, or were swept by retention. It still shows
 * — the fact that it *was* sent is part of the conversation — but it does not pretend to be openable.
 */

import { useEffect, useState } from "react";
import { Download, ExternalLink, ImageOff, Video, X } from "lucide-react";
import { api, type TurnAttachment } from "@/commons/lib/api";
import { fileIconFor } from "@/commons/components/ui/FileDrop";
import { isMarkdownFile, MarkdownPreview } from "@/commons/components/ui/MarkdownPreview";
import { formatBytes } from "@/commons/lib/format";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";

function isImage(file: TurnAttachment): boolean {
  return file.mimeType.startsWith("image/") || file.kind === "image";
}

/**
 * Audio, including a voice note.
 *
 * Both get a player rather than a download row, because the thing you do with a voice note is listen
 * to it — and a row that has to be opened in a new tab to be heard is a row nobody plays twice. The
 * daemon serves these inline for the same reason.
 */
function isAudio(file: TurnAttachment): boolean {
  return file.mimeType.startsWith("audio/") || file.kind === "audio" || file.kind === "voice";
}

/**
 * Video.
 *
 * `kind` as well as the MIME type, and it matters more here than for the others: a clip that arrives
 * from a chat platform can carry `application/octet-stream` when the platform did not sniff it, and
 * an agent-produced screen capture is exactly the file most worth showing.
 */
function isVideo(file: TurnAttachment): boolean {
  return file.mimeType.startsWith("video/") || file.kind === "video";
}

/**
 * The popup.
 *
 * Escape closes it, the backdrop closes it, and the image is capped to the viewport — a 4000px
 * screenshot that opens larger than the window is a screenshot you cannot see. The full-size copy is
 * one click further on, in a new tab.
 */
function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return overPage(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm p-4 animate-fade"
      role="dialog"
      aria-label={name}
    >
      {/* The backdrop is the close button, which is what everybody tries first. */}
      <button type="button" className="absolute inset-0 cursor-zoom-out" onClick={onClose} aria-label="Close" />

      <div className="relative z-10 max-w-[92vw] max-h-[88vh] flex flex-col items-center gap-2 animate-enter">
        <img
          src={src}
          alt={name}
          className="max-w-full max-h-[80vh] rounded-xl shadow-2xl object-contain bg-base-100"
        />
        <div className="flex items-center gap-2 text-[11px] text-white/80 font-mono">
          <span className="truncate max-w-[60vw]">{name}</span>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-white"
          >
            <ExternalLink size={12} /> open
          </a>
          <a href={src} download={name} className="inline-flex items-center gap-1 hover:text-white">
            <Download size={12} /> save
          </a>
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 btn btn-sm btn-circle bg-base-100/90 border-0"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function ImageTile({ src, file, onOpen }: { src: string; file: TurnAttachment; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-2 py-1.5 rounded-xl border border-base-content/[0.12] bg-base-100/80 text-[11px] text-base-content/70"
        title={`${file.name}: could not be displayed`}
      >
        <ImageOff size={13} className="text-base-content/40" />
        <span className="truncate max-w-[160px]">{file.name}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative rounded-xl overflow-hidden border border-base-content/[0.12] bg-base-200/50 hover:border-primary/40 transition-colors"
      title={`${file.name}${file.bytes === undefined ? "" : ` · ${formatBytes(file.bytes)}`}`}
    >
      <img
        src={src}
        alt={file.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className="max-h-48 max-w-[260px] object-cover block cursor-zoom-in"
      />
      <span className="absolute inset-x-0 bottom-0 px-2 py-1 bg-black/55 text-white text-[10px] font-mono truncate opacity-0 group-hover:opacity-100 transition-opacity">
        {file.name}
      </span>
    </button>
  );
}

function AudioRow({ src, file }: { src: string; file: TurnAttachment }) {
  const Icon = fileIconFor(file.mimeType);
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-xl border border-base-content/[0.12] bg-base-100/80 max-w-[300px]">
      <span className="flex items-center gap-1.5 text-[10px] font-mono text-base-content/65">
        <Icon size={11} className="shrink-0 text-base-content/40" />
        <span className="truncate">{file.name}</span>
        {file.kind === "voice" && <span className="text-primary/70 shrink-0">voice note</span>}
      </span>
      {/* `preload="metadata"` so the duration shows without pulling the whole file for every message
          in a long transcript. */}
      <audio src={src} controls preload="metadata" className="w-full h-8" />
    </div>
  );
}

function VideoTile({ src, file }: { src: string; file: TurnAttachment }) {
  const [broken, setBroken] = useState(false);

  // A codec the browser does not have is the one failure a player cannot show for itself: the element
  // just sits there black. Falling back to the row at least says what the file is and opens it.
  if (broken) return <FileRow src={src} file={file} />;

  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-xl border border-base-content/[0.12] bg-base-100/80 max-w-[320px]">
      <span className="flex items-center gap-1.5 text-[10px] font-mono text-base-content/65">
        <Video size={11} className="shrink-0 text-base-content/40" />
        <span className="truncate">{file.name}</span>
        {file.bytes !== undefined && (
          <span className="shrink-0 text-base-content/65">{formatBytes(file.bytes)}</span>
        )}
      </span>
      {/* `preload="metadata"` so the poster frame and duration appear without pulling the whole clip
          for every message in a long transcript — the daemon answers range requests, so this is one
          small read rather than the file. */}
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        onError={() => setBroken(true)}
        className="w-full max-h-64 rounded-lg bg-black"
      />
    </div>
  );
}

/** `onRead`: a file read in place — markdown, shown rendered — rather than opened in a new tab. */
function FileRow({ src, file, onRead }: { src: string | null; file: TurnAttachment; onRead?: () => void }) {
  const Icon = fileIconFor(file.mimeType);
  const body = (
    <>
      <span className="size-8 rounded-lg bg-base-200/70 grid place-items-center shrink-0">
        <Icon size={14} className="text-base-content/50" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block text-[10px] text-base-content/65 font-mono">
          {file.bytes === undefined ? file.mimeType : formatBytes(file.bytes)}
          {src ? "" : " · no longer on disk"}
        </span>
      </span>
      {src && <ExternalLink size={12} className="shrink-0 text-base-content/35" />}
    </>
  );

  const className =
    "flex items-center gap-2 pl-1.5 pr-2 py-1.5 rounded-xl border border-base-content/[0.12] bg-base-100/80 text-[11px] max-w-[260px] text-base-content/80";

  if (src && onRead) {
    return (
      <button type="button" onClick={onRead} className={`${className} text-left hover:border-primary/40 transition-colors`} title={`Read ${file.name}`}>
        {body}
      </button>
    );
  }

  // A file with nothing behind it is not a link. A dead link that looks live is worse than a label.
  return src ? (
    <a href={src} target="_blank" rel="noopener noreferrer" className={`${className} hover:border-primary/40 transition-colors`}>
      {body}
    </a>
  ) : (
    <span className={`${className} text-base-content/65`}>{body}</span>
  );
}

export function AttachmentList({
  sessionId,
  files,
  align = "start",
}: {
  sessionId: string;
  files: TurnAttachment[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState<{ src: string; name: string } | null>(null);
  /** A markdown file read in place (0.8.11) — a mission's `report.md` above all — not a download. */
  const [reading, setReading] = useState<{ src: string; name: string } | null>(null);

  if (files.length === 0) return null;

  return (
    <>
      <div
        className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : "justify-start"} max-w-[85%] sm:max-w-[75%]`}
      >
        {files.map((file, index) => {
          const src = api.attachmentUrl(sessionId, file);
          if (isImage(file) && src) {
            return (
              <ImageTile
                key={`${file.name}-${index}`}
                src={src}
                file={file}
                onOpen={() => setOpen({ src, name: file.name })}
              />
            );
          }
          if (isAudio(file) && src) {
            return <AudioRow key={`${file.name}-${index}`} src={src} file={file} />;
          }
          if (isVideo(file) && src) {
            return <VideoTile key={`${file.name}-${index}`} src={src} file={file} />;
          }
          if (isMarkdownFile(file.name, file.mimeType) && src) {
            return <FileRow key={`${file.name}-${index}`} src={src} file={file} onRead={() => setReading({ src, name: file.name })} />;
          }
          return <FileRow key={`${file.name}-${index}`} src={src} file={file} />;
        })}
      </div>

      <Leaving value={open}>{(image) => <Lightbox src={image.src} name={image.name} onClose={() => setOpen(null)} />}</Leaving>
      <Leaving value={reading}>{(file) => <MarkdownPreview name={file.name} url={file.src} onClose={() => setReading(null)} />}</Leaving>
    </>
  );
}
