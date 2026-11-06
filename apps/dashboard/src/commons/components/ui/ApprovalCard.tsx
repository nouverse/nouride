/**
 * The prompt a human decides from, in a browser.
 * Styled with Apple HIG: clear visual hierarchy, soft translucent backgrounds,
 * distinct addition/deletion highlighting, and tactile buttons.
 */

import { Check, ShieldAlert, X } from "lucide-react";
import type { ApprovalDecision, ApprovalPreview, ApprovalRequest } from "@/commons/lib/api";
import { formatBytes } from "@/commons/lib/format";
import { DiffCounts, DiffView } from "@/commons/components/ui/DiffView";


function Preview({ preview, params }: { preview?: ApprovalPreview; params: Record<string, unknown> }) {
  if (!preview) {
    return (
      <pre className="bg-base-200/80 border border-base-content/10 max-h-40 overflow-auto rounded-xl p-3 font-mono text-xs text-base-content/85">
        {JSON.stringify(params, null, 2)}
      </pre>
    );
  }

  switch (preview.kind) {
    case "new_file":
      return (
        <div className="bg-base-200/70 border border-base-content/10 rounded-xl p-3 text-sm">
          <span className="font-mono font-semibold text-primary">{preview.path}</span>
          <span className="text-base-content/65">
            {" "}· new file · {preview.lines} lines, {formatBytes(preview.bytes)}
          </span>
        </div>
      );

    case "overwrite":
      return (
        <div className="bg-base-200/70 border border-warning/30 rounded-xl p-3 text-sm space-y-1">
          <div className="font-mono font-semibold text-base-content">{preview.path}</div>
          <div className="text-warning font-medium">
            replaces {preview.wasLines} lines ({formatBytes(preview.wasBytes)})
          </div>
          <div className="text-base-content/65">
            with {preview.lines} lines ({formatBytes(preview.bytes)})
          </div>
        </div>
      );

    case "edit":
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-mono font-semibold text-base-content">{preview.path}</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-base-300 text-base-content/80">
              <DiffCounts added={preview.added} removed={preview.removed} />
            </span>
          </div>
          {/* The same drawing as every diff here (`DiffView`): a persona's change too, whose one moved rule is the decision.
              Nothing folded: a kept line a persona change shows is what a reworded rule now covers, and is decided on. */}
          <DiffView rows={preview.hunk} context={Number.POSITIVE_INFINITY} className="max-h-48" />
          {preview.clipped && <div className="text-base-content/65 mt-1 text-xs italic">… clipped</div>}
        </div>
      );

    case "command":
      return (
        <div className="space-y-1.5">
          <div className="bg-base-200/90 border border-base-content/10 overflow-x-auto rounded-xl p-3 font-mono text-xs text-base-content/95 font-semibold">
            {preview.command}
          </div>
          {preview.shell && (
            <p className="text-[11px] font-medium text-warning flex items-center gap-1">
              <span>⚠️ Careful: this runs a whole script, not one command. Read all of it.</span>
            </p>
          )}
          {preview.cwd && <p className="text-base-content/65 font-mono text-xs">in {preview.cwd}</p>}
        </div>
      );

    case "params":
      return (
        <pre className="bg-base-200/80 border border-base-content/10 max-h-40 overflow-auto rounded-xl p-3 font-mono text-xs text-base-content/85">
          {preview.json}
          {preview.clipped && <span className="text-base-content/65 italic"> … clipped</span>}
        </pre>
      );
  }
}

export function ApprovalCard({
  request,
  onAnswer,
  pending,
}: {
  request: ApprovalRequest;
  onAnswer: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  pending: boolean;
}) {
  return (
    <div className="bg-warning/10 border border-warning/30 rounded-2xl p-4 sm:p-5 shadow-xs transition-all flex flex-col sm:flex-row items-start gap-3.5">
      <div className="bg-warning/20 text-warning border border-warning/30 p-2.5 rounded-xl shrink-0">
        <ShieldAlert size={20} />
      </div>
      <div className="min-w-0 flex-1 space-y-3 w-full">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-sm tracking-tight text-base-content">{request.tool}</span>
            <span className="badge badge-warning badge-sm font-medium font-mono">Needs Approval</span>
            {request.queued && <span className="badge badge-ghost badge-sm font-medium font-mono">Not in the chat yet</span>}
          </div>
          {request.reason && <p className="text-xs text-base-content/75 mt-1">{request.reason}</p>}
          {/* A chat is asked one question at a time, and every pending one is listed here: without this, the ones
              still waiting their turn there read as prompts lost on the way. */}
          {request.queued && (
            <p className="text-xs text-base-content/65 mt-1">Waiting behind another question in its chat, so it has not been asked there yet. You can answer it here.</p>
          )}
        </div>

        <Preview {...(request.preview ? { preview: request.preview } : {})} params={request.params} />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="btn btn-sm btn-success text-success-content gap-1.5 shadow-xs active:scale-[0.97] transition-all"
            onClick={() => onAnswer(request, "allow-once")}
            disabled={pending}
          >
            <Check size={14} /> Allow once
          </button>

          {request.grantable && (
            <button
              type="button"
              className="btn btn-sm btn-ghost bg-base-200/80 hover:bg-base-300 gap-1.5 active:scale-[0.97] transition-all"
              onClick={() => onAnswer(request, "allow-always")}
              disabled={pending}
            >
              Always allow
            </button>
          )}

          <button
            type="button"
            className="btn btn-sm btn-error text-error-content gap-1.5 shadow-xs active:scale-[0.97] transition-all"
            onClick={() => onAnswer(request, "deny")}
            disabled={pending}
          >
            <X size={14} /> Deny
          </button>
        </div>
      </div>
    </div>
  );
}
