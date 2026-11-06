/**
 * What `exec` keeps of a command's output while it runs.
 *
 * Before this, the runner collected up to `tool_max_output_bytes` (10MB) in memory, and the spill
 * then wrote that to disk and showed the model its head and tail. Three things were wrong with it:
 * the daemon held up to 20MB per call for output the model would see 48KB of; the "tail" was the tail
 * of the first 10MB rather than of the output, so a failing build past the cap showed its middle as
 * its ending; and the file on disk stopped where memory did.
 *
 * So the output streams. Small output is held whole, exactly as before — most commands print a few
 * lines, and they must not pay for a file. Once it outgrows `memoryChars` it goes to `spoolPath` as
 * it arrives, and what stays in memory is a bounded head and tail. The tail is the real one, because
 * everything after the head flows through it to the end.
 *
 * Masked before it is written. The file is readable by the agent, so a value that reached it
 * unmasked would be one `grep` away — see `SecretMasker`.
 *
 * Once on disk, stdout and stderr share the file in the order they arrived, the way a terminal shows
 * them. Held in memory they stay apart, which is the shape the result had before this file existed.
 */

import { agentReadableMode, openAppendFile, type AppendFile, type TextFilter } from "@nouride/runtime";
import { createLogger, type SpooledOutput } from "@nouride/shared";
import { SecretMasker } from "@nouride/secrets";

const log = createLogger("tools.exec");

export interface CaptureOptions {
  /** Where the output goes once it is too big to hold. Absent, only the head and tail are kept. */
  spoolPath?: string;
  /** This agent's injected credentials, masked before anything is kept. */
  env: Record<string, string>;
  /**
   * The command prints credentials (`printedSource`): each stream goes through one of these first — every value a handle
   * (`tools/credential-output.ts`) — before the exact masking, and before anything is kept, the file on disk included.
   */
  printed?: () => TextFilter;
  /** Most characters written to disk; past it the command keeps running and the file stops. */
  diskCapChars: number;
  /** Held whole below this. */
  memoryChars?: number;
  /**
   * Kept of each end once the output is on disk.
   *
   * Bigger than any excerpt the spill will cut from it — the largest budget is
   * `MAX_TOOL_RESULT_TOKENS` × 4 chars, split 65/35 — so the spill always has whole lines to choose
   * from at both ends, and this never decides what the model sees.
   */
  excerptChars?: number;
}

export type CapturedOutput =
  | { spooled: false; stdout: string; stderr: string }
  | { spooled: true; excerpt: string; output: SpooledOutput; cappedOnDisk: boolean };

const MEMORY_CHARS = 64 * 1024;
const EXCERPT_CHARS = 48 * 1024;

export class OutputCapture {
  private readonly memoryChars: number;
  private readonly excerptChars: number;
  /** One per stream: a value split across two chunks is split within one stream, never across both. */
  private readonly maskers: Record<"stdout" | "stderr", SecretMasker>;
  /** Per stream too, before the exact values: a line is whole within one stream. */
  private readonly printed: Record<"stdout" | "stderr", TextFilter> | null;

  /** Arrival-ordered, while small. */
  private held: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  private heldChars = 0;

  private spooling = false;
  private file: AppendFile | null = null;
  private head = "";
  private tail = "";
  private chars = 0;
  private newlines = 0;
  private endsWithNewline = false;
  private written = 0;
  private capped = false;
  private failed = false;
  private opened = false;

  constructor(private readonly options: CaptureOptions) {
    this.memoryChars = options.memoryChars ?? MEMORY_CHARS;
    this.excerptChars = options.excerptChars ?? EXCERPT_CHARS;
    this.maskers = { stdout: new SecretMasker(options.env), stderr: new SecretMasker(options.env) };
    this.printed = options.printed ? { stdout: options.printed(), stderr: options.printed() } : null;
  }

  /** Feed a chunk. Shaped to be `SandboxOptions.onOutput`. */
  readonly push = (stream: "stdout" | "stderr", text: string): void => {
    this.accept(stream, this.maskers[stream].push(this.printed ? this.printed[stream].push(text) : text));
  };

