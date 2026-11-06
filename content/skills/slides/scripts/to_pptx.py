#!/usr/bin/env python3
"""
to_pptx.py - the same deck as a PowerPoint file, for people who need .pptx. Reads the deck HTML built from the slides
skill's templates/deck.html, so there is one source for both.

    python3 to_pptx.py DECK.html --out deck.pptx                     editable: real titles, bullets, tables, pictures, notes
    python3 to_pptx.py DECK.html --out deck.pptx --pictures RENDER   each slide is its rendered PNG (from render.mjs), notes kept

Editable maps each layout of the template onto native PowerPoint text boxes on a 16:9 slide: title, section, bullets,
two-col, image, image-right, quote, big-number, table, closing; .source lines; speaker notes from <aside class="notes">.
Colours come from the deck's :root variables (--bg, --fg, --muted, --accent, --accent-fg, --soft). Text boxes are set
to shrink text that does not fit when PowerPoint or LibreOffice opens the file - still check it (SKILL.md, step 6).
Anything the template does not have (your own CSS, absolutely placed elements) is not carried: use --pictures for a
deck that must look exactly like the PDF, at the cost of editing.

Exit: 0 written; 1 bad arguments; 2 the deck cannot be read; 3 python-pptx missing.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from html.parser import HTMLParser

PX = 9525                    # EMU per CSS pixel: a 1280x720 px slide is exactly 13.333 x 7.5 in
SAFE_FONTS = {"arial", "calibri", "helvetica", "georgia", "verdana", "segoe ui", "times new roman", "cambria", "aptos"}
VOID = {"br", "img", "hr", "meta", "link", "input", "source"}


class Stop(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class Node:
    def __init__(self, tag, attrs, parent=None):
        self.tag, self.attrs, self.parent, self.kids = tag, dict(attrs), parent, []

    @property
    def classes(self):
        return set((self.attrs.get("class") or "").split())

    def text(self) -> str:
        out = []
        for k in self.kids:
            if isinstance(k, str):
                out.append(k)
            elif k.tag == "br":
                out.append("\n")
            elif "notes" not in k.classes and k.tag not in ("ul", "ol", "script", "style"):
                out.append(k.text())
        return re.sub(r"[ \t\r\n]+", " ", "".join(out)).strip()

    def find_all(self, pred):
        for k in self.kids:
            if isinstance(k, Node):
                if pred(k):
                    yield k
                yield from k.find_all(pred)

    def find(self, pred):
        return next(self.find_all(pred), None)

    def child_elems(self):
        return [k for k in self.kids if isinstance(k, Node)]


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {})
        self.cur = self.root
        self.style = []
        self._in_style = False

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.kids.append(n)
        if tag == "style":
            self._in_style = True
        if tag not in VOID:
            self.cur = n

    def handle_endtag(self, tag):
        if tag == "style":
            self._in_style = False
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        if self._in_style:
            self.style.append(data)
        self.cur.kids.append(data)


def css_vars(css: str) -> dict:
    m = re.search(r":root\s*{([^}]*)}", css)
    out = {}
    for name, val in re.findall(r"--([\w-]+)\s*:\s*([^;]+);", m.group(1) if m else ""):
        out[name] = val.strip()
    return out


def rgb(value: str, fallback: str):
    from pptx.dml.color import RGBColor
    v = (value or fallback).strip()
    m = re.match(r"#([0-9a-fA-F]{6})$", v) or re.match(r"#([0-9a-fA-F]{3})$", v)
    if not m:
        v = fallback
        m = re.match(r"#([0-9a-fA-F]{6})$", v)
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return RGBColor.from_string(h.upper())


class Builder:
    def __init__(self, deck_path: str, vars_: dict):
        from pptx import Presentation
        from pptx.util import Emu
        self.deck_dir = os.path.dirname(os.path.abspath(deck_path))
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Emu(1280 * PX), Emu(720 * PX)
        self.blank = self.prs.slide_layouts[6]
        self.c = {k: rgb(vars_.get(k, ""), d) for k, d in (("bg", "#FFFFFF"), ("fg", "#14181F"), ("muted", "#5B6472"),
                                                           ("accent", "#2563EB"), ("accent-fg", "#FFFFFF"), ("soft", "#EEF2F8"))}
        fam = [f.strip().strip("\"'") for f in vars_.get("font", "Arial").split(",")]
        self.font = next((f for f in fam if f.lower() in SAFE_FONTS), "Arial")
        self.warnings: list[str] = []
        self.fits: list[str] = []
        self.slide_no = 0
        self._fonts: dict = {}
        self.measuring = self._font(False) is not None

    # -- measuring: PowerPoint does not lay text out when a file is written, so a box that overflows is only seen when
    # someone opens it. Text is measured here with the metrics of the font it will be shown in (Arial, or Liberation
    # Sans - the same widths), and shrunk to fit the way PowerPoint's "shrink text on overflow" would.

    def _font(self, bold: bool):
        if bold in self._fonts:
            return self._fonts[bold]
        path = None
        try:
            import subprocess
            for fam in (self.font, "Liberation Sans", "Arial"):
                r = subprocess.run(["fc-match", "-f", "%{file}", f"{fam}:{'bold' if bold else 'regular'}"],
                                   capture_output=True, text=True, timeout=10)
                if r.returncode == 0 and re.search(r"(arial|liberationsans)", os.path.basename(r.stdout).lower().replace("-", "")):
                    path = r.stdout
                    break
        except (OSError, subprocess.SubprocessError):
            pass
        if path is None:
            for cand in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
                         "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"):
                if os.path.exists(cand):
                    path = cand
                    break
        try:
            from PIL import ImageFont
            self._fonts[bold] = (ImageFont, path) if path else None
        except ImportError:
            self._fonts[bold] = None
        return self._fonts[bold]

    def _height(self, specs: list, width: float, scale: float) -> float:
        total = 0.0
        for sp in specs:
            px = sp["size"] * scale
            f = self._font(sp.get("bold", False))
            font = f[0].truetype(f[1], max(1, int(round(px))))
            indent = 28 if sp.get("bullet") else 0
            words, lines, cur = sp["text"].split(), 1, ""
            for w in words:
                trial = (cur + " " + w).strip()
                if font.getlength(trial) <= width - indent or not cur:
                    cur = trial
                else:
                    lines += 1
                    cur = w
            total += lines * px * 1.2 + min(24, px * (0.45 if sp.get("bullet") else 0.5))
        return total

    def fit(self, specs: list, w: float, h: float, floor: float) -> float:
        """The scale (1 = as written) at which the paragraphs fit w x h px, never below `floor` px for the body."""
        if not self.measuring or not specs:
            return 1.0
        base = max(sp["size"] for sp in specs)
        scale = 1.0
        while self._height(specs, w, scale) > h and base * scale > floor:
            scale -= 0.04
        if self._height(specs, w, scale) > h:
            self.warnings.append(f"slide {self.slide_no}: text does not fit its box even at {round(base * scale)}px - "
                                 f"cut words or split the slide: \"{specs[0]['text'][:50]}\"")
        elif scale < 0.999:
            self.fits.append(f"slide {self.slide_no}: text shrunk to {round(scale * 100)}% to fit (largest {round(base * scale)}px)")
        return scale

    # -- primitives, in CSS pixels of the 1280x720 slide

    def box(self, slide, x, y, w, h, paras, size=28, color=None, bold=False, align=None, anchor="top", shrink=True, floor=None):
        """paras: list of str, or of (text, level) for bullets, or of dicts {text, size, bold, color, bullet, level}."""
        from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
        from pptx.util import Emu, Pt
        tb = slide.shapes.add_textbox(Emu(x * PX), Emu(y * PX), Emu(w * PX), Emu(h * PX))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[anchor]
        if shrink:
            tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
        specs = []
        for p in paras:
            spec = dict(p) if isinstance(p, dict) else {"text": p[0], "bullet": True, "level": p[1]} if isinstance(p, tuple) else {"text": p}
            lvl = spec.get("level", 0)
            spec["size"] = spec.get("size") or (size if lvl == 0 else size * 0.86)
            spec.setdefault("bold", bold)
            specs.append(spec)
        scale = self.fit(specs, w, h, floor or (20 if size >= 20 else size)) if shrink else 1.0
        first = True
        for spec in specs:
            para = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            lvl = spec.get("level", 0)
            text = spec["text"]
            if spec.get("bullet"):
                text = ("• " if lvl == 0 else "– ") + text
                para.level = min(lvl, 4)
            run = para.add_run()
            run.text = text
            f = run.font
            f.name = self.font
            f.size = Pt(round(spec["size"] * scale * 0.75, 1))
            f.bold = spec["bold"]
            f.color.rgb = spec.get("color") or color or self.c["fg"]
            if align:
                para.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT, "left": PP_ALIGN.LEFT}[align]
            # The gap the template puts between blocks: tighter between bullets, wider after a heading or a line.
            para.space_after = Pt(round(min(24, spec["size"] * scale * (0.45 if spec.get("bullet") else 0.5)) * 0.75, 1))
        return tb

    def rect(self, slide, x, y, w, h, color):
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.util import Emu
        s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(x * PX), Emu(y * PX), Emu(w * PX), Emu(h * PX))
        s.fill.solid()
        s.fill.fore_color.rgb = color
        s.line.fill.background()
        s.shadow.inherit = False          # the default shape style adds a shadow the deck does not have
        return s

    def picture(self, slide, src, x, y, w, h):
        from pptx.util import Emu
        path = src if os.path.isabs(src) else os.path.join(self.deck_dir, src)
        if re.match(r"^https?://", src) or not os.path.exists(path):
            self.warnings.append(f"picture not found as a local file: {src} - download it beside the deck")
            return
        try:
            pic = slide.shapes.add_picture(path, Emu(x * PX), Emu(y * PX))
        except Exception as e:  # noqa: BLE001 - a picture python-pptx cannot read (SVG, WebP) is reported, not fatal
            self.warnings.append(f"picture {src} could not be placed ({type(e).__name__}) - convert it to PNG or JPG")
            return
        iw, ih = pic.width / PX, pic.height / PX
        k = min(w / iw, h / ih)
        pic.width, pic.height = int(iw * k * PX), int(ih * k * PX)
        pic.left, pic.top = int((x + (w - iw * k) / 2) * PX), int((y + (h - ih * k) / 2) * PX)

    def background(self, slide, color):
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = color

    def notes(self, slide, sec: Node):
        n = sec.find(lambda k: "notes" in k.classes)
        if n is not None:
            text = re.sub(r"[ \t]+", " ", "".join(x if isinstance(x, str) else x.text() for x in n.kids)).strip()
            if text:
                slide.notes_slide.notes_text_frame.text = text

    def source(self, slide, sec: Node, color):
        s = sec.find(lambda k: "source" in k.classes)
        if s is not None and s.text():
            self.box(slide, 80, 690, 1120, 22, [s.text()], size=14, color=color, shrink=False)

    # -- layouts

    def bullets_of(self, node: Node) -> list:
        out = []
        for lst in [k for k in node.child_elems() if k.tag in ("ul", "ol")] if node.tag not in ("ul", "ol") else [node]:
            for li in [k for k in lst.child_elems() if k.tag == "li"]:
                out.append((li.text(), 0))
                for sub in li.find_all(lambda k: k.tag == "li"):
                    out.append((sub.text(), 1))
        return out

    def flow(self, node: Node) -> list:
        """The text content of a block, in order: headings, paragraphs, bullets."""
        paras = []
        for k in node.child_elems():
            if "notes" in k.classes or "source" in k.classes or k.tag in ("img", "table", "figure"):
                continue
            if k.tag in ("ul", "ol"):
                paras.extend(self.bullets_of(k))
            elif k.tag == "h3":
                paras.append({"text": k.text(), "size": 30, "bold": True})
            elif k.tag in ("p", "blockquote", "h4"):
                if k.text():
                    paras.append(k.text())
            elif k.tag == "div":
                paras.extend(self.flow(k))
        return paras

    def table(self, slide, tnode: Node, x, y, w, h):
        from pptx.util import Emu, Pt
        rows = [r for r in tnode.find_all(lambda k: k.tag == "tr")]
        if not rows:
            return
        cells = [[c for c in r.child_elems() if c.tag in ("td", "th")] for r in rows]
        ncol = max(len(r) for r in cells)
        row_h = min(56, h / len(rows))
        shape = slide.shapes.add_table(len(rows), ncol, Emu(x * PX), Emu(y * PX), Emu(w * PX), Emu(int(row_h * len(rows)) * PX))
        t = shape.table
        for i, r in enumerate(cells):
            for j in range(ncol):
                cell = t.cell(i, j)
                txt = r[j].text() if j < len(r) else ""
                cell.text = txt
                p = cell.text_frame.paragraphs[0]
                for run in p.runs:
                    run.font.size = Pt(24 * 0.75 if len(rows) <= 7 else 18 * 0.75)
                    run.font.name = self.font
                    run.font.bold = i == 0 or (j < len(r) and r[j].tag == "th")
                if j < len(r) and "n" in r[j].classes:
                    from pptx.enum.text import PP_ALIGN
                    p.alignment = PP_ALIGN.RIGHT
        if len(rows) > 7:
            self.warnings.append(f"a table of {len(rows)} rows: too many to read on a slide - split it or keep the top rows")

    def slide_for(self, sec: Node):
        self.slide_no += 1
        s = self.prs.slides.add_slide(self.blank)
        layout = next((c for c in ("title", "section", "two-col", "image-right", "image", "quote", "big-number", "table",
                                   "closing") if c in sec.classes), "bullets")
        h1 = sec.find(lambda k: k.tag == "h1")
        h2 = sec.find(lambda k: k.tag == "h2")
        title = (h1 or h2).text() if (h1 or h2) else ""
        C = self.c
        if layout in ("title", "closing"):
            self.background(s, C["fg"])
            self.rect(s, 80, 64, 96, 8, C["accent"])
            paras = [{"text": title, "size": 72 if layout == "title" else 56, "bold": True, "color": C["bg"]}]
            # Everything under the title, lists included: a closing slide's next steps are usually a list, and taking
            # only <p> lines dropped them (found in a live test).
            for k in sec.child_elems():
                if k.tag in ("h1", "h2") or "notes" in k.classes or "source" in k.classes:
                    continue
                if k.tag == "p":
                    if k.text():
                        paras.append({"text": k.text(), "size": 32 if "subtitle" in k.classes else 24, "color": C["soft"]})
                    continue
                holder = Node("div", {}, None)
                holder.kids = [k]
                for item in self.flow(holder):
                    spec = {"text": item[0], "bullet": True, "level": item[1]} if isinstance(item, tuple) else \
                        (dict(item) if isinstance(item, dict) else {"text": item})
                    spec.setdefault("size", 26 if spec.get("bullet") else 24)
                    spec["color"] = C["soft"]
                    paras.append(spec)
            self.box(s, 80, 120, 1120, 520, paras, anchor="middle")
        elif layout == "section":
            self.background(s, C["accent"])
            paras = [{"text": title, "size": 60, "bold": True, "color": C["accent-fg"]}]
            holder = Node("div", {}, None)
            holder.kids = [k for k in sec.child_elems() if k.tag not in ("h1", "h2") and "notes" not in k.classes and "source" not in k.classes]
            for item in self.flow(holder):
                spec = {"text": item[0], "bullet": True, "level": item[1]} if isinstance(item, tuple) else \
                    (dict(item) if isinstance(item, dict) else {"text": item})
                spec.setdefault("size", 28)
                spec["color"] = C["accent-fg"]
                paras.append(spec)
            self.box(s, 80, 64, 1120, 600, paras, anchor="middle")
        elif layout == "quote":
            self.background(s, C["soft"])
            q = sec.find(lambda k: k.tag == "blockquote")
            who = sec.find(lambda k: "who" in k.classes)
            paras = [{"text": f"“{q.text() if q else ''}”", "size": 44, "bold": True}]
            if who:
                paras.append({"text": who.text(), "size": 26, "color": C["muted"]})
            self.box(s, 80, 64, 1120, 600, paras, anchor="middle")
        elif layout == "big-number":
            self.background(s, C["bg"])
            num = sec.find(lambda k: "number" in k.classes)
            lab = sec.find(lambda k: "label" in k.classes)
            paras = [{"text": num.text() if num else "", "size": 160, "bold": True, "color": C["accent"]}]
            if lab:
                paras.append({"text": lab.text(), "size": 36, "bold": True})
            self.box(s, 80, 64, 1120, 590, paras, anchor="middle")
        else:
            self.background(s, C["bg"])
            # Room for a title of two lines, set on the rule under it; the template's titles wrap the same way.
            self.box(s, 80, 40, 1120, 112, [title], size=44, bold=True, anchor="bottom", floor=30)
            self.rect(s, 80, 162, min(1120, 24 * max(8, len(title))), 4, C["accent"])
            top, bottom = 190, 664
            img = sec.find(lambda k: k.tag == "img")
            tbl = sec.find(lambda k: k.tag == "table")
            if layout == "two-col":
                cols = sec.find(lambda k: "cols" in k.classes)
                halves = cols.child_elems()[:2] if cols else []
                for i, half in enumerate(halves):
                    x = 80 + i * 584
                    if "panel" in half.classes:
                        self.rect(s, x, top, 536, bottom - top, C["soft"])
                        self.box(s, x + 32, top + 28, 472, bottom - top - 56, self.flow(half))
                    else:
                        self.box(s, x, top, 536, bottom - top, self.flow(half))
            elif layout == "image-right":
                cols = sec.find(lambda k: "cols" in k.classes)
                left = cols.child_elems()[0] if cols else sec
                self.box(s, 80, top, 520, bottom - top, self.flow(left), anchor="middle")
                if img is not None:
                    self.picture(s, img.attrs.get("src", ""), 640, top, 560, bottom - top)
            elif layout == "image":
                cap = sec.find(lambda k: "caption" in k.classes)
                if img is not None:
                    self.picture(s, img.attrs.get("src", ""), 80, top, 1120, bottom - top - (36 if cap else 0))
                if cap:
                    self.box(s, 80, bottom - 30, 1120, 30, [cap.text()], size=22, color=C["muted"], shrink=False)
            elif layout == "table" or tbl is not None:
                body = sec.find(lambda k: "body" in k.classes) or sec
                paras = [p for p in self.flow(body) if p]
                y = top
                if paras:
                    self.box(s, 80, top, 1120, 60, paras[:2])
                    y += 70
                if tbl is not None:
                    self.table(s, tbl, 80, y, 1120, bottom - y)
            else:
                body = sec.find(lambda k: "body" in k.classes) or sec
                paras = self.flow(body) if body is not sec else [p for p in self.flow(sec) if p != title]
                if img is not None:
                    self.box(s, 80, top, 560, bottom - top, paras)
                    self.picture(s, img.attrs.get("src", ""), 680, top, 520, bottom - top)
                else:
                    self.box(s, 80, top, 1120, bottom - top, paras)
        self.source(s, sec, C["muted"] if layout not in ("title", "closing", "section") else C["soft"])
        self.notes(s, sec)
        return layout, title


def main(argv) -> int:
    ap = argparse.ArgumentParser(prog="to_pptx.py", description=__doc__.split("\n\n")[0].strip(),
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    ap.add_argument("deck")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pictures", metavar="RENDER_DIR", help="the folder render.mjs wrote (slide-01.png ...)")
    a = ap.parse_args(argv)
    if not a.out.lower().endswith(".pptx"):
        raise Stop(1, "--out must end in .pptx")
    try:
        import pptx  # noqa: F401
        from pptx.util import Emu
    except ImportError:
        raise Stop(3, "this needs python-pptx: `pip install python-pptx` (on a Nouride host plain `pip install` goes into "
                      "your Python env)") from None
    try:
        with open(a.deck, encoding="utf-8") as f:
            html = f.read()
    except OSError as e:
        raise Stop(2, f"cannot read {a.deck}: {e}") from None
    tree = Tree()
    tree.feed(html)
    sections = list(tree.root.find_all(lambda k: k.tag == "section" and "slide" in k.classes))
    if not sections:
        raise Stop(2, f'{a.deck} has no <section class="slide"> - build it from the slides skill\'s templates/deck.html')
    b = Builder(a.deck, css_vars("".join(tree.style)))
    if a.pictures:
        for i, sec in enumerate(sections, start=1):
            png = os.path.join(a.pictures, f"slide-{i:02d}.png")
            if not os.path.exists(png):
                raise Stop(2, f"{png} is missing - run render.mjs on this deck first (same deck, all slides)")
            s = b.prs.slides.add_slide(b.blank)
            s.shapes.add_picture(png, 0, 0, Emu(1280 * PX), Emu(720 * PX))
            b.notes(s, sec)
        print(f"wrote {a.out}: {len(sections)} slide(s) as pictures, with their notes (not editable)")
    else:
        for i, sec in enumerate(sections, start=1):
            layout, title = b.slide_for(sec)
            print(f"slide {i}: {layout} - {title[:60]}")
            # Every word on the HTML slide should be on the PowerPoint slide: a layout that drops a list or a
            # paragraph is otherwise found by the person, not here.
            def words(t):
                return {w for w in re.findall(r"[^\W_]{4,}", t.lower())}
            def spaced(n):
                if isinstance(n, str):
                    return n
                return "" if "notes" in n.classes or n.tag in ("style", "script") else " ".join(spaced(k) for k in n.kids)
            html_words = words(spaced(sec))
            slide = b.prs.slides[i - 1]
            got = set()
            for shp in slide.shapes:
                if shp.has_text_frame:
                    got |= words(shp.text_frame.text)
                if getattr(shp, "has_table", False) and shp.has_table:
                    got |= words(" ".join(c.text for r in shp.table.rows for c in r.cells))
            lost = sorted(html_words - got)
            if lost:
                b.warnings.append(f"slide {i}: words on the HTML slide that are not in the PowerPoint slide: "
                                  f"{', '.join(lost[:8])}{' ...' if len(lost) > 8 else ''} - a part this layout does not carry")
        print(f"wrote {a.out}: {len(sections)} editable slide(s), font {b.font}")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    b.prs.save(a.out)
    for f in b.fits:
        print(f"fit: {f}")
    for w in b.warnings:
        print(f"warning: {w}")
    if not a.pictures:
        print("text measured with " + ("Arial metrics: every box fits" if b.measuring and not any("does not fit" in w for w in b.warnings)
                                       else "Arial metrics" if b.measuring else
                                       "nothing - no Arial/Liberation Sans font or no Pillow here, so fit is unchecked: say so"))
    print("next: if LibreOffice Impress is here, look at it as PowerPoint will show it - "
          "soffice --headless --convert-to pdf, pdftoppm, read")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as e:
        print(f"to_pptx.py: {e}", file=sys.stderr)
        sys.exit(e.code)
