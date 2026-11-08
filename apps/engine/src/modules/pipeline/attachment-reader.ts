/**
 * The closures `attachment_read` is built from, each scoped to the conversation the calling turn is in.
 *
 * Closures rather than the index and the store, per the rule `boot/tools.ts` is built on: a tool
 * holding the index could list any conversation's files, and one holding the attachment store could
 * open any of them. Lifted out of the pipeline's composition root when video made it grow — this is
 * what the tool can reach, and it reads better as one list than as a method on the thing that owns
 * everything.
 */

import { agentCommandsHaveOwnUsers } from "@nouride/runtime";
import { createLogger, imageMode, type ToolContext } from "@nouride/shared";
import type { ChatAttachment } from "@/modules/attachments/chat-attachments.store.ts";
import { readImage as askVisionModel } from "@/modules/attachments/vision.ts";
import type { AttachmentReadOptions, OpenedAttachment } from "@/modules/tools/builtins/attachment.ts";
import type { SessionStatus } from "@/modules/tools/registry.ts";
import type { AttachmentIntake } from "./attachments.ts";
import type { PipelineDeps } from "./deps.ts";

/** A frame's or a video sound's ref names the video it came from: `<ref>.f2`, `<ref>.sound`. */
const DERIVED = /^(.+)\.(f\d+|sound)$/;

const log = createLogger("pipeline.attachments");

/**
 * The calling agent's own copy of a file another agent stored, where each agent is its own user and cannot open the
 * other's folder (#12) — as a message's files get theirs (`AttachmentIntake.durableCopy`). The path an opened file comes
 * back with is one the agent's own tools are handed: a coding CLI's (0.8.11, `ToolContext.lent`), and `exec` for a file
 * the tool cannot read itself. One that cannot be copied stays where it is, said in the log.
 */
function ownCopy(deps: Pick<PipelineDeps, "attachments">, ctx: ToolContext, ref: string, path: string): string {
  const store = deps.attachments;
  if (!store || !agentCommandsHaveOwnUsers() || store.holds(ctx.agentId, path)) return path;
  try {
    return store.copyFor({ agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId }, ref, path);
  } catch (err) {
    log.warn("another agent's file could not be copied for this one", { agent_id: ctx.agentId, ref, error: String(err) });
    return path;
  }
}

export function attachmentReadOptions(params: {
  deps: Pick<PipelineDeps, "attachments" | "config" | "registry" | "providers" | "usage">;
  index: NonNullable<PipelineDeps["attachmentIndex"]>;
  intake: AttachmentIntake;
  open: (ctx: ToolContext, file: ChatAttachment) => Promise<OpenedAttachment>;
  status: (ctx: ToolContext) => SessionStatus;
}): AttachmentReadOptions {
  const { deps, index, intake } = params;
  // The calling turn's conversation, its connection included: a DM's chat id is the person's on some platforms, and
  // another of our bots in a DM with them is another conversation under the same id (#12).
  const scope = (ctx: ToolContext) => ({ gateway: ctx.gateway, gatewayId: ctx.gatewayId, chatId: ctx.chatId, chatType: ctx.chatType });
  // The model this conversation runs on now, override included — the one that would hear it. An
  // unknown agent comes back as provider "unknown", which no profile answers to: it cannot hear.
  const target = (ctx: ToolContext) => {
    const status = params.status(ctx);
    return { agentId: ctx.agentId, profile: status.provider, model: status.model };
  };

  return {
    // A derived ref opens the video it was taken from — the notice lists frames by their own refs,
    // and a model asking for one is asking to look at that video again.
    find: (ctx, ref) => index.find(ref, scope(ctx)) ?? (DERIVED.test(ref) ? index.find(ref.replace(DERIVED, "$1"), scope(ctx)) : null),
    list: (ctx, limit) => index.recent(scope(ctx), limit),
    conversationStartedAt: (ctx) => params.status(ctx).startedAt ?? 0,
    open: async (ctx, file) => {
      const opened = await params.open(ctx, file);
      return "error" in opened || !opened.path ? opened : { ...opened, path: ownCopy(deps, ctx, file.ref, opened.path) };
    },
    describe: (ctx, input) => askVisionModel(deps, { agentId: ctx.agentId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}), ...input }),
    // Read at call time, not captured: `[media]` is reloadable.
    imageMode: () => imageMode(deps.config.media),
    maxImageBytes: () => deps.config.media.maxImageBytes,
    listen: (ctx, file) => intake.listen(target(ctx), file),
    watch: (ctx, file) =>
      intake.watch(target(ctx), {
        localPath: file.localPath,
        ref: file.ref,
        recordedBySender: file.handle?.recordedBySender === true,
      }),
  };
}
