/**
 * A shared sign-in drawn as a terminal UI in raw mode, for the sign-in tests — the way Claude Code's `setup-token` draws
 * (0.8.8, captured on the box): spaces as jumps to a column, a cell the screen already holds skipped, and a submit on a
 * carriage return only — a line feed is taken as nothing, and the code sits in the field.
 *
 * `CODE123` prints the token over the prompt's row, skipping the cell where that row already holds the token's `t`, and
 * exits 0; anything else says the request failed and waits for Enter to ask again. With `--no-token`, a right code
 * exits 0 having printed none.
 */

const TOKEN_TAIL = "AAAABBBBCCCCDDDDEEEEFFFF";
const out = (text: string) => process.stdout.write(text);
// Row 0 the link, row 2 the prompt; the cursor waits on row 3.
const prompt = () => out("\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\n");

process.stdin.setRawMode(true);
process.on("SIGTERM", () => process.exit(0));
out("\x1b[?2004h\x1b[2GOpen\x1b[7Ghttps://login.example.test/token?c=1\x1b[44Gand\x1b[48Gsign\x1b[53Gin\r\n\r\n");
prompt();

let field = "";
let failed = false;
process.stdin.on("data", (data: Buffer) => {
  for (const ch of data.toString()) {
    if (ch === "\n") continue;
    if (ch !== "\r") {
      field += ch;
      out(`\r\x1b[31C\x1b[1A${"*".repeat(field.length)}\r\n`);
      continue;
    }
    if (failed) {
      if (field) continue;
      failed = false;
      out("\x1b[3A\r\x1b[J\x1b[2GRetrying…\r\n");
      out("\x1b[1A\r\x1b[2K");
      prompt();
      continue;
    }
    const code = field;
    field = "";
    if (code !== "CODE123") {
      failed = true;
      out("\x1b[1A\r\x1b[2K\x1b[2GOAuth\x1b[8Gerror:\x1b[15GRequest\x1b[23Gfailed\x1b[30Gwith\x1b[35Gstatus\x1b[42Gcode\x1b[47G400\r\n\r\n\x1b[2GPress\x1b[8GEnter\x1b[14Gto\x1b[17Gretry.\r\n");
      continue;
    }
    if (process.argv.includes("--no-token")) out("\r\n\x1b[2GDone.\r\n");
    // " Paste…" holds a `t` in column 5, as `fk-tok-` does: that cell is not drawn again.
    else out(`\x1b[1A\x1b[2Gfk-\x1b[6Gok-${TOKEN_TAIL}\x1b[K\r\n\x1b[2GStore\x1b[8Git\x1b[11Gsafely.\r\n`);
    setTimeout(() => process.exit(0), 200);
  }
});
