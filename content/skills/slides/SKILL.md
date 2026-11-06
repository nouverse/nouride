---
name: slides
description: "Read before making any presentation, slide deck, pitch or PowerPoint file. Outline first for a yes, then 16:9 slides as one HTML file rendered to PDF and a PNG per slide, each slide measured (overflow, tiny text, overlap, contrast, words) and looked at before sending; an editable PowerPoint (.pptx) on request, with speaker notes. For a talk, a lecture, a pitch, or a deck from a document or data."
requires: node, python3
needs_tools: exec, read, write, send_file
author: Nouride
---

# Making a slide deck

A deck is written as **one HTML file** from the template beside this file, rendered by a script to a PDF and to one
picture per slide. HTML because you write it reliably and a browser lays it out exactly; the PDF opens anywhere and
looks the same everywhere. PowerPoint comes from the same file when the person needs to edit it in PowerPoint.

What goes wrong is what you cannot see from the code: a title that wraps onto the bullets, a list that
runs off the bottom, 14 px text, grey on grey. So **every slide is measured and looked at before anything is sent**,
and the person approves the outline before you build anything.

## What is beside this file

The SKILLS list gave you this file's path, ending in `slides/SKILL.md`. Below, `SL` stands for that directory's full
path. Write it out in every command.

| File | What it is |
|---|---|
| `templates/deck.html` | the deck template: 16:9 slides, ten layouts, colours and fonts as variables, speaker notes |
| `scripts/render.mjs` | renders the deck to `deck.pdf` + `slide-NN.png` + `sheet.png` (all slides on one picture), measures every slide, writes `notes.md` |
| `scripts/to_pptx.py` | the same deck as an editable `.pptx` (or one picture per slide), with the speaker notes; measures text fit |
| `references/design.md` | the rules for a slide that reads: words, sizes, contrast, charts, pictures. Read it before step 3 |

`render.mjs` borrows Playwright and its browser from the **`browser-automation` skill's folder**: if this machine
has not set it up, do that skill's steps 1 and 2 first (`<private>/browser`, by its full path). `to_pptx.py` needs
`pip install python-pptx` (plain `pip install` goes into your Python env on a Nouride host).

## This machine

Rendering is a browser's work: a ten-slide deck peaked at about 370 MB of memory (measured on a Linux box). Before the
outline, run `browser-automation`'s step 1 here:

| It says | Then |
|---|---|
| fine | go on |
| tight | render once, with nothing else heavy running; `--only` for a slide you fixed |
| not here, as on a 512 MB board | render on another of the person's machines (`browser-automation` step 8), or, with none, say so before the outline: the deck can come as an editable `.pptx` from `to_pptx.py`, which needs no browser, but nobody will have looked at it |

## 1. Ask, briefly, then the outline

Before the outline, know these; ask only what the request and the conversation do not already say, in one message:

- **Who is it for and what should they do after it?** (decide, approve, learn, buy); this sets the title of every slide
- **How long is the talk?** About one slide a minute is a starting guess, not a rule; a 10-minute talk is 8–12 slides
- **Their material and their look**: a logo, brand colours and font, an old deck, photos, data, a document to build
  from. Theirs beats anything found (pictures: §4)
- **Language** of the slides, and **PDF or PowerPoint** (PDF unless they say they will edit it)

Then write the **outline** (the slide titles, one line of content each, and where each fact comes from) and send it:

```text
Deck: "Sales Jan–Jun 2026: Bandung grew, Jakarta fell" · 10 slides · English · PDF
1. [title] First-half sales: Bandung brought in 30%
2. [big-number] IDR 102.2 million in total, 122 sales (sales.xlsx)
3. [image: chart] Bandung largest, Denpasar smallest (chart by city from sales.xlsx)
4. [bullets] March jumped on one IDR 16.25 million order (row 125)
5. [two-col] Coffee vs tea: margin and volume (sales.xlsx)
...
10. [closing] What we ask: more stock for Bandung in Q3
Pictures: your logo (logo.png); a chart made from your data; no stock photos.
```

