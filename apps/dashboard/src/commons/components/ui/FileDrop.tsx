/**
 * Picking files, dropping files, and showing what is attached.
 *
 * Three pieces, kept apart because they are reused separately: the drop target is a hook (any panel
 * can become one without inheriting a layout), the picker is a button, and the tray is a list. Nothing
 * here uploads or knows what an attachment means to the daemon — a caller owns that, so the same
 * component can serve the chat composer, a skill upload, or a persona avatar.
 *
 * The details that are easy to get wrong and are handled here:
 *
 * - **Drag flicker.** `dragenter`/`dragleave` fire for every child element the pointer crosses, so a
 *   naive boolean flashes the overlay on and off while the cursor moves inside the drop zone. Counted
 *   instead.
 * - **The same file twice.** A file input keeps its value, so picking `shot.png`, removing it, and
 *   picking it again fires no `change` event at all. The value is cleared after every pick.
 * - **Directories and empty drops.** A folder drop arrives as an entry with no size and no type;
 *   passing it on produces a request that fails for reasons nobody can act on.
 */

import { useCallback, useRef, useState } from "react";
import { AlertCircle, File as FileIcon, FileText, ImageIcon, Loader2, Music, Paperclip, Video, X } from "lucide-react";
import { formatBytes } from "@/commons/lib/format";

export function fileIconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.startsWith("video/")) return Video;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.startsWith("text/") || mimeType.includes("pdf") || mimeType.includes("word")) {
    return FileText;
  }
  return FileIcon;
}

/**
 * Make any element a drop target.
 *
 * Returns the handlers to spread and whether something is currently over it. A folder — which the
 * browser reports as a zero-length entry with no type — is dropped on the floor here rather than
 * turned into a request that cannot succeed.
 */
export function useFileDrop(options: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  /** Counted, not toggled — see the note at the top of the file. */
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };

  const handlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (options.disabled) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (options.disabled) return;
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDragOver: (event: React.DragEvent) => {
      if (options.disabled) return;
      // Without this the browser navigates to the file instead of letting the page have it.
      event.preventDefault();
    },
    onDrop: (event: React.DragEvent) => {
      if (options.disabled) return;
      event.preventDefault();
      reset();
      const files = [...event.dataTransfer.files].filter((file) => file.size > 0 || file.type);
      if (files.length > 0) options.onFiles(files);
    },
  };

  return { dragging, handlers };
}

/** The paperclip. A label around a hidden input, which is the only way to style one. */
export function AttachButton({
  onFiles,
  disabled,
  accept,
  title = "Attach files",
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  accept?: string;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.target.files ?? [])];
      // Cleared so picking the same file again still fires a change event.
      event.target.value = "";
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        {...(accept ? { accept } : {})}
        onChange={pick}
      />
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="btn btn-ghost btn-sm btn-circle shrink-0 text-base-content/65 hover:text-base-content disabled:opacity-30 mb-1"
      >
        <Paperclip size={16} />
      </button>
    </>
  );
}

/** One attached file, from the caller's point of view. */
export interface AttachedFile {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** An object URL, for images. The caller owns it — and owns revoking it. */
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
}

/** What is attached, with a way to take it back. */
export function AttachmentTray({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove?: (id: string) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-1">
      {files.map((file) => {
        const Icon = fileIconFor(file.mimeType);
        return (
          <div
            key={file.id}
            className={`group relative flex items-center gap-2 pl-1.5 pr-2 py-1.5 rounded-xl border text-[11px] max-w-[240px] ${
              file.status === "error"
                ? "border-error/40 bg-error/5 text-error"
                : "border-base-content/[0.12] bg-base-100/80 text-base-content/80"
            }`}
            title={file.error ?? `${file.name} · ${formatBytes(file.bytes)}`}
          >
            <span className="size-8 rounded-lg bg-base-200/70 grid place-items-center shrink-0 overflow-hidden">
              {file.previewUrl ? (
                <img src={file.previewUrl} alt="" className="size-full object-cover" />
              ) : file.status === "error" ? (
                <AlertCircle size={14} />
              ) : (
                <Icon size={14} className="text-base-content/50" />
              )}
            </span>

            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{file.name}</span>
              <span className="block text-[10px] text-base-content/65 font-mono">
                {file.status === "uploading" ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 size={9} className="animate-spin" /> uploading
                  </span>
                ) : file.status === "error" ? (
                  (file.error ?? "failed")
                ) : (
                  formatBytes(file.bytes)
                )}
              </span>
            </span>

            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemove(file.id)}
                className="shrink-0 text-base-content/65 hover:text-error transition-colors"
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The overlay a drop target shows while something is over it. */
export function DropOverlay({ label = "Drop files to attach" }: { label?: string }) {
  return (
    <div className="absolute inset-0 z-40 grid place-items-center rounded-3xl border-2 border-dashed border-primary/60 bg-primary/5 backdrop-blur-[2px] pointer-events-none">
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-base-100/90 border border-primary/30 text-xs font-semibold text-primary shadow-sm">
        <Paperclip size={14} />
        {label}
      </span>
    </div>
  );
}
