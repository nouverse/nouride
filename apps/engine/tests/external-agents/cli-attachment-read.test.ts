/**
 * `attachment_read` lent to a coding CLI (0.8.11, RFC Part C §C.7): the conversation's earlier files — one from before
 * its session, after `/new`, or a document sent to another agent in the room — which a CLI could not reach. Its reply
 * over MCP carries text alone, so the picture a model's call gets in `media` was dropped: a lent call gets the file's
 * path instead, as a message's files go to a CLI, and the path is the agent's own copy where each agent is its own
 * user — a file another agent stored is one its commands cannot open. Over the reader's own closures
 * (`attachmentReadOptions`) and a real attachment store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileBytes, runAgentCommandsThrough } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import type { ChatAttachment } from "@/modules/attachments/chat-attachments.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { attachmentReadOptions } from "@/modules/pipeline/attachment-reader.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { createAttachmentReadTool, type OpenedAttachment } from "@/modules/tools/builtins/attachment.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nouride-cli-files-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // A picture Nox's bot stored in the room, in Nox's own folder.
  const theirs = join(root, "nox", "room", "2026-10-31", "chart.png");
  mkdirSync(join(theirs, ".."), { recursive: true });
  writeFileSync(theirs, "png bytes");
  const picture: ChatAttachment = { ref: "fchart01", gateway: "discord", gatewayId: "discord:nox", chatId: "room-1", name: "chart.png", mimeType: "image/png", kind: "image", size: 9, fromAgent: "nox", at: 1_793_400_000_000, localPath: theirs };
  const store = new AttachmentStore({ rootDir: root, maxBytes: 1_000_000, now: () => new Date("2026-10-31T10:00:00Z") });
  const deps = { config: { media: { imageModel: "", readImages: true, maxImageBytes: 8_388_608 } }, attachments: store } as unknown as PipelineDeps;
  // The index, scoped as the real one is: this room's files, and nothing of another chat's.
  const index = { find: (ref: string, scope: { chatId: string }) => (ref === picture.ref && scope.chatId === "room-1" ? picture : null), recent: (scope: { chatId: string }) => (scope.chatId === "room-1" ? [picture] : []), markStored: () => {} };
  const open = async (_ctx: ToolContext, file: ChatAttachment): Promise<OpenedAttachment> => {
    const bytes = file.localPath ? await readFileBytes(file.localPath).catch(() => null) : null;
    return bytes ? { bytes, path: file.localPath! } : { error: "gone" };
  };
  const tool = createAttachmentReadTool(attachmentReadOptions({ deps, index: index as never, intake: {} as never, open, status: () => ({ startedAt: 0, provider: "test", model: "m" }) as never }));
  const ctx = (extra: Partial<ToolContext> = {}) => ({ agentId: "coder", gateway: "discord", gatewayId: "discord:coder", chatId: "room-1", chatType: "group", ...extra }) as ToolContext;
  return { store, theirs, tool, ctx };
}

describe("attachment_read, lent to a coding CLI", () => {
  test("with no arguments, the conversation's files", async () => {
    const { tool, ctx } = setup();
    const listed = await tool.execute({}, ctx({ lent: true }));
    expect(listed.content).toContain("- fchart01 · chart.png · image/png");
  });

  test("a picture: its path, in the agent's own folder — readable, a copy of the one another agent stored — not the picture", async () => {
    const { store, theirs, tool, ctx } = setup();
    runAgentCommandsThrough({ prefix: () => [], put: () => [] });
    cleanups.push(() => runAgentCommandsThrough(null));
    const opened = await tool.execute({ ref: "fchart01" }, ctx({ lent: true }));
    expect(opened.isError).toBe(false);
    expect(opened.media).toBeUndefined();
    const path = /It is at `(\S+)`\. Open it with your own tools/.exec(opened.content)?.[1];
    expect(path).toBeDefined();
    expect(path).not.toBe(theirs);
    expect(store.holds("coder", path!)).toBe(true);
    expect(readFileSync(path!, "utf8")).toBe("png bytes");
    expect(opened.content).toContain("your file-reading tool shows a picture as a picture");
  });

  test("a model's call still gets the picture itself — from the agent's own copy, where each agent is its own user", async () => {
    const { store, tool, ctx } = setup();
    runAgentCommandsThrough({ prefix: () => [], put: () => [] });
    cleanups.push(() => runAgentCommandsThrough(null));
    const opened = await tool.execute({ ref: "fchart01" }, ctx());
    expect(opened.media?.[0]).toMatchObject({ type: "image_ref", ref: "fchart01" });
    expect(store.holds("coder", (opened.media?.[0] as { localPath: string }).localPath)).toBe(true);
  });

  test("where agents share the daemon's user, the file stays where it is", async () => {
    const { theirs, tool, ctx } = setup();
    const opened = await tool.execute({ ref: "fchart01" }, ctx({ lent: true }));
    expect(opened.content).toContain(`It is at \`${theirs}\`. Open it with your own tools`);
  });

  test("a ref from another chat finds nothing, as for a model", async () => {
    const { tool, ctx } = setup();
    const elsewhere = await tool.execute({ ref: "fchart01" }, ctx({ lent: true, chatId: "814", chatType: "dm" }));
    expect(elsewhere).toMatchObject({ isError: true, content: "No file with ref `fchart01` in this conversation. Call attachment_read with no arguments to see what is here." });
  });
});
