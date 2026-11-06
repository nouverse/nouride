#!/usr/bin/env python3
"""Compile a LaTeX document with tectonic, say in a few lines what is wrong with it, and render pages to look at.

  texbuild.py paper.tex                    # -> build/paper.pdf, the findings, build/pages/page-N.png
  texbuild.py paper.tex --outdir out --pages 4-7
  texbuild.py paper.tex --no-render

Tectonic prints errors, overfull boxes and missing characters, but not everything that is wrong: a \\ref or \\cite that
did not resolve (?? in the printed PDF), a float too large for the page and a class option the class ignored are only
in the TeX log. This keeps the log (--keep-logs) and reads it too.

On an error it prints the line, where LaTeX stopped on it, and what usually causes it. With a PDF it prints every
finding, the page count and the rendered pages (pdftoppm) to read before the PDF is sent.

Exit: 0 PDF written, nothing found; 4 PDF written, findings to fix; 5 no PDF (an error); 1 wrong arguments; 2 the
.tex file is not there; 3 tectonic is not installed. Standard library only.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys

INSTALL = ("tectonic is not installed. It is one ~30 MB binary: macOS `brew install tectonic`, Arch `pacman -S "
           "tectonic`, any other Linux `curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh` "
           "run from the bin directory your instructions name. Not `cargo install`.")

# What an error message usually means, in the order they are tried. The first that matches is printed.
HINTS = [
    (r"Undefined control sequence", "a command that does not exist: a typo, or its \\usepackage is missing. The command "
     "is the last one before where it stopped"),
    (r"Missing \$ inserted", "a character that works only in math is in plain text: write \\_ for _, \\^{} for ^, "
     "or put the formula in $...$"),
    (r"File `([^']+)' not found", "{0} is not there under that name: check the spelling in \\usepackage, \\input or "
     "\\includegraphics (a path is relative to the .tex file). The first compile downloads packages - it needs network"),
    (r"Misplaced alignment tab character &", "an & outside a table: write \\& in text"),
    (r"Extra alignment tab has been changed", "a table row has more & than the column spec has columns"),
    (r"Environment (\S+) undefined", "\\begin{{{0}}} needs its package loaded, or the name is misspelt"),
    (r"\\begin\{(\S+)\} on input line \d+ ended by \\end\{(\S+)\}", "\\begin{{{0}}} is closed by \\end{{{1}}}: the "
     "two ends do not match"),
    (r"Runaway argument|File ended while scanning|Paragraph ended before", "a { without its }, or a \\begin without its "
     "\\end, above this line"),
    (r"Missing \} inserted|Extra \}, or forgotten|Too many \}'s", "braces do not balance near this line"),
    (r"Can be used only in preamble", "a \\usepackage (or similar) after \\begin{document}: move it above"),
    (r"Missing \\begin\{document\}", "text or a broken line in the preamble, before \\begin{document}"),
    (r"There's no line here to end", "\\\\ where no line was started: remove it, or use \\vspace{...}"),
    (r"Something's wrong--perhaps a missing \\item", "a list (itemize, enumerate) with text before its first \\item"),
    (r"Illegal unit of measure", "a length without its unit: 12 -> 12pt, 2 -> 2cm"),
    (r"Missing number, treated as zero", "a number or length was expected - often a [ right after \\\\ : write {[}"),
    (r"Option clash for package (\S+)", "{0} is loaded twice with different options: load it once"),
    (r"Too many unprocessed floats", "floats queued up and never placed: \\clearpage before the next section"),
    (r"[Ff]ont .*not (be )?found|font-not-found", "that font is not installed on this machine: `fc-list : family` "
     "lists what is"),
    (r"download|network|connect|resolve host", "tectonic downloads the packages a document uses on its first compile: "
     "this machine needs network for it once"),
]

OVERFULL = re.compile(r"^warning: (?P<file>[^\n:]+):(?P<line>\d+): Overfull \\(?P<box>[hv])box \((?P<pt>[\d.]+)pt too", re.M)
MISSING_CHAR = re.compile(r"^warning: (?P<file>[^\n:]+):(?P<line>\d+): Missing character: There is no .*? \(U\+(?P<code>[0-9A-Fa-f]+)\) in font (?P<font>[^!\n]+)", re.M)
ERROR = re.compile(r"^error: (?P<file>[^\n:]+):(?P<line>\d+): (?P<msg>.+)$", re.M)
STOPPED = re.compile(r"^l\.(?P<line>\d+) (?P<before>.*)\n(?P<after>.*)$", re.M)
LOG_REF = re.compile(r"Reference `(?P<key>.+?)' on page \d+ undefined on input line (?P<line>\d+)")
LOG_CITE = re.compile(r"Citation `(?P<key>.+?)' on page \d+ undefined on input line (?P<line>\d+)")
LOG_FLOAT = re.compile(r"Float too large for page by (?P<pt>[\d.]+)pt on input line (?P<line>\d+)")
LOG_UNUSED = re.compile(r"Unused global option\(s\):\s*\[(?P<opts>[^\]]+)\]")


def hint(message: str) -> str:
    for pattern, text in HINTS:
        m = re.search(pattern, message)
        if m:
            return text.format(*m.groups()) if m.groups() else text
    return "read the line and the words around where it stopped; LaTeX's message names the command it could not use"


def source_line(tex: str, number: int) -> str:
    try:
        with open(tex, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f, start=1):
                if n == number:
                    return line.rstrip("\n")
    except OSError:
        pass
    return ""


def unwrap(log: str) -> str:
    """TeX wraps its log at 79 characters; a warning cut across two lines is joined back before it is matched."""
    out, carry = [], ""
    for line in log.splitlines():
        if len(line) == 79:
            carry += line
            continue
        out.append(carry + line)
        carry = ""
    if carry:
        out.append(carry)
    return "\n".join(out)


def diagnose(output: str, log: str, tex_name: str) -> list[str]:
    """Every finding in a compile that wrote a PDF, as one line each, deduplicated across tectonic's reruns."""
    found: list[str] = []
    seen = set()
    for m in OVERFULL.finditer(output):
        key = (m["file"], m["line"], m["box"])
        if key in seen:
            continue
        seen.add(key)
        what = "wider than the column - a table or a long unbroken string (§4)" if m["box"] == "h" else \
            "taller than the page body - move a float or split the paragraph"
        found.append(f"overfull: {m['file']}:{m['line']} - {float(m['pt']):.1f}pt {what}")
    chars: dict[str, list[str]] = {}
    for m in MISSING_CHAR.finditer(output):
        chars.setdefault(chr(int(m["code"], 16)), []).append(f"{m['file']}:{m['line']}")
    if chars:
        where = sorted({w for ws in chars.values() for w in ws})
        found.append(f"missing characters: {' '.join(chars)} ({', '.join(where[:4])}) - the font has no glyph for them and "
                     "the PDF leaves them out. \\usepackage{fontspec} and \\setmainfont{...} a font that has them "
                     "(`fc-list :charset=<hex code> family` finds one), or write them another way")
    text = unwrap(log)
    for kind, pattern in (("reference", LOG_REF), ("citation", LOG_CITE)):
        keys: dict[str, str] = {}
        for m in pattern.finditer(text):
            keys.setdefault(m["key"], m["line"])
        if keys:
            why = "the \\label is missing or spelt differently" if kind == "reference" else \
                "no such key in the bibliography, or the .bib is not included"
            found.append(f"undefined {kind}: " + ", ".join(f"{k} ({tex_name}:{line})" for k, line in keys.items())
                         + f" - printed as ?? in the PDF: {why}")
    for m in LOG_FLOAT.finditer(text):
        found.append(f"float too large: {tex_name}:{m['line']} - {float(m['pt']):.1f}pt taller than the page: shrink it, "
                     "or make a wide one table* / figure* (§4)")
    for m in LOG_UNUSED.finditer(text):
        opts = re.sub(r"\s+", "", m["opts"])
        found.append(f"class options ignored: {opts} - the class did not take them and said nothing (article takes only "
                     "10pt, 11pt, 12pt: use extarticle for 8pt or 9pt)")
    return found


