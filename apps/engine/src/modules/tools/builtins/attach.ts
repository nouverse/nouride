/**
 * `send_file` — hand a file to the person in the conversation.
 *
 * The gap this closes is narrow and was invisible from the type system, which is why it survived so
 * long: `OutboundMessage.attachments` has existed since the first envelope, no adapter ever read it,
 * and nothing in the engine ever set it. So the field type-checked, documented a capability, and did
 * nothing — the exact shape invariant 5 exists to forbid.
 *
 * What it cost in practice: an agent doing infra work can read a log, write a diff and run a command
 * that produces a report, and the only way any of it reaches the operator is pasted into chat as
 * text. A 4000-line log becomes "here are the interesting bits, trust me", or a dozen chunked
 * messages that nobody can scroll.
 *
 * ## Why this needs no approval
 *
 * It discloses nothing `read` does not. The path must resolve inside the agent's own workspace
 * roots — the same sandbox every file tool uses — and the file goes to the conversation the agent is
 * already speaking in, never anywhere else. An agent that wanted to leak the same bytes could
 * already `read` them and paste them, unapproved, today. Gating the tidier version of an ungated act
 * teaches an operator to click through prompts, which is how a gate stops working.
 *
 * The size cap is `[attachments] max_size_mb` — the same knob that bounds what this daemon accepts,
 * because "how big a file this install moves" is one question and two numbers would drift.
 */

import { basename, extname, readFileBytes, resolveWithin, statFile } from "@nouride/runtime";
import {
  createLogger,
  looksLikeHtml,
  sniffImageMime,
  type Attachment,
  type AttachmentType,
  type Tool,
  type ToolContext,
  type ToolResult, formatBytes} from "@nouride/shared";
import { rootsFor } from "@/modules/tools/builtins/files.ts";
import { looksBinary } from "@/modules/tools/builtins/document-kind.ts";
import { credentialKind, credentialSendRefusal } from "@/modules/tools/credential-files.ts";
import { containsSecret } from "@nouride/secrets";
import { checkUrl, judgedFetch, type UrlPolicy } from "@/modules/tools/url-safety.ts";

const log = createLogger("tools.attach");

export interface SendFileOptions {
  /**
   * Puts the file on the wire and says whether it arrived.
   *
   * `delivered` is separate from `ids` because an empty id list means two different things — the
   * platform refused it, or this transport has no message ids at all — and only the caller holding the
   * gateway can tell them apart. Judging by `ids.length` reported `could not be delivered` for two
   * images that were on screen, and the agent passed that on as a broken gateway.
   */
  send: (ctx: ToolContext, attachment: Attachment) => Promise<{ ids: string[]; delivered: boolean; refused?: string }>;
  maxBytes: number;
  /** The same policy `web_fetch` uses. Absent means a URL cannot be sent, only a path. */
  urlPolicy?: UrlPolicy;
  fetchImpl?: typeof fetch;
  /**
   * Injectable so a test does not need DNS.
   *
   * `checkUrl` resolves the hostname for real, which is the point of it — and it means a test using
   * a made-up domain fails on the lookup rather than on the thing it is asserting. `web_fetch` takes
   * the same override for the same reason.
   */
  checkUrlImpl?: typeof checkUrl;
  /**
   * This agent's credentials, to check a text file for before it leaves (`exec_secrets` values).
   *
   * A file on a chat platform cannot be masked the way a tool result is — it goes byte for byte — so a
   * script or a log that picked up a key is refused here instead of being posted. Absent: not checked.
   */
  childEnv?: (agentId: string) => Record<string, string>;
}

/**
 * A remote file, fetched here rather than handed to the platform.
 *
 * Telegram and Discord will both fetch a URL themselves, which is one fewer moving part and how
 * OpenClaw does it. Fetching it ourselves buys three things that turned out to matter more:
 *
 * - **The SSRF guard applies.** `checkUrl` validates every redirect hop, and the URL here came from
 *   a model reading search results — the least trustworthy source of a URL there is.
 * - **The size cap is ours.** A platform refusing a 30MB file answers with its own error, which the
 *   model cannot act on. Ours names the limit.
 * - **It works for URLs the platform cannot reach.** A self-hosted SearXNG on a private address
 *   serves thumbnails Telegram's servers will never see.
 */
