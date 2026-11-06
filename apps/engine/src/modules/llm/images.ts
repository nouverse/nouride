/**
 * Turning the pointers a conversation stores into the pixels a model is sent.
 *
 * ## Why the conversation does not hold the pixels
 *
 * A phone screenshot is a megabyte. Storing it as base64 in the conversation would grow the
 * database by every picture anyone ever sent, and — worse — re-upload all of them on every
 * subsequent turn, spending thousands of tokens and seconds of wall clock re-describing a photo
 * from last Tuesday that nobody asked about again.
 *
 * So the transcript holds an `image_ref`: the file's path and its index ref, a hundred bytes. This
 * module is the other half — the step that reads those bytes back for the one request that needs
 * them, and puts a line of text in the place of the ones that do not.
 *
 * ## What "needs them" means
 *
 * The newest images, up to a budget. Not only the message being answered: a person who sends a
 * screenshot and then says "and the top bar?" is still asking about that screenshot, and an agent
 * that has already forgotten it has to be told to go and read it again — which is the tool loop
 * this whole change exists to remove.
 *
 * So it walks backwards and resolves while it can afford to. What falls outside becomes
 * `[image: name — ask attachment_read to look at it again]`, which is true, cheap, and tells the
 * model exactly what to do about it.
 */

import { isSupportedImageType } from "@nouride/llm";
import { readFileBytes, statFile } from "@nouride/runtime";
import { createLogger, FILE_IMAGE_REF, sniffImageMime, type ChatMessage, type ContentPart } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";

const log = createLogger("llm.images");

/**
 * How many bytes of pictures one request may carry — and no count: every picture the conversation holds goes, while
 * they fit.
 *
 * There was a count, four, on the reasoning that a person's fifth screenshot is a sequence whose end is what matters.
 * An agent reviewing a video reads a dozen stills and their checks in one round, and with four it lost each set as it
 * opened the next — then re-read them, or decided they had never reached it (live, 0.8.12). The owner: no limit on
 * pictures. Sixteen megabytes stays, because past it the request itself is the problem: providers reject an oversized
 * body, and a turn that dies on upload sees nothing at all.
 */
const MAX_IMAGE_BYTES_PER_REQUEST = 16 * 1024 * 1024;

export interface ResolveImagesOptions {
  maxBytes?: number;
  /** Per-image ceiling, from `[media] max_image_bytes`. A file over it is never sent. */
  maxBytesEach?: number;
  /** The zone a picture's line gives its time in: the daemon's, as every other time the agent reads. */
  timeZone?: string;
}

/**
 * Resolve the newest image refs into image parts; collapse the rest to text.
 *
 * Returns a new array and never mutates the caller's — the messages it is given are the session's
 * own history, and turning a stored ref into a megabyte of base64 *in place* would put the base64
 * back in the database, which is the thing this design exists to avoid.
 *
 * Never throws. A file that has been deleted, a disk that will not read, an image too big to send:
 * each becomes the same line of text the over-budget ones get, because an answer about the other
 * two pictures beats a turn that died on the third.
 */
export async function resolveImages(
  messages: ChatMessage[],
  options: ResolveImagesOptions = {},
): Promise<ChatMessage[]> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES_PER_REQUEST;

  // Nothing to do is the common case — most turns carry no pictures at all, and this should cost
  // one pass and no allocations when that is true.
  if (!messages.some((message) => hasRefs(message))) return messages;

  let images = 0;
  let bytes = 0;
  const out = [...messages];
  /**
   * Refs already sent in this request.
   *
   * One file can be in the transcript twice — it arrived with a message, and then the agent opened
   * it again with `attachment_read`, which now hands the picture back rather than prose. Sending the
   * same megabyte twice spends the budget on a duplicate and pushes a *different* picture out of the
   * request. The newest copy wins, which is the one the model just asked for.
   */
  const sent = new Set<string>();

  // The message being answered: the newest one a person sent. A wrap-up instruction the executor appends carries no
  // time, and is not it.
  const answering = out.findLastIndex((message) => message.role === "user" && message.timestamp !== undefined);
  const zone = safeTimeZone(options.timeZone ?? "UTC");
  // What comes after the model's last reply is what this step opened: a picture there that does not fit was never seen.
  const thisStep = out.findLastIndex((message) => message.role === "assistant") + 1;

  // Backwards: the newest picture is the one the question is about.
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]!;
    if (!hasRefs(message)) continue;

    const parts: ContentPart[] = [];
    for (const part of message.content as ContentPart[]) {
      if (part.type !== "image_ref") {
        parts.push(part);
        continue;
      }

      const opened = part.ref.startsWith(FILE_IMAGE_REF);
      const resolved = sent.has(part.ref)
        ? null
        : await loadImage(part.localPath, part.mimeType, {
            remainingBytes: maxBytes - bytes,
            maxBytesEach: options.maxBytesEach,
          });

      if (!resolved || "over" in resolved) {
        const line =
          opened && sent.has(part.ref)
            ? `[image: ${part.ref.slice(FILE_IMAGE_REF.length)}, opened again further down, and shown there]`
            : opened && resolved
              ? crowdedOut(part.ref, index >= thisStep, maxBytes)
              : placeholderFor(part.filename, part.ref);
        parts.push({ type: "text", text: line });
        continue;
      }
      if ("unsendable" in resolved) {
        parts.push({ type: "text", text: unsendableLine(part.filename, resolved.unsendable) });
        continue;
      }

      images += 1;
      bytes += resolved.bytes;
      sent.add(part.ref);
      if (message.role === "user") {
        const sentAt = part.sentAt ?? message.timestamp;
        const own = index === answering && (part.sentAt === undefined || message.timestamp === undefined || part.sentAt >= message.timestamp);
        parts.push({ type: "text", text: pictureLine(own, sentAt, out[answering]?.timestamp, zone) });
      }
      parts.push({ type: "image", mimeType: resolved.mimeType, data: resolved.data });
    }
    out[index] = { ...message, content: parts };
  }

  if (images > 0) log.debug("images resolved for this request", { images, bytes });
  return out;
}

