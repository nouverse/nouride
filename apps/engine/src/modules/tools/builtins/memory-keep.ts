/**
 * `memory_write` about=knowledge: a document someone hands an agent to keep, into the knowledge base (KNOWLEDGE_BASE §9,
 * 0.8.20), with the English title search finds it by (0.8.23). Its own file since the title: the memory tools' file was
 * past its size, and keeping a document is the one part of `memory_write` that reads files and talks to collections.
 */

import { basename, readFileBytes, resolveWithin, statFile } from "@nouride/runtime";
import type { ToolContext, ToolResult } from "@nouride/shared";
import { sentName, storedName } from "@/modules/attachments/store.ts";
import { memoryTextIsEnglish, TITLE_MAX, type Memory, type Speaker } from "@/modules/memory/index.ts";
import type { AttachmentReadOptions } from "@/modules/tools/builtins/attachment.ts";

/** A file the agent may hand over: one under the roots this turn may read, a chat's attachments among them. */
function fileWithin(ctx: ToolContext, asked: string): string | null {
  const roots = [ctx.workspaceDir, ...ctx.workspaceRoots, ...(ctx.privateDir ? [ctx.privateDir] : []), ...(ctx.readOnlyRoots ?? [])];
  for (const root of roots) {
    try {
      const path = resolveWithin(root, asked);
      if (statFile(path) && !statFile(path)!.isDirectory) return path;
    } catch {
      // Not under this root: the next one may hold it.
    }
  }
  return null;
}

/**
 * The name a file of this chat was sent under, not the one it is stored by. Storing makes a name safe for a path and
 * puts a prefix in front: a file sent on Telegram with a space in its name was kept with an underscore for it (0.8.20's
 * check on the box). The conversation's list of files has the name as it was sent; a file not in it keeps its own.
 */
function nameAsSent(path: string, ctx: ToolContext, files?: Pick<AttachmentReadOptions, "list">): string {
  const stored = storedName(basename(path));
  const listed = files?.list(ctx, 200).find((file) => file.localPath !== undefined && basename(file.localPath) === stored);
  return listed?.name ?? sentName(basename(path));
}

/** What an agent is told when a kept document's title is missing or not English. */
const KEEP_TITLE =
  "Give the document a `title` in English: what it is, with its own terms as they are, e.g. \"NIB, business registration certificate (Nomor Induk Berusaha)\". Search finds it by those words in any language.";

/**
 * `memory_write` about=knowledge (KNOWLEDGE_BASE §9, 0.8.20): a document someone handed over to keep, into a collection.
 * A new collection is for the people in this chat; one wider than them waits for an admin's yes, which the agent says.
 */
export async function keepDocument(knowledge: Pick<Memory["knowledge"], "keep">, args: Record<string, unknown>, ctx: ToolContext, speaker: Speaker, files?: Pick<AttachmentReadOptions, "list">): Promise<ToolResult> {
  const collection = typeof args.collection === "string" ? args.collection.trim() : "";
  if (!collection) return { content: "`collection` must name where to keep it: an existing collection, or a new name.", isError: true };
  const text = typeof args.content === "string" ? args.content : "";
  const asked = typeof args.file === "string" ? args.file.trim() : "";
  if (!text.trim() && !asked) return { content: "Give the document as `content`, or a `file` to keep.", isError: true };
  // The title is what search finds a document by: in English, an English search finds one written in any language,
  // with search by meaning or without it (0.8.23). Checked as memory's English is.
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { content: KEEP_TITLE, isError: true };
  if (title.length > TITLE_MAX) return { content: `\`title\` is at most ${TITLE_MAX} characters: what the document is, not a summary of it.`, isError: true };
  if (!memoryTextIsEnglish(title)) return { content: `${KEEP_TITLE} This one is not in English.`, isError: true };
  let file: { name: string; bytes: Uint8Array } | undefined;
  if (asked) {
    const path = fileWithin(ctx, asked);
    if (!path) return { content: `No file "${asked}" that you may read here: an attachment of this chat, or one in your workspace.`, isError: true };
    file = { name: nameAsSent(path, ctx, files), bytes: await readFileBytes(path) };
  }
  const result = await knowledge.keep(speaker, {
    collection,
    title,
    ...(text.trim() ? { text } : {}),
    ...(file ? { file } : {}),
    ...(typeof args.source === "string" && args.source.trim() ? { source: args.source.trim() } : {}),
    ...(ctx.senderName?.trim() ? { name: ctx.senderName.trim() } : {}),
    where: `in a ${ctx.chatType === "dm" ? "one-to-one" : "group"} chat with ${ctx.agentId}`,
    day: new Date().toISOString().slice(0, 10),
  });
  if ("refused" in result) return { content: result.refused, isError: true };
  if ("waiting" in result) {
    return {
      content: `"${result.waiting.collection}" is open to more people than this chat, so the document waits for an admin's yes on the dashboard before it joins it. Tell them so.`,
      isError: false,
      metadata: { about: "knowledge", waiting: true },
    };
  }
  const { saved } = result;
  const made = result.made ? ", a collection made now for the people in this chat" : "";
  const read = saved.archived
    ? "The collection is archived, so it is kept but not searched until someone brings it back."
    : saved.status === "indexed"
      ? "It can be searched now."
      : `It is kept but not searched: ${saved.reason ?? "it could not be read"}`;
  return { content: `Kept in "${saved.collection}" as ${saved.path}${made}. ${read}`, isError: false, metadata: { about: "knowledge" } };
}
