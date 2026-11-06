/**
 * Outbound text shaping, shared by every platform.
 *
 * Lives on its own because both Discord and Telegram need it: having the Discord gateway import
 * from the Telegram one made one adapter depend on another for no reason, which is exactly the
 * coupling the adapter boundary exists to prevent.
 */

/**
 * Whether a message's text is sent at all: when there is something to say, or nothing else to send.
 *
 * `chunk("")` answers `["(empty response)"]` so a reply that produced no text still says something. A message carrying
 * a file is not that reply — `send_file` sends `text: ""` because the caption rides on the attachment — and before
 * this every file arrived behind a line of that placeholder. One rule for every adapter, so none drifts from the rest.
 */
export function sendsText(msg: { text: string; attachments?: readonly unknown[] }): boolean {
  return msg.text.trim() !== "" || (msg.attachments?.length ?? 0) === 0;
}

/**
 * Split on paragraph, then line, then a hard character boundary.
 *
 * Cutting mid-word is avoidable and looks broken; cutting mid-code-block is worse. Trying
 * the natural boundaries first keeps most splits invisible. The `limit * 0.5` guard stops a
 * single long line from producing a tiny fragment followed by a full one.
 *
 * A cut inside a fenced block closes it and reopens it in the next part. Without that, part one ends
 * with an unterminated ``` — every platform renders the rest of that message as code, and on Telegram,
 * where the text is converted to HTML, an unclosed `<pre>` is a malformed document the API rejects
 * outright. The message that most needs splitting is the one with a long code block in it, so this is
 * the common case rather than the edge one.
 *
 * `measure` is the length the platform counts — the source's own by default; see `chunkRendered`.
 */
export function chunk(text: string, limit: number, measure: (part: string) => number = (part) => part.length): string[] {
  if (measure(text) <= limit) return [text || "(empty response)"];

  const parts: string[] = [];
  let remaining = text;
  /** The fence line to reopen with, when a cut lands inside a block. */
  let reopen: string | null = null;

  while (remaining.length > 0) {
    const part = nextPart(remaining, reopen, limit, measure);
    parts.push(part.text);
    reopen = part.open;
    remaining = remaining.slice(part.at).trimStart();
  }

  return parts;
}

/** One part: what is sent, how much of the remaining text it took, and the fence it leaves open. */
interface Part {
  text: string;
  at: number;
  open: string | null;
}

/** How many times a part may be re-cut before it is sent as-is and left to the platform. */
const MAX_REFITS = 6;

/**
 * The longest part that fits as the platform measures it. One that overflows is cut again against a budget
 * scaled by how far it overflowed, and what that leaves stays in the text for the next part. Re-cutting a part
 * on its own sent its overflow as a message of its own: a long answer went out as a full part, a few words,
 * a full part, a few words — eleven messages where six held it, each paced a second behind the last.
 */
function nextPart(remaining: string, reopen: string | null, limit: number, measure: (part: string) => number): Part {
  let budget = limit;
  for (let refits = 0; ; refits += 1) {
    const part = cutAt(remaining, reopen, budget);
    const size = measure(part.text);
    // Out of retries, or already as small as a cut can make it: send it and let the log carry the
    // rejection. Truncating here would lose words silently, which is worse than a visible failure.
    if (size <= limit || refits >= MAX_REFITS || part.at <= 1) return part;
    budget = Math.max(1, Math.min(budget - 1, Math.floor((part.text.length * limit) / size) - 1));
  }
}

/** The part a source budget of `budget` characters cuts from the front of `remaining`. */
function cutAt(remaining: string, reopen: string | null, budget: number): Part {
  const prefix = reopen ? `${reopen}\n` : "";
  let at = cutPoint(remaining, budget - prefix.length);
  let open = openFence(prefix + remaining.slice(0, at));

  if (open) {
    // The closing fence is text the platform measures too, so it comes out of the budget rather
    // than being appended past it. A part cut inside a block used to come back `limit + 4`
    // characters long and be rejected outright — and the message that most needs splitting is
    // exactly the one with a long code block in it. Only a cut that actually lands inside a block
    // pays for the second pass.
    at = cutPoint(remaining, budget - prefix.length - fenceMarker(open).length - 1);
    open = openFence(prefix + remaining.slice(0, at));
  }

  const piece = prefix + remaining.slice(0, at).trimEnd();
  return { text: open ? `${piece}\n${fenceMarker(open)}` : piece, at, open };
}

/**
 * Where to cut: paragraph, then line, then word, then the budget itself.
 *
 * Never zero. A budget smaller than the fence bookkeeping would otherwise cut nothing, and the
 * caller's loop would never consume its input.
 */
function cutPoint(text: string, budget: number): number {
  if (text.length <= budget) return text.length;
  const window = text.slice(0, Math.max(1, budget));
  // In that order, each only in the second half of the window. This was the latest of the three, so any space after
  // a paragraph break won, and a reply was cut mid-sentence with its paragraph break a few hundred characters back —
  // and `\n\n` could never be chosen at all, since the `\n` inside it is always later (the 0.7.11 mutation sweep).
  for (const boundary of ["\n\n", "\n", " "]) {
    const cut = window.lastIndexOf(boundary);
    if (cut > budget * 0.5) return cut;
  }
  return Math.max(1, budget);
}

/**
 * Chunk against the length the platform actually counts, not the markdown it came from.
 *
 * `chunk` budgets the source, and every renderer here makes the text *longer* than the source:
 * `flattenTable` turns one grid row into a labelled record, and Telegram's HTML wraps a tag around
 * every mark. A 4091-character part rendered to 4127 characters of plain text and 4719 of HTML;
 * Telegram rejected both with `message is too long`, the buffered retry failed the same way, and the
 * reply — correctly written, correctly split — was dropped and never arrived.
 *
 * So the budget is the one the platform enforces. Chunking still happens on markdown, because that is
 * the only place a cut can land on a boundary rather than inside a tag; what changes is that a part
 * whose *rendered* form overflows is re-cut against a source budget scaled by how far it overflowed
 * (`nextPart`). Ordinary expansion converges in one pass, and the retries are bounded either way.
 */
export function chunkRendered(
  text: string,
  limit: number,
  render: (part: string) => string,
): string[] {
  return chunk(text, limit, (part) => render(part).length);
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/**
 * The fence line left open at the end of this text, or null.
 *
 * Returns the *opening* line, language tag and all, so the next part resumes with the same
 * highlighting rather than dropping to plain text halfway through a listing.
 */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    if (open === null) {
      open = line.trim();
    } else if (line.trimStart().startsWith(fenceMarker(open))) {
      open = null;
    }
  }
  return open;
}

/** The backticks or tildes from an opening fence, without its language tag. */
function fenceMarker(openLine: string): string {
  return FENCE_LINE.exec(openLine)?.[1] ?? "```";
}