async function fetchRemote(
  url: string,
  options: SendFileOptions,
): Promise<{ bytes: Uint8Array; contentType: string } | { error: string }> {
  if (!options.urlPolicy) return { error: "Sending a file by URL is not available on this daemon." };

  // From the addresses each hop's check judged, never from a second lookup of the name (S12).
  const doFetch = judgedFetch(options.fetchImpl);
  const check = options.checkUrlImpl ?? checkUrl;
  let target = url;

  // Redirects followed by hand, so every hop is checked. `redirect: "follow"` hides the intermediate
  // URLs, which makes a public URL that 302s to a private one indistinguishable from a normal fetch.
  for (let hop = 0; hop < 5; hop++) {
    const verdict = await check(target, options.urlPolicy);
    if (!verdict.allowed) return { error: `Refused: ${verdict.reason ?? "blocked by the URL policy"}` };

    const res = await doFetch(
      target,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: "*/*",
          // Named, because a request without one is refused outright by a lot of the web. Wikimedia
          // answers **HTTP 400** to a UA-less fetch, which found this the first time a real image URL
          // was tried — the error reads like a bad URL and is not. The same reason `web_search`'s
          // keyless sources carry one.
          "user-agent": "nouride/0.1 (+https://github.com/nouverse/nouride)",
        },
      },
      verdict.addresses ?? [],
    );

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { error: `The server redirected without saying where (HTTP ${res.status}).` };
      target = new URL(location, target).toString();
      continue;
    }
    if (!res.ok) return { error: `The server answered HTTP ${res.status} for that URL.` };

    // Checked before reading, when the server declares it: a 30MB download refused after it has been
    // pulled into memory has already cost what the cap exists to avoid.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > options.maxBytes) {
      return {
        error: `That file is ${formatBytes(declared)}, over the ${formatBytes(options.maxBytes)} limit for this install.`,
      };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return { error: "That URL returned an empty file." };
    // Again after reading, because `content-length` is optional and a chunked response has none.
    if (bytes.byteLength > options.maxBytes) {
      return {
        error: `That file is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(options.maxBytes)} limit for this install.`,
      };
    }

    return { bytes, contentType: (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "" };
  }

  return { error: "That URL redirected too many times." };
}

/**
 * What the bytes say, against what the name said.
 *
 * Returns a refusal when the two disagree in the way that actually happens — a file named like a
 * picture whose contents are a web page — and a corrected mime type when they disagree harmlessly.
 *
 * The case, in full: an agent asked to find a photo picked a URL ending in `.jpg`, the host was
 * behind Cloudflare, and 5KB of `Just a moment...` came back. This tool named the file from the
 * extension, sent it as `image/jpeg`, and reported `Sent shiba-inu.jpg` — so the chat showed a broken
 * image, the operator was told it had arrived, and the next agent to open it blamed its own vision
 * model for a 400. Refusing here is the only place that reads as the truth.
 */
function checkBytes(
  bytes: Uint8Array,
  named: { filename: string; type: AttachmentType; mimeType: string },
): { error: string } | { mimeType: string } {
  if (named.type === "image" && looksLikeHtml(bytes)) {
    return {
      error:
        `That is not an image: it is an HTML page (${formatBytes(bytes.byteLength)}), even though it ` +
        `is named \`${named.filename}\`. A Cloudflare check or a login wall answers that way. Nothing ` +
        `was sent; try a different source, or open the page with \`web_fetch\` if the picture's real URL ` +
        `is inside it.`,
    };
  }
  // A real image whose extension lies is corrected rather than refused: the file works, only the
  // label was wrong, and a platform decides how to render from the label.
  const sniffed = sniffImageMime(bytes);
  return { mimeType: sniffed && named.type === "image" ? sniffed : named.mimeType };
}

