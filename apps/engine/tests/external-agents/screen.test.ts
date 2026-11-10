/**
 * What a sign-in's page reads (0.8.8): the terminal drawn, not its bytes with the escapes cut out. The fixtures are Claude
 * Code's `setup-token` (v2.1.309, through `claude-agent-acp` 0.95.0) run on the box the way the daemon runs it — in
 * `script(1)`, with a throwaway profile — and answered with a made-up code: once ended with a line feed (nothing
 * happened), once with a carriage return (the request failed), then Enter alone (it asked again). On the dashboard every
 * space was missing: "Thiswillguideyouthroughlong-lived(1-year)…".
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Screen } from "@/modules/external-agents/screen.ts";
import { CliLogin } from "@/modules/external-agents/login.ts";
import { newOutput } from "../../../cli/src/commands/external-clis.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const LF = fixture("claude-setup-token-lf.out");
const REJECTED = fixture("claude-setup-token-cr-rejected.out");
const ENTER = fixture("claude-setup-token-cr-enter.out");
const LINK = /https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/g;

function drawn(...writes: string[]): string {
  const screen = new Screen();
  for (const text of writes) screen.write(text);
  return screen.text();
}

describe("Claude Code's setup-token, as its terminal showed it", () => {
  test("its words are apart where it drew each space as a jump to a column", () => {
    const text = drawn(LF);
    expect(text).toContain("Welcome to Claude Code v2.1.309");
    expect(text).toContain(" This will guide you through long-lived (1-year) auth token setup for your Claude account. Claude subscription required.");
    expect(text).toContain(" Browser didn't open? Use the url below to sign in (c to copy)");
    expect(text).not.toContain("Thiswill");
    // The code the line feed never submitted, masked on the prompt's own row.
    expect(text).toContain(` Paste code here if prompted > ${"*".repeat(58)}`);
    expect(text.match(LINK)).toHaveLength(1);
  });

  test("what it drew over an earlier row reads whole, a letter it left standing there included", () => {
    // "Requ", a jump over the `e` that "open?" left in that cell, then "st".
    expect(REJECTED).toContain("Requ\x1b[20Gst");
    const text = drawn(REJECTED);
    expect(text).toContain(" OAuth error: Request failed with status code 400");
    expect(text).toContain(" Press Enter to retry.");
    // The rows it erased are gone: the link it cleared, and the masked code.
    expect(text.match(LINK)).toBeNull();
    expect(text).not.toContain("*****");
  });

  test("Enter after the error asks again: the error is gone and a new link and the prompt are drawn", () => {
    const text = drawn(REJECTED, ENTER);
    expect(text).not.toContain("OAuth error");
    expect(text.match(LINK)).toHaveLength(1);
    expect(text).toContain(" Paste code here if prompted >");
  });

  test("the same, however the output is cut into reads — an escape split between two", () => {
    const whole = drawn(REJECTED, ENTER);
    const all = REJECTED + ENTER;
    for (const size of [1, 3, 7, 64]) {
      const pieces: string[] = [];
      for (let at = 0; at < all.length; at += size) pieces.push(all.slice(at, at + size));
      expect(drawn(...pieces)).toBe(whole);
    }
  });

  test("a sign-in's page reads it so, with the link it can open", () => {
    const chunks = [REJECTED.slice(0, REJECTED.indexOf("\r\u001b[31C"))];
    const proc = { tty: true, drain: () => chunks.shift() ?? "", exited: new Promise<number>(() => {}), write: () => {}, kill: () => {} };
    const view = new CliLogin(proc as never, "sk-ant-oat01-").view();
    expect(view.output).toContain("This will guide you through long-lived (1-year) auth token setup");
    expect(view.output).toContain("Paste code here if prompted >");
    expect(view.links).toHaveLength(1);
    expect(view.links[0]).toStartWith("https://claude.com/cai/oauth/authorize?code=true&client_id=");
  });
});

describe("a terminal drawn", () => {
  test("a carriage return redraws its row, a backspace steps back, an erase clears to the end of the row", () => {
    expect(drawn("Waiting |\rWaiting /\rWaiting -")).toBe("Waiting -");
    expect(drawn("abc\bX")).toBe("abX");
    expect(drawn("one two three\r\x1b[4C\x1b[K2")).toBe("one 2");
  });

  test("a row redrawn from below is drawn where it was, and the rows below it are kept", () => {
    expect(drawn("a\r\nb\r\nc\r\n\x1b[2Aquick\x1b[1B\rend")).toBe("a\nquick\nend");
  });

  test("colours, modes and the terminal's queries draw nothing; a link shows the text it was printed with", () => {
    expect(drawn("\x1b[?25l\x1b[1;32mok\x1b[0m \x1b]8;;https://a.test\x07https://a.test\x1b]8;;\x07\x1b[c\x1b(B")).toBe("ok https://a.test");
  });

  test("a line of Nouride's own goes on a row of its own, and a control character in it draws nothing", () => {
    const screen = new Screen();
    screen.write("Paste the code > ");
    screen.note("Opened the address on this box: 200\x1b[2J");
    screen.write("next");
    expect(screen.text()).toBe("Paste the code >\nOpened the address on this box: 200[2J\nnext");
  });

  test("a cursor sent far off, or blanks pushed in without end, make no page that size", () => {
    expect(drawn("\x1b[99999999C\x1b[99999999Bx").length).toBeLessThan(25_000);
    expect(drawn(`ab\x1b[1G${"\x1b[20000@".repeat(1000)}`).length).toBeLessThan(25_000);
  });

  test("no escape costs more than a row's work: a read full of far moves is drawn in well under a second (Nox's review)", () => {
    // 256 KiB, one read's worth: `ESC[20000d` took 4.6 s, `ESC[20000;1H` 3.3 s, inserts on a full row 2.5 s.
    const full = `${"x".repeat(1999)}\x1b[1G`;
    // Measured alone after the fix: 7 to 30 ms each.
    for (const [setup, escape] of [["", "\x1b[20000d"], ["", "\x1b[20000;1H"], ["", "\x1b[20000B"], ["", "\n"], [full, "\x1b[20000@"], [full, "\x1b[1999@"], [full, "\x1b[1@"], [full, "\x1b[1999P"], [full, "\x1b[1999X"], [full, "\x1b[2000G\x1b[1K"]] as const) {
      const screen = new Screen();
      screen.write(setup);
      const read = escape.repeat(Math.ceil((256 * 1024) / escape.length));
      const started = performance.now();
      screen.write(read);
      screen.text();
      expect({ escape, slow: performance.now() - started > 500 }).toEqual({ escape, slow: false });
    }
  });

  test("a row is 2,000 cells, four times the sign-in's terminal: a move past it stops at its edge (Nox's review)", () => {
    // At 20,000 a row, a thousand rows held 20M cells: 369 MiB for one sign-in.
    expect(drawn("\x1b[3000Gx")).toBe(`${" ".repeat(1999)}x`);
  });

  test("a character beyond the first 65,536 is one cell: drawn over, it leaves no half behind (Nox's review)", () => {
    expect(drawn("a😀b\x1b[2Gc")).toBe("acb");
  });

  test("a line longer than a row goes on in the next and reads as one line", () => {
    expect(drawn(`${"a".repeat(5000)}\r\nb`)).toBe(`${"a".repeat(5000)}\nb`);
  });

  test("a line made longer by what is hidden in it keeps the rows it had (Nox's review)", () => {
    const screen = new Screen();
    screen.write("fk-tok-.".repeat(1750));
    screen.redact(/fk-tok-[A-Za-z0-9_-]*/g, () => "[saved to Nouride's secret store]");
    const text = screen.text();
    expect(text.length).toBe(14_000);
    expect(text).toStartWith("[saved to Nouride's secret store].[saved");
  });

  test("asked for its end, it draws only the last whole rows that hold it", () => {
    const screen = new Screen();
    screen.write("first row\r\nsecond\r\nthird");
    expect(screen.text(8)).toBe("second\nthird");
    expect(screen.text()).toBe("first row\nsecond\nthird");
  });
});

