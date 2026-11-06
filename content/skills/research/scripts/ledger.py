#!/usr/bin/env python3
"""
ledger.py - keep the sources of a piece of research in one JSON file, and check a report against it.

    python3 ledger.py init    LEDGER "the question, in the person's words"
    python3 ledger.py add     LEDGER --url URL --title TITLE --claim CLAIM --quote QUOTE
                                     [--publisher P] [--date YYYY-MM-DD|YYYY-MM|YYYY|unknown]
                                     [--kind primary|secondary|tertiary|opinion|data] [--lang id|en|...]
                                     [--note TEXT]
    python3 ledger.py list    LEDGER
    python3 ledger.py merge   LEDGER OTHER.json [OTHER2.json ...]
    python3 ledger.py check   LEDGER REPORT.md [--verify-quotes]
    python3 ledger.py render  LEDGER REPORT.md [--out FINAL.md] [--heading "Sources"]

A source is one URL. Adding the same URL again adds a claim to it and keeps its number, so [3] always means the
same page. The number is printed: write it in the report as [3] - or [3, 5] for two sources.

`merge` folds the ledgers that helpers kept in parallel into LEDGER: the same URL becomes one source with all its
claims, new URLs get the next numbers. Merge before writing the report - numbers in a helper's notes refer to its own
ledger, not to the merged one.

`check` lists every [n] in the report with no source, every source the report never cites, sources with no date,
claims with no quote, and text the report sets in quotation marks (or as a > block quote) that is not word for word a
quote in the ledger. With --verify-quotes it fetches each page (20 s timeout each) and says whether every quote
is really on it: a quote that is not there is either mistyped or invented, and is fixed before the report goes.

`render` renumbers the sources in the order the report first cites them ([1] is the first one a reader meets),
rewrites the [n] in the report to match, drops sources it never cites, and appends the list of sources. The ledger
itself is not changed. Without --out it writes REPORT.final.md beside REPORT.md.

Exit: 0 done (check: nothing wrong); 1 usage error; 2 the ledger or report cannot be read; 4 check found problems.
Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request

KINDS = ("primary", "secondary", "tertiary", "opinion", "data")
FETCH_TIMEOUT = 20
FETCH_MAX = 3 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) nouride-research-ledger/1"

# [3]  [3, 5]  [3,5,8]  [3][5] - only numbers, so Markdown links [text](url) and footnotes [^1] are left alone.
CITE = re.compile(r"\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?!\()")


class Stop(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def load(path: str) -> dict:
    if not os.path.exists(path):
        raise Stop(2, f"no ledger at {path} - start one with: python3 ledger.py init {path} \"<question>\"")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise Stop(2, f"cannot read the ledger {path}: {e}") from None
    if not isinstance(data, dict) or not isinstance(data.get("sources"), list):
        raise Stop(2, f"{path} is not a ledger (no \"sources\" list)")
    return data


def save(path: str, data: dict) -> None:
    # Written to a temporary file and moved, so a ledger is never left half-written if the turn is cut off.
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".ledger-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def norm_url(url: str) -> str:
    """The same page under small differences: scheme, trailing slash, fragment, tracking parameters."""
    u = url.strip()
    u = re.sub(r"#.*$", "", u)
    u = re.sub(r"[?&](utm_[a-z]+|fbclid|gclid|ref)=[^&]*", "", u)
    u = re.sub(r"^https?://(www\.)?", "", u, flags=re.I)
    return u.rstrip("/?&").lower()


def check_date(value: str | None) -> str:
    if not value:
        return "unknown"
    v = value.strip()
    if v.lower() in ("unknown", "?", "n.d.", "nd", "-"):
        return "unknown"
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            dt.datetime.strptime(v, fmt)
            return v
        except ValueError:
            pass
    raise Stop(1, f"--date {value!r}: write it as YYYY-MM-DD, YYYY-MM or YYYY (or unknown) - "
                  "convert '12 Maret 2024' to 2024-03-12 yourself")


def cmd_init(a) -> int:
    if os.path.exists(a.ledger):
        data = load(a.ledger)
        print(f"{a.ledger} already exists with {len(data['sources'])} source(s); kept as it is.")
        return 0
    os.makedirs(os.path.dirname(os.path.abspath(a.ledger)), exist_ok=True)
    save(a.ledger, {"question": a.question, "started": dt.date.today().isoformat(), "sources": []})
    print(f"started {a.ledger}")
    return 0


def cmd_add(a) -> int:
    data = load(a.ledger)
    if not re.match(r"^https?://", a.url.strip(), re.I):
        raise Stop(1, f"--url {a.url!r} is not an http(s) URL. Every source is a page someone else can open.")
    if not a.quote.strip():
        raise Stop(1, "--quote is empty. Copy the sentence from the page you read; no quote, no source.")
    date = check_date(a.date)
    key = norm_url(a.url)
    claim = {"claim": a.claim.strip(), "quote": " ".join(a.quote.split())}
    if a.note:
        claim["note"] = a.note.strip()
    for s in data["sources"]:
        if norm_url(s["url"]) == key:
            if any(c["quote"] == claim["quote"] and c["claim"] == claim["claim"] for c in s["claims"]):
                print(f"[{s['id']}] already holds this claim - nothing added")
                return 0
            s["claims"].append(claim)
            if date != "unknown" and s.get("date", "unknown") == "unknown":
                s["date"] = date
            save(a.ledger, data)
            print(f"[{s['id']}] {s['title']} - claim {len(s['claims'])} added (same page, same number)")
            return 0
    n = max((s["id"] for s in data["sources"]), default=0) + 1
    source = {
        "id": n,
        "url": a.url.strip(),
        "title": a.title.strip(),
        "publisher": (a.publisher or "").strip(),
        "date": date,
        "kind": a.kind,
        "lang": (a.lang or "").strip(),
        "accessed": dt.date.today().isoformat(),
        "claims": [claim],
    }
    data["sources"].append(source)
    save(a.ledger, data)
    warn = "  (no date - say so where you use it)" if date == "unknown" else ""
    print(f"[{n}] {source['title']}{warn}")
    return 0


def cmd_list(a) -> int:
    data = load(a.ledger)
    print(f"question: {data.get('question', '')}")
    print(f"{len(data['sources'])} source(s)")
    for s in data["sources"]:
        print(f"[{s['id']}] {s['title']} - {s.get('publisher') or host(s['url'])}, {s.get('date', 'unknown')}, "
              f"{s.get('kind', '?')}{', ' + s['lang'] if s.get('lang') else ''}")
        print(f"     {s['url']}")
        for c in s["claims"]:
            q = c["quote"] if len(c["quote"]) <= 160 else c["quote"][:157] + "..."
            print(f"     - {c['claim']}  <- \"{q}\"")
    return 0


def cmd_merge(a) -> int:
    data = load(a.ledger)
    by_url = {norm_url(s["url"]): s for s in data["sources"]}
    added = joined = 0
    for other in a.others:
        for src in load(other)["sources"]:
            mine = by_url.get(norm_url(src["url"]))
            if mine is None:
                n = max((s["id"] for s in data["sources"]), default=0) + 1
                copy = dict(src, id=n, claims=list(src["claims"]))
                data["sources"].append(copy)
                by_url[norm_url(src["url"])] = copy
                added += 1
                continue
            for c in src["claims"]:
                if not any(c["quote"] == k["quote"] and c["claim"] == k["claim"] for k in mine["claims"]):
                    mine["claims"].append(c)
                    joined += 1
            if mine.get("date", "unknown") == "unknown" and src.get("date", "unknown") != "unknown":
                mine["date"] = src["date"]
    save(a.ledger, data)
    print(f"merged {len(a.others)} ledger(s): {added} new source(s), {joined} claim(s) added to sources already here; "
          f"{len(data['sources'])} source(s) now - run list to see the numbers")
    return 0


def host(url: str) -> str:
    m = re.match(r"^https?://([^/]+)", url, re.I)
    return m.group(1) if m else url


def cited_ids(text: str) -> list[int]:
    """Every cited number, in order of first appearance."""
    seen: list[int] = []
    for m in CITE.finditer(strip_code(text)):
        for part in re.split(r"\s*[,;]\s*", m.group(1)):
            n = int(part)
            if n not in seen:
                seen.append(n)
    return seen


def strip_code(text: str) -> str:
    # [0] inside code is an index, not a citation.
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    return re.sub(r"`[^`\n]*`", "", text)


def read_report(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        raise Stop(2, f"cannot read the report {path}: {e}") from None


def page_text(url: str) -> tuple[str | None, str]:
    """The visible text of a page, or None and why not."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            ctype = r.headers.get("content-type", "")
            body = r.read(FETCH_MAX)
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 - every network failure is reported the same way
        return None, f"could not fetch ({type(e).__name__}: {str(e)[:80]})"
    if "pdf" in ctype or body[:5] == b"%PDF-":
        return None, "a PDF - check the quote against the text from document-reading's doc.py extract"
    charset = re.search(r"charset=([\w-]+)", ctype)
    text = body.decode(charset.group(1) if charset else "utf-8", errors="replace")
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return html.unescape(text), ""


