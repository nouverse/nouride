/**
 * What the shipped `document-authoring` skill holds an agent to before a PDF reaches anyone (0.8.12). It treated a
 * silent compile log as the finish line, and a log cannot see what a document says: the template's own title, a `??`
 * for a reference, Indonesian headings over an English body all compile clean. The same rule as motion-graphics —
 * nothing is sent before it is looked at — with the pages rendered and read.
 *
 * And `texbuild.py` (0.8.12, after Nouva rated the skill's LaTeX errors as pages a small model cannot debug): one
 * command that compiles, names each problem by its line, and renders the pages. A real tectonic run showed what its own
 * output leaves out — an unresolved `\ref` or `\cite` (`??` in the PDF), a float too large for the page, a class
 * option the class ignored — so the helper reads the TeX log as well. Held here with a stand-in `tectonic` that
 * replays what the real one printed and wrote, so it runs where TeX is not installed.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@nouride/persona";

const DIR = join(import.meta.dir, "../../../../content/skills/document-authoring");
const source = readFileSync(join(DIR, "SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const skill = source.replace(/\s+/g, " ");
const TEXBUILD = join(DIR, "scripts/texbuild.py");

test("findings: none is half of done: the pages are rendered and read before the PDF is sent", () => {
  expect(skill).toContain("`findings: none` is half of done.");
  expect(skill).toContain("**Nothing is sent before it is looked at.** texbuild rendered the pages and printed their paths");
  expect(skill).toContain("`read` each picture");
  expect(skill).not.toContain("A silent log is the finish line");
});

test("the look comes after the findings and before the send", () => {
  const log = skill.indexOf("Fix each and run again until it says `findings: none`");
  const look = skill.indexOf("**Nothing is sent before it is looked at.**");
  const send = skill.indexOf("send it with `send_file`");
  expect(log).toBeGreaterThan(-1);
  expect(look).toBeGreaterThan(log);
  expect(send).toBeGreaterThan(look);
});

test("needs send_file, the tool it sends the PDF with", () => {
  // `needs_tools` is what tells an agent without the tool, and the Skills page, that this one would fail partway.
  expect(parseFrontmatter(source).fields.needs_tools?.split(/,\s*/)).toContain("send_file");
});

test("a fix is looked at again: the PDF sent is the one looked at last", () => {
  // Live (0.8.12): Nouva rendered and read the flyer's page, edited the source, compiled it, found the grep silent and
  // sent it — the skill said exactly that — so the page that went out was one nobody had seen.
  expect(skill).toContain("Once what you saw is fixed and compiled again, **render and read those pages again**");
  expect(skill).toContain("The PDF you send is the one you looked at last.");
});

