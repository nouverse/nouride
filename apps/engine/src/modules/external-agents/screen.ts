/**
 * What a sign-in's terminal shows, drawn from what the CLI wrote to it (0.8.8) — the page reads this, not the bytes.
 *
 * A terminal UI draws with the cursor. Claude Code's `setup-token` puts the space between two words as a jump to a
 * column (`ESC[9G`), and skips a cell the screen already holds the right letter in, on whichever row of its last frame
 * that was: its "OAuth error: Request failed" arrived as `Requ`, a jump over the `e` of the "open?" drawn there before,
 * and `st`. With the escapes cut out, the page read "Thiswillguideyouthrough…" (seen on the dashboard, 0.8.8) and would
 * have read "Requst". Drawn on a grid of cells, it reads as it did on a screen — and a token printed over an earlier
 * row is whole, where a cut stream would have split it at a skipped cell and shown its tail.
 *
 * A page with no bottom: rows the cursor left are kept, as a log keeps them, up to `MAX_ROWS`. A line feed starts the
 * next row at its first column — what `script(1)`'s terminal makes of one (onlcr) and what a program on pipes means by
 * one. A row is at most `MAX_COLS` cells; a longer line goes on in the next row and still reads as one line, so a token
 * printed across the edge is hidden whole. Colours, modes, titles and the terminal queries a UI sends are dropped; what
 * moves the cursor or erases is followed: CR LF BS TAB, `CSI` A B C D E F G H d f J K X P @ s u, `ESC 7` and `ESC 8`.
 * A move is held to the screen it is made on (`HEIGHT` rows, `MAX_COLS` cells), so no escape costs more than a row's
 * work: a read of `ESC[20000d` cost seconds before (Nox's review, 0.8.8).
 */

/** Rows kept; the oldest go first, a hundred at a time. A sign-in prints a few dozen. */
const MAX_ROWS = 1000;
const TRIM = 100;
/** Cells in a row: four times the sign-in's terminal (`stty cols 500`), so a line drawn there is one row here. */
const MAX_COLS = 2000;
/** The rows a sign-in's terminal is set to (`accountLaunch`): where an absolute row (`CSI H`, `CSI d`) counts from. */
const HEIGHT = 50;
/** An escape left open at the end of a write waits for the next; one longer than this was never going to close. */
const MAX_PENDING = 8192;

const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
const CSI_OPEN = /\x1b\[[0-?]*[ -/]*$/y;
/** OSC (a title, a hyperlink), DCS, SOS, PM and APC: a string ended by BEL or ST — what a link shows is printed apart. */
const STRING = /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const STRING_OPEN = /\x1b[\]PX^_][^\x07\x1b]*\x1b?$/y;
/** Any other escape: intermediates, then one final character — a character set, a keypad mode, save and restore. */
const SHORT = /\x1b[ -/]*[0-~]/y;
const SHORT_OPEN = /\x1b[ -/]*$/y;

/** A row's cells, and whether it goes on from the row above: a line longer than a row, wrapped. */
interface Row {
  cells: (string | undefined)[];
  wrapped: boolean;
}

const blank = (): Row => ({ cells: [], wrapped: false });
const drawn = (row: Row): string => Array.from(row.cells, (cell) => cell ?? " ").join("");

export class Screen {
  private rows: Row[] = [blank()];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private pending = "";