def page_count(pdf: str) -> int | None:
    if shutil.which("pdfinfo"):
        run = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True)
        m = re.search(r"^Pages:\s+(\d+)", run.stdout, re.M)
        if m:
            return int(m.group(1))
    return None


def pages_to_render(spec: str | None, pages: int | None) -> list[tuple[int, int]]:
    if spec:
        out = []
        for part in spec.split(","):
            a, _, b = part.strip().partition("-")
            if not a.isdigit() or (b and not b.isdigit()):
                raise ValueError(f"--pages {spec!r}: write pages as 1-3,7")
            out.append((int(a), int(b or a)))
        return out
    if not pages:
        return [(1, 3)]
    return [(1, pages)] if pages <= 6 else [(1, 3), (pages, pages)]


def render(pdf: str, outdir: str, ranges: list[tuple[int, int]]) -> tuple[list[str], str]:
    if not shutil.which("pdftoppm"):
        return [], "pdftoppm is not installed (poppler-utils): pages not rendered - look at the PDF another way"
    folder = os.path.join(outdir, "pages")
    os.makedirs(folder, exist_ok=True)
    for old in glob.glob(os.path.join(folder, "page-*.png")):
        os.remove(old)  # pages of an earlier, longer compile would be read as this one
    for first, last in ranges:
        subprocess.run(["pdftoppm", "-png", "-r", "80", "-f", str(first), "-l", str(last), pdf, os.path.join(folder, "page")],
                       capture_output=True)
    made = sorted(glob.glob(os.path.join(folder, "page-*.png")), key=lambda p: int(re.findall(r"(\d+)\.png$", p)[0]))
    return made, ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tex", help="the .tex file")
    ap.add_argument("--outdir", help="where the PDF, the log and the page pictures go (default: build/ beside the .tex)")
    ap.add_argument("--pages", help="pages to render, e.g. 1-3,7 (default: all of a short document, else 1-3 and the last)")
    ap.add_argument("--no-render", action="store_true", help="do not render pages")
    a = ap.parse_args()

    tex = os.path.abspath(a.tex)
    if not os.path.isfile(tex):
        print(f"texbuild: no file {a.tex}", file=sys.stderr)
        return 2
    if not shutil.which("tectonic"):
        print(f"texbuild: {INSTALL}", file=sys.stderr)
        return 3
    try:
        ranges = pages_to_render(a.pages, None) if a.pages else None
    except ValueError as err:
        print(f"texbuild: {err}", file=sys.stderr)
        return 1
    folder, name = os.path.split(tex)
    stem = os.path.splitext(name)[0]
    outdir = os.path.abspath(a.outdir or os.path.join(folder, "build"))
    os.makedirs(outdir, exist_ok=True)  # tectonic does not make --outdir, and fails before reading a line
    pdf = os.path.join(outdir, stem + ".pdf")
    if os.path.exists(pdf):
        os.remove(pdf)  # a PDF left by the last good compile would pass for this one

    run = subprocess.run(["tectonic", "-X", "compile", name, "--outdir", outdir, "--keep-logs"], cwd=folder,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    output = run.stdout
    with open(os.path.join(outdir, "compile.out"), "w", encoding="utf-8") as f:
        f.write(output)
    try:
        with open(os.path.join(outdir, stem + ".log"), encoding="utf-8", errors="replace") as f:
            log = f.read()
    except OSError:
        log = ""

    if run.returncode != 0 or not os.path.exists(pdf):
        m = ERROR.search(output)
        if m:
            line = int(m["line"])
            print(f"error: {m['file']}:{line}: {m['msg'].lstrip('! ').strip()}")
            text = source_line(os.path.join(folder, m["file"]), line)
            if text:
                print(f"  {line} | {text}")
            stopped = STOPPED.search(output)
            if stopped and stopped["line"] == str(line) and stopped["before"].strip():
                print(f"  stopped right after: \"{stopped['before'].strip()}\"")
            print(f"fix: {hint(m['msg'] + ' ' + output)}")
        else:
            lines = [ln for ln in output.splitlines() if ln.startswith("error:")] or output.strip().splitlines()[-5:]
            for ln in lines[:6]:
                print(ln)
            print(f"fix: {hint(output)}")
        print(f"no PDF. LaTeX stops at the first error - fix it and run this again; there may be more after it. "
              f"Everything tectonic printed: {os.path.join(outdir, 'compile.out')}")
        return 5

    found = diagnose(output, log, name)
    pages = page_count(pdf)
    print(f"compiled {name} -> {pdf}" + (f" ({pages} page{'s' if pages != 1 else ''})" if pages else ""))
    if found:
        print(f"findings: {len(found)} - fix each and run this again (Underfull boxes are not findings: leave them)")
        for f_ in found:
            print(f"  {f_}")
    else:
        print("findings: none in the log - that is not the same as right: look at the pages")
    if not a.no_render:
        made, note = render(pdf, outdir, ranges or pages_to_render(None, pages))
        if note:
            print(f"note: {note}")
        if made:
            print("pages: " + " ".join(made))
            print("next: `read` every one of those pictures before the PDF is sent; after a fix, render and read again")
    return 4 if found else 0


if __name__ == "__main__":
    sys.exit(main())
