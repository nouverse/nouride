/**
 * A person's message as a coding CLI reads it: its words, where it came from, and what came with it (0.8.1, 0.8.7).
 *
 * A picture or a voice note goes as ACP's own block where the CLI said at its handshake that it takes one
 * (`promptCapabilities`), and as its file's path where it did not — the path the agent's own user reads, which its
 * commands are handed too. Each part went as `[image_ref attached]` before 0.8.7: the CLI never saw the picture, and
 * the note beside it said the picture was in its context.
 */

import type { ContentBlock, InitializeResult } from "@nouride/acp";
import { isSupportedImageType } from "@nouride/llm";
import { readFileBytes, statFile } from "@nouride/runtime";
import { sniffImageMime, type AudioFormat, type ChatMessage, type ContentPart } from "@nouride/shared";
import type { TurnRequest } from "@/modules/llm/executor/types.ts";
import { toBase64 } from "@/modules/llm/images.ts";

/** What a CLI takes in a prompt besides text, as it said at its handshake. */
export interface PromptTakes {
  image: boolean;
  audio: boolean;
}

/** What the CLI said it takes; nothing before it said. Its name is never asked: two CLIs alike may differ here. */
export function promptTakes(info: InitializeResult | null): PromptTakes {
  const said = info?.agentCapabilities?.promptCapabilities;
  return { image: said?.image === true, audio: said?.audio === true };
}

const AUDIO_MIME: Record<AudioFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

/**
 * A message as the CLI reads it. The turn's first prompt opens with what the session was not told of who is here
 * (`situation.ts`), where it came from, and who sent it — the person `[[people]]` matched, in a DM too, where a
 * platform's display name is withheld — and carries the turn's notes after the text, `clock` first among them as a
 * model's message has it (0.8.10): a CLI had the date from its own prompt, not the time, nor the household's zone, and
 * worked "remind me at five" out on a guess. Its pictures and sound follow.
 */
export async function promptOf(message: ChatMessage, first: TurnRequest | undefined, opening: string, takes: PromptTakes, maxImageBytes?: number, clock?: string): Promise<ContentBlock[]> {
  const parts: ContentPart[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const words: string[] = [];
  const media: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") words.push(part.text);
    else {
      const block = await blockOf(part, takes, maxImageBytes);
      if (block.type === "text") words.push(block.text);
      else media.push(block);
    }
  }
  const name = first && !first.systemEvent ? (first.person?.name ?? first.senderName) : undefined;
  const who = name ? `${name}: ` : "";
  const said = [...(first && clock ? [clock] : []), ...(first?.reminders ?? [])];
  const notes = said.length ? `\n\n${said.join("\n")}` : "";
  return [{ type: "text", text: `${opening}${first ? whereFrom(first) : ""}${who}${words.join("\n")}${notes}` }, ...media];
}

/** One part that is not words: the block the CLI takes, else a line naming its file. */
async function blockOf(part: Exclude<ContentPart, { type: "text" }>, takes: PromptTakes, maxImageBytes?: number): Promise<ContentBlock> {
  switch (part.type) {
    case "image":
      return takes.image ? { type: "image", data: part.data, mimeType: part.mimeType } : { type: "text", text: "[a picture came with this message, and you take no pictures in a prompt]" };
    case "audio":
      return takes.audio ? { type: "audio", data: part.data, mimeType: AUDIO_MIME[part.format] } : { type: "text", text: "[a sound came with this message, and you take no sound in a prompt]" };
    case "image_ref": {
      const picture = takes.image ? await pictureAt(part.localPath, maxImageBytes) : null;
      return picture ?? { type: "text", text: `[image: ${part.localPath} (not in your context; open it with your file-reading tool to look at it)]` };
    }
    case "audio_ref": {
      const bytes = takes.audio ? await readFileBytes(part.localPath).catch(() => null) : null;
      return bytes ? { type: "audio", data: toBase64(bytes), mimeType: AUDIO_MIME[part.format] } : { type: "text", text: `[sound: ${part.localPath} (not in your context; open it with your tools to listen)]` };
    }
  }
}

/**
 * The picture at `path` as ACP's image block, or null where it cannot go as one: gone, over `[media] max_image_bytes`,
 * or not one of the four formats a model takes — the bytes decide, as for a model's turn (`llm/images.ts`).
 */
async function pictureAt(path: string, maxBytes: number | undefined): Promise<ContentBlock | null> {
  const size = statFile(path)?.size;
  if (size === undefined || (maxBytes !== undefined && size > maxBytes)) return null;
  const bytes = await readFileBytes(path).catch(() => null);
  const mimeType = bytes ? sniffImageMime(bytes) : null;
  if (!bytes || !mimeType || !isSupportedImageType(mimeType)) return null;
  return { type: "image", data: toBase64(bytes), mimeType };
}

/**
 * Where the turn's message came from, as its first prompt opens: the platform, a DM or which group, and the agents
 * `ask_agent` reaches there. A model's turn has these in its prompt; a CLI was told only who spoke, and, asked whether
 * it could reach Nix, said it saw no way to (0.8.1, the live box). Names alone: a wrong one is answered with each
 * agent's line.
 */
function whereFrom(req: TurnRequest): string {
  const chat = req.chatType === "dm" ? "DM" : req.chatType === "group" ? `group${req.roomName ? ` "${req.roomName}"` : ""}` : undefined;
  const agents = req.otherAgents?.names.length ? `ask_agent: ${req.otherAgents.names.join(", ")}` : undefined;
  return `[${[req.gateway, chat, agents].filter(Boolean).join(" · ")}] `;
}