  write(text: string): void {
    const input = this.pending + text;
    this.pending = "";
    let at = 0;
    while (at < input.length) {
      if (input[at] === "\x1b") {
        const used = this.escape(input, at);
        if (used === 0) {
          const open = input.slice(at);
          if (open.length <= MAX_PENDING) this.pending = open;
          return;
        }
        at += used;
        continue;
      }
      const code = input.codePointAt(at)!;
      const char = String.fromCodePoint(code);
      at += char.length;
      if (char === "\r") this.col = 0;
      else if (char === "\n" || char === "\v" || char === "\f") this.lineFeed();
      else if (char === "\b") this.col = Math.max(0, this.col - 1);
      else if (char === "\t") this.col = Math.min(MAX_COLS, (Math.floor(this.col / 8) + 1) * 8);
      else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) this.put(char);
    }
  }

  /**
   * What it shows: each line as text, its trailing blanks and the empty lines at the end left out. With `atLeast`, only
   * the last whole lines holding that many characters: what a page keeps, without drawing every row on each look.
   */
  text(atLeast = Infinity): string {
    const lines: string[] = [];
    let chars = 0;
    let below = "";
    for (let at = this.rows.length - 1; at >= 0 && chars < atLeast; at--) {
      const row = this.rows[at]!;
      below = drawn(row) + below;
      if (row.wrapped && at > 0) continue;
      const line = below.trimEnd();
      lines.push(line);
      chars += line.length + 1;
      below = "";
    }
    return lines.reverse().join("\n").replace(/\n+$/, "");
  }

  /**
   * Every match of `pattern` (global) in a line, replaced by what `by` makes of it — what a token leaves behind. The
   * line keeps the rows it had: a longer one is cut at their end, never grown past them (Nox's review: a line of bare
   * prefixes, each made a longer mark, grew one row without end).
   */
  redact(pattern: RegExp, by: (match: string) => string): void {
    for (let first = 0; first < this.rows.length; ) {
      let last = first;
      while (last + 1 < this.rows.length && this.rows[last + 1]!.wrapped) last += 1;
      const line = this.rows.slice(first, last + 1).map(drawn).join("");
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        const cells = Array.from(line.replace(pattern, by));
        for (let at = first; at <= last; at++) this.rows[at]!.cells = cells.slice((at - first) * MAX_COLS, (at - first + 1) * MAX_COLS);
      }
      first = last + 1;
    }
  }

  /** A line of Nouride's own, on a row of its own below where the cursor is. */
  note(line: string): void {
    if (this.col > 0 || (this.rows[this.row]?.cells.length ?? 0) > 0) this.lineFeed();
    for (const char of line.replace(/[\x00-\x1f\x7f-\x9f]/g, "")) this.put(char);
    this.lineFeed();
  }
  /** How many characters the escape at `at` is, having followed it; 0 where it is not complete yet. */
  private escape(input: string, at: number): number {
    for (const [whole, open] of [[CSI, CSI_OPEN], [STRING, STRING_OPEN]] as const) {
      whole.lastIndex = at;
      const found = whole.exec(input);
      if (found) {
        if (whole === CSI) this.control(found[1]!, found[2]!);
        return found[0].length;
      }
      open.lastIndex = at;
      if (open.test(input)) return 0;
    }
    SHORT.lastIndex = at;
    const found = SHORT.exec(input);
    if (!found) {
      SHORT_OPEN.lastIndex = at;
      // Not an escape after all: the ESC alone is dropped.
      return SHORT_OPEN.test(input) ? 0 : 1;
    }
    if (found[0] === "\x1b7") this.saved = { row: this.row, col: this.col };
    else if (found[0] === "\x1b8") this.restore();
    return found[0].length;
  }

  private control(params: string, final: string): void {
    // A private one (`?25l`, `>0q`, `?2004h`) sets a mode or asks the terminal something: nothing it shows.
    if (/^[<=>?]/.test(params)) return;
    const args = params.split(";").map((arg) => Math.min(Number.parseInt(arg, 10) || 0, MAX_COLS));
    const n = Math.max(1, args[0] ?? 0);
    const top = Math.max(0, this.rows.length - HEIGHT);
    switch (final) {
      case "A": this.row = Math.max(0, this.row - n); break;
      case "B": case "e": this.down(n); break;
      case "C": case "a": this.col = Math.min(MAX_COLS, this.col + n); break;
      case "D": this.col = Math.max(0, this.col - n); break;
      case "E": this.down(n); this.col = 0; break;
      case "F": this.row = Math.max(0, this.row - n); this.col = 0; break;
      case "G": case "`": this.col = Math.min(MAX_COLS, n - 1); break;
      case "H": case "f": this.goTo(top + Math.min(n, HEIGHT) - 1); this.col = Math.min(MAX_COLS, Math.max(1, args[1] ?? 0) - 1); break;
      case "d": this.goTo(top + Math.min(n, HEIGHT) - 1); break;
      case "J": this.eraseScreen(args[0] ?? 0, top); break;
      case "K": this.eraseLine(args[0] ?? 0); break;
      case "X": this.cells().fill(undefined, this.col, this.col + n); break;
      case "P": this.cells().splice(this.col, n); break;
      case "@": this.insert(n); break;
      case "s": if (params === "") this.saved = { row: this.row, col: this.col }; break;
      case "u": if (params === "") this.restore(); break;
      default: break;
    }
  }

  private eraseLine(mode: number): void {
    const cells = this.cells();
    if (mode === 0) cells.length = Math.min(cells.length, this.col);
    else if (mode === 1) cells.fill(undefined, 0, this.col + 1);
    else this.rows[this.row] = blank();
  }

  private eraseScreen(mode: number, top: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      this.rows.length = this.row + 1;
    } else if (mode === 1) {
      for (let row = top; row < this.row; row++) this.rows[row] = blank();
      this.eraseLine(1);
    } else for (let row = top; row < this.rows.length; row++) this.rows[row] = blank();
  }

  /** Blanks pushed in at the cursor, the row kept to `MAX_COLS`: what is pushed past it is gone, as off a screen's edge. */
  private insert(n: number): void {
    const cells = this.cells();
    if (n >= MAX_COLS - this.col) {
      cells.length = Math.min(cells.length, this.col);
      return;
    }
    if (cells.length <= this.col) return;
    const end = Math.min(cells.length + n, MAX_COLS);
    cells.length = end;
    cells.copyWithin(this.col + n, this.col, end - n);
    cells.fill(undefined, this.col, this.col + n);
  }

  private put(char: string): void {
    if (this.col >= MAX_COLS) {
      this.lineFeed();
      this.rows[this.row]!.wrapped = true;
    }
    this.cells()[this.col] = char;
    this.col += 1;
  }

  private lineFeed(): void {
    this.down(1);
    this.col = 0;
  }

  /** Down a row or more, on the screen it is made on: past its bottom it is the bottom row's next. */
  private down(n: number): void {
    this.goTo(this.row + Math.min(n, HEIGHT));
  }

  private goTo(row: number): void {
    while (this.rows.length <= row) this.rows.push(blank());
    this.row = row;
    const over = this.rows.length - MAX_ROWS;
    if (over >= TRIM) {
      this.rows.splice(0, over);
      this.rows[0]!.wrapped = false;
      this.row = Math.max(0, this.row - over);
      this.saved = { row: Math.max(0, this.saved.row - over), col: this.saved.col };
    }
  }

  private restore(): void {
    this.goTo(this.saved.row);
    this.col = this.saved.col;
  }

  private cells(): (string | undefined)[] {
    return (this.rows[this.row] ??= blank()).cells;
  }
}