describe("texbuild.py", () => {
  // The Python that runs the tests, by its real path: the stand-ins below run with PATH holding only their folder.
  const PY = execFileSync("python3", ["-c", "import sys; print(sys.executable)"]).toString().trim();

  /** A folder with a stand-in `tectonic` (and `pdfinfo`) that replays a recorded run: what it printed, its log, a PDF. */
  function bench(run: { printed: string; log?: string; pdf?: boolean; code: number }) {
    const dir = mkdtempSync(join(tmpdir(), "texbuild-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "run.json"), JSON.stringify(run));
    writeFileSync(join(bin, "tectonic"), `#!${PY}
import json, os, sys
run = json.load(open(${JSON.stringify(join(dir, "run.json"))}))
a = sys.argv[1:]; out = a[a.index("--outdir") + 1]; stem = os.path.splitext(a[2])[0]
assert "--keep-logs" in a, "the TeX log is where unresolved references are"
if run.get("log") is not None: open(os.path.join(out, stem + ".log"), "w").write(run["log"])
if run.get("pdf"): open(os.path.join(out, stem + ".pdf"), "wb").write(b"%PDF-1.5 stand-in")
sys.stdout.write(run["printed"]); sys.exit(run["code"])
`);
    writeFileSync(join(bin, "pdfinfo"), `#!${PY}\nprint("Pages:          1")\n`);
    chmodSync(join(bin, "tectonic"), 0o755);
    chmodSync(join(bin, "pdfinfo"), 0o755);
    return dir;
  }
  const texbuild = (dir: string, file: string, ...args: string[]) =>
    spawnSync(PY, [TEXBUILD, join(dir, file), "--no-render", ...args], { env: { PATH: join(dir, "bin") } });

  test("it names what tectonic's own output leaves out: ?? references, a float too large, an ignored class option", () => {
    // Recorded from tectonic 0.15: none of the last four is in what it printed, and it exited 0.
    const dir = bench({
      code: 0,
      pdf: true,
      printed: [
        'note: "version 2" Tectonic command-line interface activated',
        "warning: paper.tex:7: Missing character: There is no \uFFFD\uFFFD\uFFFD (U+26A0) in font [lmroman10-regular]:mapping=tex-text;!",
        "warning: paper.tex:8: Overfull \\hbox (426.70001pt too wide) in paragraph at lines 3--8",
        'note: Rerunning TeX because "paper.aux" changed ...',
        "warning: paper.tex:8: Overfull \\hbox (426.70001pt too wide) in paragraph at lines 3--8",
        "warning: warnings were issued by the TeX engine; use --print and/or --keep-logs for details.",
        "",
      ].join("\n"),
      log: [
        "LaTeX Warning: Unused global option(s):",
        "    [9pt].",
        "LaTeX Warning: Reference `tab:lit' on page 1 undefined on input line 3.",
        "LaTeX Warning: Citation `smith2020' on page 1 undefined on input line 5.",
        "LaTeX Warning: Float too large for page by 279.64265pt on input line 9.",
        "LaTeX Warning: There were undefined references.",
        "",
      ].join("\n"),
    });
    try {
      writeFileSync(join(dir, "paper.tex"), "\\documentclass[9pt]{article}\n");
      const run = texbuild(dir, "paper.tex");
      const out = run.stdout.toString();
      expect(run.status).toBe(4);
      expect(out).toContain("(1 page)");
      expect(out).toContain("undefined reference: tab:lit (paper.tex:3) - printed as ?? in the PDF");
      expect(out).toContain("undefined citation: smith2020 (paper.tex:5) - printed as ?? in the PDF");
      expect(out).toContain("float too large: paper.tex:9 - 279.6pt taller than the page");
      expect(out).toContain("class options ignored: 9pt - the class did not take them and said nothing");
      expect(out).toContain("missing characters: ⚠ (paper.tex:7) - the font has no glyph for them and the PDF leaves them out");
      // One finding per box, however many passes tectonic printed it in.
      expect(out.match(/overfull: paper\.tex:8 - 426\.7pt wider than the column/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an error is its line, where LaTeX stopped and the usual cause — and a PDF from before does not pass for this one", () => {
    const dir = bench({
      code: 1,
      printed: [
        "error: bad.tex:4: Missing $ inserted",
        "error: something bad happened inside XeTeX; its output follows:",
        "! Missing $ inserted.",
        "<inserted text> ",
        "                $",
        "l.4 Price is 5_",
        "               000 and \\textbf{bold}.",
        "No pages of output.",
        "",
      ].join("\n"),
    });
    try {
      writeFileSync(join(dir, "bad.tex"), "\\documentclass{article}\n\\begin{document}\nLine one.\nPrice is 5_000 and \\textbf{bold}.\n\\end{document}\n");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build/bad.pdf"), "%PDF from the last good compile");
      const run = texbuild(dir, "bad.tex");
      const out = run.stdout.toString();
      expect(run.status).toBe(5);
      expect(out).toContain("error: bad.tex:4: Missing $ inserted");
      expect(out).toContain("  4 | Price is 5_000 and \\textbf{bold}.");
      expect(out).toContain('stopped right after: "Price is 5_"');
      expect(out).toContain("fix: a character that works only in math is in plain text: write \\_ for _");
      expect(existsSync(join(dir, "build/bad.pdf"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a clean compile says the log is not the look; no tectonic says how to get it", () => {
    const dir = bench({ code: 0, pdf: true, printed: 'note: "version 2" Tectonic command-line interface activated\n', log: "" });
    try {
      writeFileSync(join(dir, "ok.tex"), "\\documentclass{article}\n");
      const clean = texbuild(dir, "ok.tex");
      expect(clean.status).toBe(0);
      expect(clean.stdout.toString()).toContain("findings: none in the log - that is not the same as right: look at the pages");
      rmSync(join(dir, "bin/tectonic"));
      const missing = texbuild(dir, "ok.tex");
      expect(missing.status).toBe(3);
      expect(missing.stderr.toString()).toContain("tectonic is not installed. It is one ~30 MB binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