function hasRefs(message: ChatMessage): boolean {
  return typeof message.content !== "string" && message.content.some((part) => part.type === "image_ref");
}

/**
 * The line in front of a picture in a person's message: when it was sent, and whether it came with the message being
 * answered.
 *
 * Without it every picture in a request looks alike, and the newest is told apart only by where it sits. On 2026-10-24
 * a quiz was sent one photo at a time; the store had written each over the last, so every picture showed the newest,
 * and the agent — unable to tell the photo it was asked about from the ones before — took back answers that had been
 * right. The store keeps each file now; this says which is which. The date is given only when it is not the day of
 * the message being answered.
 */
function pictureLine(own: boolean, sentAt: number | undefined, answeringAt: number | undefined, timeZone: string): string {
  let when = "";
  if (sentAt !== undefined) {
    const at = localTime(sentAt, timeZone);
    when = answeringAt !== undefined && localTime(answeringAt, timeZone).day === at.day ? ` at ${at.time}` : ` on ${at.day} at ${at.time}`;
  }
  return own
    ? `[New picture, sent${when} with the message you are answering:]`
    : `[Earlier picture, sent${when}, not part of the message you are answering:]`;
}

/**
 * What the model reads where a picture would have been.
 *
 * It names the ref, because the next thing a model wants after "there was an image here" is a way
 * to look at it — and `attachment_read` takes exactly this.
 */
function placeholderFor(filename: string | undefined, ref: string): string {
  if (ref.startsWith(FILE_IMAGE_REF)) return `[image: ${ref.slice(FILE_IMAGE_REF.length)}, not in this request; \`read\` it to look at it again]`;
  return `[image: ${filename ?? "attachment"}, not in this request; \`attachment_read\` with ref ${ref} to look at it]`;
}

/**
 * A file the agent opened, left out because the pictures in the request already weigh what one may carry.
 *
 * "`read` it to look at it again" alone made a loop on the live box (0.8.12), and "not in this request" made an agent
 * take back what it had written about pictures it had seen. So the line says which it is: opened in this step and never
 * shown — fewer at once, or smaller copies — or older, seen when it was opened, and what was written about it stands.
 */
function crowdedOut(ref: string, thisStep: boolean, maxBytes: number): string {
  const path = ref.slice(FILE_IMAGE_REF.length);
  const mb = Math.round(maxBytes / (1024 * 1024));
  return thisStep
    ? `[image: ${path}, not shown: the pictures opened in this step weigh more than the ${mb} MB a request carries. Read it again with fewer at once, or make a smaller copy]`
    : `[image: ${path}, left out of this request to make room for newer pictures (a request carries ${mb} MB of them). You saw it when it was opened: what you wrote about it then stands; read it again only to look again]`;
}

/**
 * A picture that is not one of the four formats a model takes — a HEIC from an iPhone, a BMP, an animated sticker
 * labelled WebP — said as such. Sent, the provider refuses the whole request over it, and the turn dies on a file
 * nobody asked about; pointed at `attachment_read`, the agent would fetch the same refusal again.
 */
function unsendableLine(filename: string | undefined, format: string): string {
  return `[image: ${filename ?? "attachment"}: ${format} is not a format the model can be sent; ask for a PNG or JPEG, or convert it with your tools]`;
}

async function loadImage(
  path: string,
  mimeType: string,
  limits: { remainingBytes: number; maxBytesEach?: number },
): Promise<{ data: string; mimeType: string; bytes: number } | { unsendable: string } | { over: true } | null> {
  /**
   * Size checked from the directory entry before the file is opened.
   *
   * Reading an 80 MB file into memory to discover it is too big to send is the failure this
   * avoids, on a daemon whose whole design is about staying inside a few hundred megabytes.
   */
  const size = statFile(path)?.size;
  if (size === undefined) return null;
  if (limits.maxBytesEach !== undefined && size > limits.maxBytesEach) return null;
  // Base64 is four bytes out for every three in, and it is the encoded length that travels.
  if (Math.ceil(size / 3) * 4 > limits.remainingBytes) return { over: true };

  try {
    const raw = await readFileBytes(path);
    // The bytes decide what is sent and as what — a label is somebody's claim (`sniffImageMime`).
    const actual = sniffImageMime(raw);
    if (!actual || !isSupportedImageType(actual)) return { unsendable: actual ?? `this file (labelled ${mimeType})` };
    return { data: toBase64(raw), mimeType: actual, bytes: Math.ceil(raw.byteLength / 3) * 4 };
  } catch (err) {
    log.warn("an attached image could not be read back", { path, error: String(err) });
    return null;
  }
}

/**
 * Bytes to base64 without a runtime-specific helper.
 *
 * `btoa` is a web global present in every runtime this targets, and it takes a binary string — so
 * the bytes are turned into one in chunks. In one go, a megabyte-long spread (`...bytes`) blows the
 * argument limit and throws `RangeError: Maximum call stack size exceeded` on exactly the large
 * images this exists to carry.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