def fold(text: str) -> str:
    """Compare quotes the way a reader would: case, spacing, curly quotes and dashes do not matter."""
    t = unicodedata.normalize("NFKC", text).lower()
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = re.sub(r"[‐-―]", "-", t)
    return re.sub(r"\s+", " ", t).strip()


def cmd_check(a) -> int:
    data = load(a.ledger)
    text = read_report(a.report)
    ids = {s["id"]: s for s in data["sources"]}
    cited = cited_ids(text)
    problems: list[str] = []
    notes: list[str] = []

    for n in cited:
        if n not in ids:
            problems.append(f"[{n}] is cited in the report but there is no source {n} in the ledger - add the source, or remove the claim")
    for n, s in ids.items():
        if n not in cited:
            problems.append(f"[{n}] {s['title']} is in the ledger but the report never cites it - cite it where it is used, or say why it was left out")
    for s in data["sources"]:
        if s.get("date", "unknown") == "unknown" and s["id"] in cited:
            notes.append(f"[{s['id']}] has no date - say 'undated' where the report relies on it")
        for c in s["claims"]:
            if not c.get("quote"):
                problems.append(f"[{s['id']}] claim \"{c['claim'][:60]}\" has no quote")
    # Text the report puts in quotation marks, or in a > block quote, must be a quote the ledger holds - a source's
    # paraphrase of a law, set in quotation marks as if it were the law's wording, is the misquote this catches.
    all_quotes = [fold(c["quote"]) for s in data["sources"] for c in s["claims"]]
    for q in dict.fromkeys(quoted_passages(text)):
        fq = fold(q).strip(' ."\'')
        if len(fq) >= 25 and not any(fq in aq for aq in all_quotes):
            problems.append(f"quoted in the report but not a ledger quote: \"{q[:90]}\" - quote only what the ledger holds, "
                            "word for word; otherwise drop the quotation marks and say whose wording it is")
    uncited = uncited_paragraphs(text)
    for line in uncited:
        notes.append(f"no citation in a paragraph with a number or a claim: \"{line}\"")

    if a.verify_quotes:
        for s in data["sources"]:
            body, why = page_text(s["url"])
            if body is None:
                notes.append(f"[{s['id']}] quotes not verified: {why}")
                continue
            folded = fold(body)
            for c in s["claims"]:
                if fold(c["quote"]) in folded:
                    continue
                # A long quote copied across a line break or a link may differ in a word; the first 8 words must be there.
                head = " ".join(fold(c["quote"]).split()[:8])
                if head and head in folded:
                    notes.append(f"[{s['id']}] quote starts on the page but differs further on - recheck: \"{c['quote'][:80]}\"")
                else:
                    problems.append(f"[{s['id']}] quote NOT found on {s['url']}: \"{c['quote'][:100]}\" - "
                                    "re-read the page (web_fetch) and copy it exactly; a page built by scripts may need the browser")

    print(f"report cites {len(cited)} source(s); ledger has {len(ids)}")
    for p in problems:
        print(f"PROBLEM {p}")
    for n in notes:
        print(f"note    {n}")
    if not problems:
        print("OK - every citation has a source and every source is cited" + (", quotes found on their pages" if a.verify_quotes else ""))
        return 0
    return 4


