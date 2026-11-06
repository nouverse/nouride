# A slide that reads

A slide is seen for seconds, from the back of a room or on a phone, while someone is talking. Everything here follows
from that. The numbers are starting points that work at the template's 1280×720, not laws.

## The argument

- **Titles are claims.** "Bandung brought in 30% of sales", not "Sales by city". Read the titles alone, in
  order: they should be the whole argument. If they are not, the deck is a pile of topics.
- **One idea per slide.** Two ideas are two slides; slides are free, attention is not.
- **The order**: what the audience needs to decide or know → the evidence → what to do next. The closing slide
  states the ask or the next step, not "Terima kasih" / "Thank you" alone.
- **Detail lives in the notes**: the template's `<aside class="notes">`. The speaker reads them; the audience reads
  the slide.

## Words and sizes

| Thing | Size in the template | Limit |
|---|---|---|
| deck title | 64–72 px | one sentence, two lines at most |
| slide title | 44 px | two lines at most; a word alone on the second line is reworded (render.mjs: `alone`) |
| body, bullets | 28 px (sub-bullets 24) | 5 bullets, ~40 words per slide, a bullet at most two lines |
| table text | 24 px | 6 rows × 5 columns |
| big number | 160 px | one number, its label in one sentence |
| source, caption | 14–22 px | one line |

Nothing under 20 px except sources; render.mjs measures it. If text does not fit at these sizes, the fix is fewer
words or two slides, never smaller text.

Bullets: parallel, short, no full stops needed, no sub-sub-bullets. A list of six becomes two slides or a table.

## Colour and contrast

- **One accent colour** (`--accent`), used for one thing: what to look at. Not a rainbow per slide.
- **Contrast**: text at least 4.5:1 against its background (3:1 for 30 px+ or bold 24 px+). render.mjs measures it.
  Dark text on white or white on near-black is always safe; mid-grey on light grey is the usual failure.
- **Brand colours** go in `:root`. A brand colour too light for text (yellow, light green) is the accent for shapes
  and rules only; text stays `--fg`.
- Colour is never the only carrier of meaning: "red = loss" also needs the word or the sign.

## Numbers and charts

- Every number with its unit, period and source. Rounded for reading (IDR 30.4 million; $30.4M), exact in the notes.
  Numbers written in the audience's locale; the `data-sheets` skill's `chart.py --locale --currency` does charts.
- **One chart per slide**, its title the claim it proves. Bars sorted, one colour, a highlight for the one bar that
  matters (`chart.py --highlight`). No 3D, no pie past 5–6 slices, no dual axes.
- A table on a slide is for 6 rows or fewer. A big table is an appendix slide or a file sent with the deck.
- A single figure that matters gets the `big-number` layout, not a bullet.

## Pictures

- A picture earns its place by showing something the words cannot: the product, the place, the chart, the person.
  Decorative stock photos ("people shaking hands") are left out.
- Theirs first; found ones only with a licence, credited in `.source` (the motion-graphics skill's assets reference).
- Large enough not to blur: at least as many pixels as the area it fills (an `image` slide is about 1120×450 px).
  Crop to the subject; do not shrink a whole screenshot until it is unreadable.
- Diagrams (how something is connected, a process, an architecture): the `diagrams` skill makes a PNG; use the
  `image` layout.

## Consistency

The same layout for the same kind of slide, the same place for the source, the same colours throughout. Change the
look in `:root` only. The per-round list in SKILL.md §5 asks for it by name, because it is the thing nobody notices
until slide 12.

## Languages

Write the slides in the language the person asked for. Titles in some languages run longer than in English: check the
`alone` and `overflow` findings after translating. Use the language's own number and date format, the same locale the
charts use.