/**
 * Extension → what the platform should treat it as.
 *
 * Deliberately small, and everything unlisted is a `file`. The type only decides how a platform
 * *presents* the bytes — an image inline, a document as a download — so guessing wrong is cosmetic,
 * while a long table of media types is something nobody maintains and everybody trusts.
 */
const TYPE_BY_EXTENSION: Record<string, AttachmentType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".heic": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  /**
   * The three spellings of an Opus voice note.
   *
   * `.ogg` was the only one, so a file a recorder named `.opus` — which is what most of them do —
   * went out as a plain document. The container is the same; only the extension differs.
   */
  ".ogg": "voice",
  ".opus": "voice",
  ".oga": "voice",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  // Office formats, because "send me the report" means a docx or an xlsx more often than it means
  // anything else. The long names are the actual registered types; a `.docx` sent as
  // `application/octet-stream` still opens, but it arrives looking like an unknown blob.
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".flac": "audio/flac",
  ".mkv": "video/x-matroska",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".sql": "application/sql",
  ".7z": "application/x-7z-compressed",
  ".tgz": "application/gzip",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

/**
 * The reverse of `MIME_BY_EXTENSION`, for naming a download whose URL carries no extension.
 *
 * **First one wins**, which is why the table lists `.jpg` before `.jpeg`. Built the obvious way with
 * `Object.fromEntries` the last would win instead, and `image/jpeg` would name every download
 * `.jpeg` — correct, unusual, and decided by the order somebody happened to type two lines in.
 */
const EXTENSION_BY_MIME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [extension, mime] of Object.entries(MIME_BY_EXTENSION)) {
    map[mime] ??= extension;
  }
  return map;
})();


/**
 * Name and type a remote file.
 *
 * The URL's last path segment is the filename when it looks like one, because that is what the
 * person receiving it will see. When it does not — a CDN URL ending in a hash, a query-string image
 * service — the content type decides, and the fallback is a plain `file` rather than a guess: a
 * `.jpg` extension on an HTML error page is a worse outcome than an unnamed download.
 */
function nameRemote(url: string, contentType: string): { filename: string; type: AttachmentType; mimeType: string } {
  let candidate = "";
  try {
    candidate = basename(new URL(url).pathname);
  } catch {
    candidate = "";
  }

  const extension = extname(candidate).toLowerCase();
  if (extension && (TYPE_BY_EXTENSION[extension] || MIME_BY_EXTENSION[extension])) {
    return {
      filename: candidate,
      type: TYPE_BY_EXTENSION[extension] ?? "file",
      mimeType: MIME_BY_EXTENSION[extension] ?? contentType ?? "application/octet-stream",
    };
  }

  const fromType = EXTENSION_BY_MIME[contentType];
  const type: AttachmentType = contentType.startsWith("image/")
    ? "image"
    : contentType.startsWith("video/")
      ? "video"
      : contentType.startsWith("audio/")
        ? "audio"
        : "file";

  const stem = candidate.replace(/\.[^.]*$/, "") || "download";
  return {
    filename: fromType ? `${stem}${fromType}` : stem,
    type,
    mimeType: contentType || "application/octet-stream",
  };
}

/** Fetch a URL and send what came back. Kept beside the path branch so both end the same way. */
async function sendRemote(
  url: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  options: SendFileOptions,
): Promise<ToolResult> {
  const fetched = await fetchRemote(url, options);
  if ("error" in fetched) return { content: fetched.error, isError: true };

  const named = nameRemote(url, fetched.contentType);
  // Checked here rather than trusting `nameRemote`, which prefers the URL's extension — correctly,
  // since a server's `content-type` is often `application/octet-stream` for a perfectly good photo.
  // What it cannot know is what arrived.
  const checked = checkBytes(fetched.bytes, named);
  if ("error" in checked) return { content: checked.error, isError: true };

  const sent = await options.send(ctx, {
    type: named.type,
    buffer: fetched.bytes,
    mimeType: checked.mimeType,
    filename: named.filename,
    size: fetched.bytes.byteLength,
    ...(typeof args.caption === "string" && args.caption.trim()
      ? { caption: args.caption.trim() }
      : {}),
  });

  if (!sent.delivered) return { content: undelivered(named.filename, sent.refused), isError: true };

  log.info("remote file sent to chat", {
    agent_id: ctx.agentId,
    chat_id: ctx.chatId,
    filename: named.filename,
    bytes: fetched.bytes.byteLength,
  });
  return {
    content: `Sent \`${named.filename}\` (${formatBytes(fetched.bytes.byteLength)}) to this conversation.`,
    isError: false,
  };
}