def quoted_passages(text: str) -> list[str]:
    """Passages the report presents as quotes: in straight or curly double quotes, or > block quotes."""
    body = strip_code(text)
    body = re.split(r"(?im)^#{1,6}\s*(sources|sumber|references|daftar pustaka|bibliography)\s*$", body)[0]
    out = [m.group(1) for m in re.finditer(r'["\u201c]([^"\u201c\u201d\n]{25,})["\u201d]', body)]
    block: list[str] = []
    for line in body.splitlines() + [""]:
        if line.lstrip().startswith(">"):
            block.append(line.lstrip()[1:].strip())
        elif block:
            joined = re.sub(r"\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\]", "", " ".join(block)).strip(" *_")
            out.append(joined.strip('"\u201c\u201d *_'))
            block = []
    # Emphasis and citations inside a quote are the report's, not the source's.
    return [re.sub(r"[*_]", "", re.sub(r"\s*\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\]", "", q)).strip() for q in out if q.strip()]


def uncited_paragraphs(text: str) -> list[str]:
    """Paragraphs that state a figure but cite nothing - the likeliest place for an invented number."""
    out = []
    body = strip_code(text)
    body = re.split(r"(?im)^#{1,6}\s*(sources|sumber|references|daftar pustaka|bibliography)\s*$", body)[0]
    for para in re.split(r"\n\s*\n", body):
        p = para.strip()
        if not p or p.startswith("#") or p.startswith("|") or p.startswith(">"):
            continue
        if CITE.search(p):
            continue
        if re.search(r"\d[\d.,]*\s*(%|persen|percent|juta|miliar|triliun|million|billion|rb|ribu|USD|IDR|Rp)|Rp\s?\d|\$\s?\d|\b(19|20)\d\d\b", p, re.I):
            out.append(re.sub(r"\s+", " ", p)[:90])
    return out[:10]


