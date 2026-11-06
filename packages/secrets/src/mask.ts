/**
 * Mask the credentials an agent's commands were given, wherever they come back.
 *
 * `exec_secrets` puts a value in a child's environment and keeps it out of the model's context — until
 * the command prints it. `echo $TOKEN`, `curl -v`, `env`, a script that logs its config: the value is
 * then in the tool result, and from there in the transcript, the spill file, the provider's request and
 * every later turn. The harness tells the agent not to; this is what holds when it does anyway.
 *
 * Exact values, not patterns. `redact` (`redact.ts`) guesses at credential *shapes*, which is right for
 * text of unknown origin; here the daemon knows precisely which strings are secret, so a guess would only
 * add misses and false hits. The encoded forms are included because they are how a value usually
 * reappears — an `Authorization: Basic` header, a URL query string.
 */

/** Shorter than this and a "secret" is as likely to be a word in ordinary output as a credential. */
const MIN_MASKED_LENGTH = 6;

/**
 * How much of the start of a value is masked as the value, when the rest of it is missing.
 *
 * Exact matching let a slice through: an agent checking that a key was set ran
 * `echo "${KEY:0:10}..."` on a live box, and the start of the key went into its transcript and to its
 * provider — the whole value never appeared, so nothing matched. A print that stops short, a
 * truncated column, `head -c` all look the same. Eight characters is past the fixed prefixes keys
 * carry (`sk-`, `ghp_`), so what is left is the part that is secret, and long enough that ordinary
 * output does not begin a credential by chance. A key with a longer fixed prefix (`github_pat_`) has
 * that prefix masked wherever it appears, which costs some readability and nothing else.
 */
const MIN_PARTIAL = 8;

/** A URL's scheme or a path: how a value starts that shares its start with everything else of its kind. */
const SHARED_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|~?\/)/i;

/** Entries of a child environment that are paths or plumbing, not credentials. */
const NOT_SECRET = new Set(["NOURIDE_CREDENTIALS_DIR"]);

/**
 * How a value is found. `whole`: only all of it — for text that is a conversation rather than a command's output, where
 * the start of a stored value is too often an ordinary word to take on its own.
 */
export interface MaskOptions {
  whole?: boolean;
}

export function maskSecrets(text: string, env: Record<string, string>, options: MaskOptions = {}): string {
  if (!text) return text;
  const masker = new SecretMasker(env, options);
  return masker.push(text) + masker.end();
}

/**
 * The same masking, for text that arrives in pieces.
 *
 * `exec` writes a large output to disk as it streams, and that file is readable by the agent — so it
 * has to be masked *before* it is written, not when a `read` of it comes back. Masking only the read
 * would leave the value on disk and one `grep` away: a pattern the agent guesses one character at a
 * time answers "found" or "not found" either way.
 *
 * The problem streaming adds is a value split across two chunks. So the tail of a chunk that *is* the
 * start of a value is held back until the next chunk says whether the rest follows; `end` releases
 * what is left. Only a real partial match is held, not a fixed window: holding the last N characters
 * of every chunk delayed a short stderr line until the stream ended, and it landed in the spooled log
 * after output that had been printed long after it.
 *
 * One scanner for both paths, so the streamed file and the in-memory result cannot disagree about
 * what a secret is.
 */
export class SecretMasker {
  private readonly needles: Needle[] = [];
  private carry = "";

  constructor(env: Record<string, string>, options: MaskOptions = {}) {
    for (const [name, value] of Object.entries(env)) {
      if (NOT_SECRET.has(name) || value.length < MIN_MASKED_LENGTH) continue;
      const label = `[REDACTED:${name}]`;
      // A value that starts as every URL or path of its kind does is matched whole: its first eight characters —
      // `postgres`, `/home/ga` — are no secret, and held as a head they masked every later mention of them. A printed
      // `.env`'s `DB_URL` held as a handle (`printed.ts`) took `postgres://` out of every output after it.
      const whole = options.whole || SHARED_START.test(value);
      for (const form of new Set([value, Buffer.from(value).toString("base64"), encodeURIComponent(value)])) {
        this.needles.push({ form, head: whole ? form : form.slice(0, MIN_PARTIAL), label });
      }
    }
  }

  /** Mask what is safe to release so far. May return less than it was given; see `end`. */
  push(text: string): string {
    if (this.needles.length === 0) return text;
    return this.scan(this.carry + text, false);
  }

  /** Release whatever was held back. */
  end(): string {
    if (this.needles.length === 0) return "";
    return this.scan(this.carry, true);
  }

  private scan(buffer: string, final: boolean): string {
    // A value starting before `limit` lies wholly inside `buffer`, so it can be decided now; one
    // starting at or after it might continue into the next chunk.
    const limit = final ? buffer.length : buffer.length - this.partialAtEnd(buffer);
    let out = "";
    let at = 0;
    while (at < limit) {
      let found = -1;
      let length = 0;
      let label = "";
      for (const needle of this.needles) {
        const index = buffer.indexOf(needle.head, at);
        if (index === -1 || (found !== -1 && index > found)) continue;
        const matched = matchedLength(buffer, index, needle);
        // Strictly earlier wins; at the same place, the longer match — a value containing another is
        // replaced whole.
        if (found === -1 || index < found || matched > length) {
          found = index;
          length = matched;
          label = needle.label;
        }
      }
      if (found === -1 || found >= limit) break;
      out += buffer.slice(at, found) + label;
      at = found + length;
    }
    const release = Math.max(at, limit);
    out += buffer.slice(at, release);
    this.carry = buffer.slice(release);
    return out;
  }

  /**
   * Length of the longest tail of `buffer` that is the start of a value but not all of it — held, because
   * the next chunk decides how much of the value it is.
   */
  private partialAtEnd(buffer: string): number {
    let longest = 0;
    for (const { form } of this.needles) {
      for (let k = Math.min(form.length - 1, buffer.length); k > longest; k -= 1) {
        if (buffer.endsWith(form.slice(0, k))) {
          longest = k;
          break;
        }
      }
    }
    return longest;
  }
}

/** One form of one value: the whole of it, the start that is enough to mask it, and what replaces it. */
interface Needle {
  form: string;
  /** All of a short value; the first `MIN_PARTIAL` characters of a longer one. */
  head: string;
  label: string;
}

/** How much of the value starts at `index`, where its head was found — so at least that much. */
function matchedLength(buffer: string, index: number, needle: Needle): number {
  let length = needle.head.length;
  while (length < needle.form.length && buffer[index + length] === needle.form[length]) length += 1;
  return length;
}

/**
 * Whether text holds one of these credentials, whole or in part — for what cannot be masked on its way
 * out, such as a file `send_file` puts on a chat platform byte for byte.
 */
export function containsSecret(text: string, env: Record<string, string>): boolean {
  return maskSecrets(text, env) !== text;
}