**Each title is a sentence that says the point** ("Bandung brought in 30% of sales"), not a topic ("Sales by
city"). Someone who reads only the titles gets the argument. Wait for a yes or their changes unless they said to just
make it: changing an outline line is free, rebuilding slides is not.

A deck of more than about 12 slides, or one that needs research or data work first, is long work: from a chat, draft
it as a mission with `mission`, the outline in its brief (it becomes `BRIEF.md`). The person reads the outline on the
mission's page, and starting the mission is the yes. Research for the content: the `research` skill; numbers and
charts from data: the `data-sheets` skill; diagrams (architecture, a process, an org chart): the `diagrams` skill.

## 2. Set up the deck

```sh
mkdir -p <work>/deck/assets && cp SL/templates/deck.html <work>/deck/deck.html
```

`<work>` is a folder in your workspace, or the mission's folder. Never edit the template where it is installed.
Pictures go in `assets/` beside the deck and are referenced as `assets/name.png`.

## 3. Write the slides

Open `deck.html` and read it: the `:root` block holds the colours and the font, and there is one example slide of each
layout. Copy the layouts you need, delete the examples you do not, and fill them in from the outline.

| Layout (`<section class="slide …">`) | For |
|---|---|
| `title` | the first slide: the deck's claim, a subtitle, who and when |
| `bullets` | up to 5 short points under a title (the default) |
| `two-col` | two things compared on the same points, in `.panel`s or plain |
| `big-number` | one figure that is the point: `.number` and `.label` |
| `image` | one chart or picture, as large as the slide allows, with `.caption` / `.source` |
| `image-right` | 2–4 points beside a picture |
| `table` | at most 6 rows × 5 columns; numbers right-aligned with `class="n"` |
| `quote` | a short quote someone really said, with `.who` |
| `section` | a divider between parts |
| `closing` | the ask, the next step, the contact |

Rules that each prevent a real failure (`references/design.md` has the why and more):

- **One idea per slide; at most 5 bullets, at most ~40 words.** The rest goes in the speaker notes. render.mjs flags
  over 6 bullets or 60 words.
- **No text under 20 px** (the template's sizes: body 28, slide title 44, deck title 64–72). Sources and captions
  14–22 px in `.source` / `.caption`.
- **Every number with its unit, period and source**, in `.source` on the slide or in the notes. A number nobody
  measured does not go on a slide; an estimate is marked as one.
- **A source line names something real**: a page you read in this task (with its URL in the notes), a file the person
  gave, or the person. **Never invent one**: no "Source: company security standard", no "internal SOP" you have not
  seen. In a live test a deck of general advice got two made-up sources. General advice needs no source line: leave
  `.source` out, or research the claim first with the `research` skill and cite what you read.
- **Speaker notes** in `<aside class="notes">` on every content slide: what to say, the details that did not fit.
- **Change the look only in `:root`** (colours and font). A brand colour as `--accent`; keep `--fg` on `--bg`
  dark-on-light or light-on-dark (render.mjs measures contrast). The first font in `--font` must be installed on this
  machine; the PDF embeds what was rendered (render.mjs says when a font is missing).
- **No per-slide `style=` sizes and positions.** The layouts are measured to fit; an absolutely placed element is
  where overlap comes from.
- Charts: make them with the `data-sheets` skill's `chart.py` (`--size wide`, the reader's `--locale`), save to
  `assets/`, use the `image` layout. Its default 1440×900 fills an `image` slide sharply.

## 4. Pictures: theirs first, then only with a licence

Ask for their own pictures first (§1). Anything found must have a licence that allows it, and a credit in `.source`:
the **motion-graphics skill's assets reference** (`references/assets.md` in that skill) lists where to find photos,
icons and logos with their licences and how to crop and resize them. Screenshots of a site: take them with the
`browser-automation` skill. A file whose licence you cannot find is not used. `read` every picture before it goes in:
right subject, not blurred, not cut. Brand logos come from the brand's own press kit, never redrawn.

## 5. Render, measure and look, every round

```sh
node SL/scripts/render.mjs <work>/deck/deck.html --browser-dir <private>/browser
```

It writes `<work>/deck/deck-render/` (or `--out DIR`): `deck.pdf`, `slide-01.png` …, `sheet.png`, `notes.md`,
`check.json`, and a `check-NN.png` for each slide with findings, each finding outlined in red and numbered. It prints:

```text
slide 4 "March jumped on one order" - 71 words: 2 finding(s), outlined in check-04.png
  1. overflow: content 17px taller than its area (.body) - cut words, split the slide, or drop a bullet
  2. words: 71 words on the slide (60 at most; move the rest to the notes)
```

| Finding | What it means | Fix |
|---|---|---|
| `overflow` | text or a picture off the slide or past its area | fewer words, split the slide, a smaller picture; never smaller text below 20 px |
| `crowded` | body text in the bottom band, where the source line goes | the same |
| `margin` | text within 32 px of the edge | remove the `style=` that moved it; keep to the layouts |
| `small` | text under 20 px (14 px for sources) | larger, and fewer words to make room |
| `overlap` | text over text, or over a picture | remove absolute positioning; one element per place |
| `contrast` | text too close to its background in colour | darker text or lighter background, in `:root` |
| `words` | over 60 words or 6 bullets | move detail to the notes; split into two slides |
| `alone` | a heading's last line holds one word | shorten the title, or put a `<br>` where it should break |
| `image` | a picture did not load | the path is relative to the deck: `assets/x.png`, and the file is there |
| `empty` | nothing on the slide | delete it, or fill it |
| `pdf: … pages for … slides` | in print a slide runs onto another page, while its picture looks right; the PDF is printed, the pictures are not | the command it prints renders the PDF's pages: find the one that spilled, and remove what print changes (a `@media print` rule, a height, a margin) |

Exit `4` means findings; `0` means nothing measured wrong, **not** that the deck is right. Then **look**: `read`
`sheet.png` (the whole deck) **and every `slide-NN.png`**. The script's last line lists them; read them all in one
`read` call. The sheet alone is not enough: there a slide is a quarter of its width, and a typo, a wrong number or a
cramped line cannot be seen. Write down one line for each
of these, every round, with the slide number or `none`:

```text
Round 2, 10 slides
- measured findings (render.mjs): none
- a title that is a topic, not a point: 6 ("Products") -> "Coffee is half of all sales"
- two slides that say the same: none
- a slide with nothing to look at but bullets, three in a row: 5-7 -> 6 becomes a big-number
- a picture that is blurred, cut badly, or unrelated: none
- a number without unit, period or source: 3, the chart has no period in its title
- the look inconsistent (a colour, a font, a size that differs): none
- spelling, and the language the person asked for: none
- the last slide says what to do next: yes
```

A check kept in your head is the one that gets skipped. A line that is not `none` is fixed, then **render again and
read again**; a fix on one slide can push another over. Three rounds is the limit: then send the sheet and your list
and ask what to change. If your model cannot see images, say so, and send `sheet.png` for the person to judge.

## 6. PowerPoint, when asked

```sh
python3 SL/scripts/to_pptx.py <work>/deck/deck.html --out <work>/deck/deck.pptx
```

Editable: real titles, bullets, tables, pictures and the speaker notes, in the deck's colours, in Arial. It measures
every text box with Arial's metrics and shrinks text that does not fit (`fit:` lines), down to 20 px; past that it
says `warning: ... does not fit`. Shorten that slide in the HTML and run both scripts again. Only the template's
layouts are carried; anything custom is not.

When the PowerPoint must look exactly like the PDF and nobody will edit it: `--pictures <work>/deck/deck-render`
puts each rendered slide in as a picture, with its notes.

To see the `.pptx` as PowerPoint shows it, where LibreOffice with Impress is installed:
`soffice --headless --convert-to pdf --outdir <work>/deck/pptx-look <work>/deck/deck.pptx`, then
`pdftoppm -png -r 50 <work>/deck/pptx-look/deck.pdf <work>/deck/pptx-look/p` and `read` the pages. If `soffice`
prints `Error: source file could not be loaded` for the `.pptx`, Impress is not installed (a server often has only
Writer). Do not retry with another profile or folder; installing it is the person's call. Without Impress, say in the
message that the PowerPoint was measured but not viewed, and that the PDF is the reference.

`to_pptx.py` also compares each slide's words with the HTML: `warning: slide N: words on the HTML slide that are not
in the PowerPoint slide` means a part of that slide was not carried: move it into a layout's usual place (a list
in `.body`, a paragraph) and run it again, or use `--pictures`.

## 7. Send

- `deck.pdf` with `send_file`, always; it opens on a phone. Then the `.pptx` if asked.
- With it, a short message: how many slides, what you assumed, the last round's list in two or three lines, and the
  notes (`notes.md`) as a file if they will present it.
- For a link they can open in a browser and present from: the `share-preview` skill serves the deck folder
  (`python3 -m http.server` in `<work>/deck`, then `deck.html`). The HTML scrolls slide by slide; it is a preview,
  not hosting.
- In a mission: `mission` done with `deck.pdf` (and `deck.pptx`) in `files`, the round list in the report. The
  renders, sheet and check pictures are evidence, not deliverables: name their folder in the report.

Chat apps cap uploads (a Telegram bot at 50 MB); a deck with large photos: resize them (the assets reference has the
command) and render again.