  /** Release what the maskers held back and say what was kept. Call once, after the command ends. */
  finish(): CapturedOutput {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.printed ? this.maskers[stream].push(this.printed[stream].end()) : "";
      this.accept(stream, rest + this.maskers[stream].end());
    }

    if (!this.spooling) {
      const join = (stream: "stdout" | "stderr") =>
        this.held.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.text).join("");
      return { spooled: false, stdout: join("stdout"), stderr: join("stderr") };
    }

    this.closeFile();
    this.file = null;
    return {
      spooled: true,
      excerpt: this.excerpt(),
      output: {
        path: this.opened && !this.failed ? (this.options.spoolPath ?? null) : null,
        chars: this.chars,
        // A trailing newline ends the last line rather than starting another: `seq 1 300000` is
        // 300000 lines, and was reported live as 300001.
        lines: this.newlines + (this.endsWithNewline ? 0 : 1),
      },
      cappedOnDisk: this.capped,
    };
  }

  /**
   * Both ends, with the gap said out loud.
   *
   * The spill normally re-cuts this and the marker never shows. It is here for the case where nothing
   * does — a caller with no spill — so that a 96KB head-and-tail is never read as a 96KB output.
   */
  private excerpt(): string {
    const omitted = this.chars - this.head.length - this.tail.length;
    if (omitted <= 0) return this.head + this.tail;
    return `${this.head}\n[… ${omitted} characters in the middle were not kept here …]\n${this.tail}`;
  }

  private accept(stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    if (!this.spooling) {
      this.held.push({ stream, text });
      this.heldChars += text.length;
      if (this.heldChars <= this.memoryChars) return;
      // Outgrown: everything held so far is the start of the file, in the order it arrived.
      this.spooling = true;
      this.openFile();
      const held = this.held;
      this.held = [];
      for (const chunk of held) this.stream(chunk.text);
      return;
    }
    this.stream(text);
  }

  /** One piece of output once spooling: to disk, and through the head or the tail. */
  private stream(text: string): void {
    this.toDisk(text);
    this.chars += text.length;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.newlines += 1;
    if (text) this.endsWithNewline = text.endsWith("\n");

    if (this.head.length < this.excerptChars) {
      const room = this.excerptChars - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    // Only what the head did not take, so the two never overlap: when the whole output fits in both,
    // head + tail *is* the output.
    if (text) this.tail = (this.tail + text).slice(-this.excerptChars);
  }

  private toDisk(text: string): void {
    if (!this.file || this.capped) return;
    const room = this.options.diskCapChars - this.written;
    const piece = text.length > room ? text.slice(0, room) : text;
    try {
      this.file.write(piece);
      this.written += piece.length;
      if (piece.length < text.length) {
        this.capped = true;
        this.file.write(
          `\n[recording stopped here, at the ${this.options.diskCapChars}-character cap. The command ` +
            "kept running, and its last lines are in the tool result]\n",
        );
      }
    } catch (err) {
      // A full disk mid-command. What is on disk is now a prefix that reads as the whole output, so
      // the file is not named at all — the excerpt is the honest remainder.
      log.warn("could not write a spool file, so keeping the head and tail only", { error: String(err) });
      this.closeFile();
      this.file = null;
      this.failed = true;
    }
  }

  private openFile(): void {
    if (!this.options.spoolPath) return;
    try {
      // The agent is handed this path (`Full output:`) and greps it with a command, which runs as its own user where
      // the helper is: the mode its job logs have, readable by it through its folder's group.
      this.file = openAppendFile(this.options.spoolPath, agentReadableMode());
      this.opened = true;
    } catch (err) {
      // Not a failed command: the head and tail are still the most useful thing there is, and the
      // spill will tell the model the file is missing rather than naming a path that is not there.
      log.warn("could not open a spool file, so keeping the head and tail only", { error: String(err) });
      this.file = null;
    }
  }

  private closeFile(): void {
    try {
      this.file?.close();
    } catch (err) {
      log.warn("could not close a spool file", { error: String(err) });
    }
  }
}