export function createSendFileTool(options: SendFileOptions): Tool {
  return {
    requiresApproval: false,
    definition: {
      name: "send_file",
      description:
        "Send a file to this conversation, so the person receives it as a real attachment instead of " +
        "pasted text. " +
        "Give either `path` for a file in your workspace, or `url` to send something from the web: " +
        'the `image:` URL from `web_search` with `kind: "image"` goes straight in here. ' +
        "**Do not download it with `curl` or `wget` first.** A shell download of an image succeeds " +
        "with exit 0 when the server answers with a Cloudflare check or a login wall, so you end up " +
        "holding a 5KB HTML page named `.jpg`, and the first thing that notices is the person looking " +
        "at a broken image. Passing the `url` here fetches it under the size cap, follows redirects " +
        "safely, and refuses a page that is not the file, so you find out in this tool call instead. " +
        "**Never invent a URL from memory.** Use one a search returned or the person gave you. A " +
        "recalled address is often almost right, and an almost-right one either fails or delivers " +
        "something nobody asked for. If you have no URL and image search is unavailable, say so.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A file in your workspace, relative to it. Give this or `url`, never both.",
          },
          url: {
            type: "string",
            description:
              "An http(s) URL to fetch and send. Use the direct file URL, not the page it appears on. " +
              "Give this or `path`, never both.",
          },
          caption: {
            type: "string",
            description: "A short line sent with the file. Say what it is; do not restate its contents.",
          },
        },
        required: [],
      },
    },

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const raw = typeof args.path === "string" ? args.path.trim() : "";
      const remote = typeof args.url === "string" ? args.url.trim() : "";

      if (raw && remote) {
        return { content: "Give either `path` or `url`, not both.", isError: true };
      }
      if (remote) return await sendRemote(remote, args, ctx, options);
      if (!raw) return { content: "Give the `path` or the `url` of the file to send.", isError: true };

      // The same sandbox and the same root list `read` uses — reached through `rootsFor` rather than
      // rebuilt here, so a change to what an agent may open cannot apply to reading and miss sending.
      // Read mode: putting a file on the wire is a read, and it must reach read-only roots such as
      // the background-job log directory, which is exactly where a long build log lives.
      const roots = rootsFor(ctx, "read");
      let resolved: string | null = null;
      for (const root of roots) {
        try {
          resolved = resolveWithin(root, raw);
          break;
        } catch {
          // Not under this root — try the next.
        }
      }
      if (!resolved) {
        return {
          content: `\`${raw}\` is outside the directories you may use (${roots.length} configured).`,
          isError: true,
        };
      }

      const stat = await statFile(resolved);
      if (!stat || stat.isDirectory) {
        return {
          content: stat ? `\`${raw}\` is a directory.` : `\`${raw}\` does not exist.`,
          isError: true,
        };
      }
      if (stat.size === 0) {
        // Platforms reject a zero-byte upload, and the refusal reads as a network fault. Saying so
        // here turns it into something the model can act on — usually the command wrote nothing.
        return { content: `\`${raw}\` is empty, so there is nothing to send.`, isError: true };
      }
      if (stat.size > options.maxBytes) {
        return {
          content:
            `\`${raw}\` is ${formatBytes(stat.size)}, over the ${formatBytes(options.maxBytes)} limit ` +
            `for this install. Send an excerpt, or compress it first.`,
          isError: true,
        };
      }

      // A credential file is never put on a chat platform, where nothing masks it — see `credential-files.ts`.
      if (credentialKind(resolved)) return { content: credentialSendRefusal(raw), isError: true };

      const filename = basename(resolved);
      const extension = extname(filename).toLowerCase();
      const buffer = await readFileBytes(resolved);
      const env = options.childEnv?.(ctx.agentId);
      if (env && !looksBinary(buffer.subarray(0, 4096)) && containsSecret(new TextDecoder().decode(buffer), env)) {
        return {
          content: `\`${raw}\` contains the value of one of your credentials, and a file sent to a chat goes as it is: nothing can mask it there. Take the value out, or send the file without it.`,
          isError: true,
        };
      }
      /**
       * The same check as the URL path, and needed for the same reason.
       *
       * A file on disk is not more trustworthy than a URL when the thing that put it there was a
       * download: the agent that hit the Cloudflare page saved it to its workspace first and sent it
       * from there, which is exactly this branch.
       */
      const checked = checkBytes(buffer, {
        filename,
        type: TYPE_BY_EXTENSION[extension] ?? "file",
        mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
      });
      if ("error" in checked) return { content: checked.error, isError: true };

      const attachment: Attachment = {
        type: TYPE_BY_EXTENSION[extension] ?? "file",
        buffer,
        mimeType: checked.mimeType,
        filename,
        size: stat.size,
        ...(typeof args.caption === "string" && args.caption.trim()
          ? { caption: args.caption.trim() }
          : {}),
      };

      const sent = await options.send(ctx, attachment);
      // A gateway that buffered instead of sending, or one that is gone. Reporting success there
      // would have the agent tell the operator a file arrived that did not — and reporting failure
      // when a transport simply has no message ids was the mirror of that, which is what shipped.
      if (!sent.delivered) return { content: undelivered(filename, sent.refused), isError: true };

      log.info("file sent to chat", {
        agent_id: ctx.agentId,
        chat_id: ctx.chatId,
        filename,
        bytes: stat.size,
      });
      return {
        content: `Sent \`${filename}\` (${formatBytes(stat.size)}) to this conversation.`,
        isError: false,
      };
    },
  };
}