describe("a token-printing sign-in's page", () => {
  const login = (...chunks: string[]) => {
    let end = (_code: number) => {};
    const proc = { tty: true, drain: () => chunks.shift() ?? "", exited: new Promise<number>((done) => void (end = done)), write: () => {}, kill: () => {} };
    return { login: new CliLogin(proc as never, "fk-tok-"), end: (code: number) => end(code) };
  };

  test("shows no token whose prefix came apart — a cell the CLI skipped that this screen does not hold (Nox's review)", async () => {
    // Drawn as if the row already held " Paste": the CLI skips the `t` it thinks is there. Here the row is empty.
    const { login: signIn, end } = login(`Open https://a.test/x?code_challenge=${"C".repeat(43)}\r\n\x1b[2;2Hfk-\x1b[2;6Hok-AAAABBBBCCCCDDDDEEEEFFFF\x1b[K\r\n Store it safely.\r\n`);
    const shown = signIn.view();
    expect(shown.output).toContain(" fk- [hidden]");
    expect(shown.output).not.toContain("AAAABBBB");
    // The link's own long runs stay: it opens.
    expect(shown.links).toEqual([`https://a.test/x?code_challenge=${"C".repeat(43)}`]);
    end(0);
    await signIn.exited;
    const ended = signIn.view();
    expect(ended).toMatchObject({ exitCode: 0, signedIn: false });
    expect(ended.output).not.toContain("AAAABBBB");
    expect(ended.output).toContain("Nouride found no token in what it printed, so nothing was kept.");
  });

  test("takes no token a gap came inside: the part before the gap is not the token (Nox's review)", async () => {
    const { login: signIn, end } = login(`\x1b[2Gfk-tok-${"A".repeat(20)}\x1b[30G${"B".repeat(30)}\r\n`);
    end(0);
    await signIn.exited;
    expect(signIn.token()).toBeNull();
    expect(signIn.view()).toMatchObject({ signedIn: false });
    expect(signIn.view().output).not.toContain("BBBB");
  });

  test("hides a token printed across a row's edge whole, and takes it whole", async () => {
    // A line on pipes longer than a row: the token starts ten cells before its edge.
    const { login: signIn, end } = login(`${"word ".repeat(398)}fk-tok-${"Q".repeat(20)}\r\n`);
    expect(signIn.view().output).not.toContain("QQQ");
    end(0);
    await signIn.exited;
    expect(signIn.view().output).not.toContain("QQQ");
    expect(signIn.token()).toBe(`fk-tok-${"Q".repeat(20)}`);
  });
});

describe("`nouride agents login`, printing the screen as it changes", () => {
  test("prints what was added, and again from the first line drawn anew — never the whole screen twice over", () => {
    expect(newOutput("", "Open x\nPaste >")).toBe("Open x\nPaste >");
    expect(newOutput("Open x\nPaste >", "Open x\nPaste > ****")).toBe(" ****");
    expect(newOutput("Open x\nPaste > ****\n", "Open x\nError: refused\n")).toBe("Error: refused\n");
    // Redrawn at the same length: printed, where reading it as a stream printed nothing.
    expect(newOutput("Open x\nWaiting |", "Open x\nWaiting /")).toBe("\nWaiting /");
  });
});
