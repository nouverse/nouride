/**
 * Signing an external agent's CLI in: the row's `login` words, run in a terminal on the box as
 * the agent's user, pointed at the agent's profile — so the sign-in lands where that agent's CLI reads it, and two
 * agents on one CLI hold two accounts. A box has no browser: the CLI prints a link, and a code where its flow has one,
 * and the person answers from the dashboard or `nouride agents login`, a line at a time.
 *
 * What the terminal shows is kept here, in memory and for this sign-in only — never logged: what a person pastes back
 * is a one-time code, and a terminal echoes it. A sign-in that ends by printing a token (an account's, shared by its
 * agents) never shows it: it is cut from what the page sees as it arrives, and taken when the sign-in ends.
 */

import type { InteractiveProcess } from "@nouride/runtime";
import { contained, createLogger } from "@nouride/shared";
import { Screen } from "./screen.ts";

const log = createLogger("external-agents.login");

/** What a sign-in's page shows of the terminal: the end of it, which is where the link and the question are. */
const KEPT_CHARS = 16_000;
/**
 * How long after a line's words its Enter is written, in a terminal. Claude Code's `setup-token` took a code and an
 * Enter written 300 ms apart as a line, and the two written together as a paste (measured on a Linux box).
 */
const ENTER_AFTER_MS = 300;
const LINK = /https?:\/\/[^\s"'<>`]+/g;

export interface LoginView {
  running: boolean;
  /** What the terminal printed, as text. */
  output: string;
  /** Each link it printed, once, in order — the one to open is usually the last. */
  links: string[];
  /** What it exited with; null while it runs. */
  exitCode: number | null;
  /** Whether it ended signed in: exited 0, not stopped, and — where it ends by printing a token — the token was taken. */
  signedIn: boolean;
  /**
   * Stopped by Nouride — a person's Stop, or nobody finishing it — which is never a sign-in, whatever it exited with:
   * on Linux `script(1)` ends 0 when what it runs is killed (seen with omp's login on the box), on a Mac 143.
   */
  stopped: boolean;
}

/** A sign-in as the Brain tab and the Models page drive it: one in a terminal (`CliLogin`), or in a CLI's ACP mode. */
export interface SignIn {
  readonly running: boolean;
  readonly exited: Promise<number>;
  /** Whether it ended signed in, as `LoginView.signedIn` says. */
  readonly signedIn: boolean;
  view(): LoginView;
  /** A line the person typed, as the sign-in's next input — Enter alone where it is empty. */
  answer(text: string): void;
  /** A line of Nouride's own in what the page shows — what opening a pasted address did. */
  say(line: string): void;
  stop(): void;
  token(): string | null;
}

/** What a sign-in that prints a token looks for: its prefix, and the characters a token is made of after it. */
const TOKEN_CHARS = "[A-Za-z0-9_-]";

/** What a token is shown as. */
const SAVED = "[saved to Nouride's secret store]";

/**
 * On a sign-in that prints a token, a run of token characters this long is not shown either, outside a link: a token
 * whose prefix came apart — a cell the CLI skipped as already drawn, which the screen here does not hold — matches no
 * prefix, and its body would show (0.8.8). A link's own long runs (`code_challenge`, `state`) stay, so it
 * opens. Shorter than a token's tail could be after such a gap near its end.
 */
const TOKEN_LIKE = new RegExp(`${LINK.source}|${TOKEN_CHARS}{24,}`, "g");
const MASKED = "[hidden]";

export class CliLogin implements SignIn {
  /**
   * What the terminal shows, a token in it too until the sign-in ends: hidden from every view as a whole, never cut
   * first — a token that arrived in two drains was cut from the first, and its second half reached the page (0.8.1).
   */
  private readonly screen = new Screen();
  private code: number | null = null;
  private stoppedHere = false;
  /** The token it printed, taken when it ended and held until `token()` hands it over. */
  private taken: string | null = null;
  private tokenFound = false;
  private readonly hidden: RegExp | null;

  constructor(
    private readonly proc: InteractiveProcess,
    /** A sign-in that ends by printing a token beginning with this: hidden from the page, and read with `token()`. */
    private readonly tokenPrefix?: string,
  ) {
    this.hidden = tokenPrefix ? new RegExp(`${tokenPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${TOKEN_CHARS}*`, "g") : null;
    // Its first word on the end, ahead of the caller's: no view sees it ended before its token is taken.
    void proc.exited.then(
      (code) => this.ended(code),
      () => this.ended(-1),
    );
  }

  get running(): boolean {
    return this.code === null;
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  get signedIn(): boolean {
    return this.code === 0 && !this.stoppedHere && (!this.hidden || this.tokenFound);
  }

  view(): LoginView {
    this.screen.write(this.proc.drain());
    // Whole lines, a token's with its prefix: hidden, then cut to the end the page keeps — never the tail of one alone.
    const output = this.hide(this.screen.text(2 * KEPT_CHARS)).slice(-KEPT_CHARS);
    return { running: this.running, output, links: [...new Set(output.match(LINK) ?? [])], exitCode: this.code, signedIn: this.signedIn, stopped: this.stoppedHere };
  }

  /** What a token-printing sign-in shows of `text`: each token as saved, and any run that could be one's body hidden. */
  private hide(text: string): string {
    return this.hidden ? text.replace(this.hidden, SAVED).replace(TOKEN_LIKE, masked) : text;
  }

  /**
   * At its end: what was left to read is drawn, and a token it printed is taken — the screen keeps only its mark. One
   * that exited 0 with no token kept nothing, and says so: the page showed nothing at all, as though it had worked.
   */
  private ended(code: number): void {
    // Ended first, whatever drawing the rest does: a throw there left it running for good.
    this.code = code;
    this.screen.write(this.proc.drain());
    if (!this.hidden) return;
    // Taken only where it ends its line, as the CLIs this knows print it: a cell inside it that this screen does not hold
    // ends the match there, and the shortened token was kept as though it were the whole.
    const found =
      [...this.screen.text().matchAll(this.hidden)]
        .filter((match) => match[0].length > (this.tokenPrefix?.length ?? 0) + 16 && /^[ \t]*(\n|$)/.test(match.input.slice(match.index + match[0].length)))
        .map((match) => match[0])
        .at(-1) ?? null;
    this.screen.redact(this.hidden, () => SAVED);
    this.screen.redact(TOKEN_LIKE, masked);
    this.taken = found;
    this.tokenFound = found !== null;
    if (code === 0 && !this.stoppedHere && !found) this.say("Nouride found no token in what it printed, so nothing was kept. Start the sign-in again.");
  }

  /**
   * The token it printed, once it ended — null before that, where it printed none, or once taken: it then lives only
   * where the caller keeps it.
   */
  token(): string | null {
    const token = this.taken;
    this.taken = null;
    return token;
  }

  say(line: string): void {
    this.screen.write(this.proc.drain());
    this.screen.note(line);
  }

  /**
   * A line the person typed — the code, a choice — as the terminal's next input, ended as Enter is where it goes. A
   * terminal sends a carriage return: a program reading lines gets its line feed from the terminal (ICRNL), and one in
   * raw mode submits on nothing else — Claude Code's `setup-token` took a line feed as a character, and the code it was
   * sent sat in its field (0.8.8). On pipes no terminal turns one into the other, and a line feed ends the line. Empty,
   * it is Enter alone: "Press Enter to retry".
   *
   * In a terminal the words and their Enter are two writes, a moment apart. A terminal UI takes a burst of characters
   * as a paste, and an Enter that comes with them as part of what was pasted: sent together, the code sat in the field
   * of Claude Code's `setup-token` as stars, the page said "Sent", and nothing moved until Enter was pressed by itself.
   */
  answer(text: string): void {
    if (!this.running) throw new Error("the sign-in has ended");
    const line = text.replace(/[\r\n]+/g, "");
    if (!this.proc.tty) return void this.proc.write(`${line}\n`);
    if (line === "") return void this.proc.write("\r");
    this.proc.write(line);
    setTimeout(
      contained(log, "could not press Enter after a sign-in's line", () => {
        if (this.running && !this.stoppedHere) this.proc.write("\r");
      }),
      ENTER_AFTER_MS,
    );
  }

  stop(): void {
    if (!this.running) return;
    this.stoppedHere = true;
    this.proc.kill("SIGTERM");
  }
}

/** A run that could be a token's body, hidden; a link, as it is. */
const masked = (run: string): string => (/^https?:\/\//.test(run) ? run : MASKED);