/**
 * A file the daemon writes from text, sent as `send_file` sends one (0.8.11): a mission's `report.md`, which needs no
 * file on disk. The same limit on its size, the same refusal of a text holding one of the agent's credentials — a chat
 * cannot mask it — and the same `send`. Null once it arrived, else why not.
 */
export async function sendTextFile(options: Pick<SendFileOptions, "send" | "maxBytes" | "childEnv">, ctx: ToolContext, filename: string, text: string): Promise<string | null> {
  const buffer = new TextEncoder().encode(text);
  if (buffer.byteLength > options.maxBytes) return `it is ${formatBytes(buffer.byteLength)}, over the ${formatBytes(options.maxBytes)} limit for this install.`;
  const env = options.childEnv?.(ctx.agentId);
  if (env && containsSecret(text, env)) return "it holds the value of one of the agent's credentials, and a file sent to a chat goes as it is: nothing can mask it there.";
  const extension = extname(filename).toLowerCase();
  const sent = await options.send(ctx, { type: TYPE_BY_EXTENSION[extension] ?? "file", buffer, mimeType: MIME_BY_EXTENSION[extension] ?? "text/plain", filename, size: buffer.byteLength });
  if (!sent.delivered) return undelivered(filename, sent.refused);
  log.info("file sent to chat", { agent_id: ctx.agentId, chat_id: ctx.chatId, filename, bytes: buffer.byteLength });
  return null;
}

/**
 * Why a file did not arrive, as the agent is told it. A refusal is final and says so, in the platform's words — "it
 * may arrive later" would have the agent tell someone to wait for a file the chat will never take.
 */
function undelivered(filename: string, refused: string | undefined): string {
  return refused
    ? `\`${filename}\` could not be delivered, because the platform refused it: ${refused}. Sending it again here will not help.`
    : `\`${filename}\` could not be delivered: the gateway did not accept it. It may arrive when the connection recovers.`;
}
