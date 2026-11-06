/**
 * Voice notes into sound for the request that needs them, and out again when a model refuses them.
 *
 * The pair of `images.ts`, with one rule that differs on purpose. Images are resolved backwards
 * through the whole conversation within a budget, because "and the top bar?" is still a question
 * about the screenshot. Audio is resolved **for the current turn only**: a minute of speech is a
 * couple of thousand tokens, and a follow-up is almost never about the tone of a voice note the model
 * has already answered. An older clip becomes a line saying what it was and how to hear it again.
 *
 * The turn's boundary is the last assistant message that called no tools — the previous turn's
 * answer. Everything after it is this turn: the message being answered, and anything `attachment_read`
 * brought back while answering it.
 */

import { readFileBytes, statFile } from "@nouride/runtime";
import { createLogger, type AudioRefPart, type ChatMessage, type ContentPart } from "@nouride/shared";
import { toBase64 } from "./images.ts";

const log = createLogger("llm.audio");

/** Clips one request may carry. The newest win. */
const MAX_CLIPS_PER_REQUEST = 3;
/** Bytes, as base64, one request may carry in audio. OpenAI's own ceiling for `input_audio`. */
const MAX_AUDIO_BYTES_PER_REQUEST = 20 * 1024 * 1024;

/**
 * Resolve this turn's audio refs into audio parts; collapse every other one to text.
 *
 * Never mutates the caller's array and never throws — the same contract as `resolveImages`, for the
 * same reasons: these are the session's own messages, and a clip that will not load is a sentence,
 * not a turn that died.
 */
export async function resolveAudio(messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!messages.some(hasAudioRef)) return messages;

  const boundary = turnStart(messages);
  let clips = 0;
  let bytes = 0;
  const out = [...messages];

  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]!;
    if (!hasAudioRef(message)) continue;

    const parts: ContentPart[] = [];
    for (const part of message.content as ContentPart[]) {
      if (part.type !== "audio_ref") {
        parts.push(part);
        continue;
      }
      if (index < boundary || clips >= MAX_CLIPS_PER_REQUEST) {
        parts.push({ type: "text", text: earlierClip(part) });
        continue;
      }
      const data = await load(part, MAX_AUDIO_BYTES_PER_REQUEST - bytes);
      if (data === null) {
        parts.push({ type: "text", text: unreadableClip(part) });
        continue;
      }
      clips += 1;
      bytes += data.length;
      parts.push({ type: "audio", format: part.format, data });
    }
    out[index] = { ...message, content: parts };
  }

  if (clips > 0) log.debug("audio resolved for this request", { clips, bytes });
  return out;
}

/** Whether any message still carries audio, as a ref or as bytes. */
export function carriesAudio(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      typeof message.content !== "string" &&
      message.content.some((part) => part.type === "audio" || part.type === "audio_ref"),
  );
}

/**
 * Every clip replaced by a line saying it was refused.
 *
 * What a model that refused audio is sent on the retry. The line is an instruction as much as a
 * record: without it the retry is the same text without the voice note, and a model answers that as
 * if the voice note had said nothing — or as if it had heard it.
 */
export function withoutAudio(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    if (!message.content.some((part) => part.type === "audio" || part.type === "audio_ref")) return message;
    return {
      ...message,
      content: message.content.map((part): ContentPart =>
        part.type === "audio" || part.type === "audio_ref"
          ? {
              type: "text",
              text:
                "[voice note, not sent: the model refused audio, so you have not heard it. Do not guess " +
                "what it says. Tell the sender you could not listen to it, and ask them to type it or use " +
                "their phone's voice-to-text.]",
            }
          : part,
      ),
    };
  });
}

function hasAudioRef(message: ChatMessage): boolean {
  return typeof message.content !== "string" && message.content.some((part) => part.type === "audio_ref");
}

/** Index of the first message of the current turn: just after the previous turn's answer. */
function turnStart(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && !(message.toolCalls?.length)) return index + 1;
  }
  return 0;
}

function describe(part: AudioRefPart): string {
  const name = part.filename ?? "voice note";
  if (part.durationSec === undefined) return name;
  const whole = Math.round(part.durationSec);
  return `${name}, ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Names the ref, because what a model wants next after "there was a voice note" is to hear it. */
function earlierClip(part: AudioRefPart): string {
  return `[voice note (${describe(part)}) from earlier, not in this request; \`attachment_read\` with ref ${part.ref} to listen to it again]`;
}

function unreadableClip(part: AudioRefPart): string {
  return `[voice note (${describe(part)}) that could not be read back, so you have not heard it. Say so rather than guessing what it says.]`;
}

/** Base64 of the clip, or `null` when it is gone, unreadable, or would not fit what is left. */
async function load(part: AudioRefPart, remaining: number): Promise<string | null> {
  // Size from the directory entry first — reading a file to find out it is too big is the waste
  // `images.ts` avoids for the same reason.
  const size = statFile(part.localPath)?.size;
  if (size === undefined || Math.ceil(size / 3) * 4 > remaining) return null;
  try {
    return toBase64(await readFileBytes(part.localPath));
  } catch (err) {
    log.warn("a voice note could not be read back", { path: part.localPath, error: String(err) });
    return null;
  }
}