def cmd_render(a) -> int:
    data = load(a.ledger)
    text = read_report(a.report)
    ids = {s["id"]: s for s in data["sources"]}
    cited = cited_ids(text)
    missing = [n for n in cited if n not in ids]
    if missing:
        raise Stop(4, "the report cites " + ", ".join(f"[{n}]" for n in missing) + " which the ledger does not have - run check")
    new = {old: i + 1 for i, old in enumerate(cited)}

    def renumber(m: re.Match) -> str:
        parts = [new[int(p)] for p in re.split(r"\s*[,;]\s*", m.group(1))]
        return "[" + ", ".join(str(p) for p in sorted(set(parts))) + "]"

    # Code blocks keep their brackets: split them out, renumber the rest, put them back.
    pieces = re.split(r"(```.*?```|`[^`\n]*`)", text, flags=re.S)
    body = "".join(p if p.startswith("`") else CITE.sub(renumber, p) for p in pieces).rstrip()
    lines = [f"## {a.heading}", ""]
    for old in cited:
        s = ids[old]
        who = s.get("publisher") or host(s["url"])
        date = s.get("date", "unknown")
        date = "undated" if date == "unknown" else date
        lines.append(f"{new[old]}. {s['title']} - {who}, {date}. {s['url']} (accessed {s.get('accessed', '?')})")
    out = a.out or re.sub(r"(\.md)?$", ".final.md", a.report, count=1)
    with open(out, "w", encoding="utf-8") as f:
        f.write(body + "\n\n" + "\n".join(lines) + "\n")
    dropped = [n for n in ids if n not in cited]
    print(f"wrote {out}: {len(cited)} source(s), numbered in the order the report first cites them")
    if dropped:
        print("left out (never cited): " + ", ".join(f"[{n}] {ids[n]['title']}" for n in dropped))
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="ledger.py", description=__doc__.split("\n\n")[0].strip(),
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="start a ledger for a question")
    s.add_argument("ledger")
    s.add_argument("question")

    s = sub.add_parser("add", help="add a source (or another claim from a source already in it)")
    s.add_argument("ledger")
    s.add_argument("--url", required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--claim", required=True, help="what this source supports, in your words")
    s.add_argument("--quote", required=True, help="the exact sentence on the page that supports it")
    s.add_argument("--publisher", help="who published it: a ministry, a newspaper, a company, an author")
    s.add_argument("--date", help="when it was published or last updated: YYYY-MM-DD, YYYY-MM, YYYY, or unknown")
    s.add_argument("--kind", choices=KINDS, default="secondary",
                   help="primary: the original (law, dataset, filing, paper, official statement); secondary: reporting on it; "
                        "tertiary: encyclopedia, summary; opinion; data: a table or dataset itself")
    s.add_argument("--lang", help="language of the source, e.g. id or en")
    s.add_argument("--note", help="anything a reader should know: a conflict of interest, a contradiction")

    s = sub.add_parser("list", help="print the ledger compactly")
    s.add_argument("ledger")

    s = sub.add_parser("merge", help="fold other ledgers (from helpers) into this one")
    s.add_argument("ledger")
    s.add_argument("others", nargs="+")

    s = sub.add_parser("check", help="check a report's [n] citations against the ledger")
    s.add_argument("ledger")
    s.add_argument("report")
    s.add_argument("--verify-quotes", action="store_true", help="fetch each page and look for each quote on it")

    s = sub.add_parser("render", help="renumber the citations in reading order and append the sources")
    s.add_argument("ledger")
    s.add_argument("report")
    s.add_argument("--out")
    s.add_argument("--heading", default="Sources", help="the heading, in the report's language (default: Sources)")

    a = p.parse_args(argv)
    try:
        return {"init": cmd_init, "add": cmd_add, "list": cmd_list, "merge": cmd_merge, "check": cmd_check, "render": cmd_render}[a.cmd](a)
    except Stop as e:
        print(f"ledger.py: {e}", file=sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
