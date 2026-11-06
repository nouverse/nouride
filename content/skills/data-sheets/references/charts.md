# Choosing and checking a chart

A chart is right when a person who sees it for five seconds on a phone takes away the true thing. `chart.py` makes the
mechanical choices (one colour, sorted bars, units, readable text); these are the choices that are yours.

## Which chart

| The question | Chart | chart.py |
|---|---|---|
| which is biggest, how do they rank | sorted bars | `bar` (switches to `barh` past 6 bars or for long labels) |
| how did it change over time | line; bars for 2–6 periods | `line --period month`; `bar` with dates keeps their order |
| how do two groups compare across categories | grouped bars | `--group COL` or `--y "2025,2026"` |
| how do several series move over time | several lines (6 at most) | `line --group COL` |
| what share of a whole, 2–6 parts | pie, or one sorted bar chart | `pie` (refuses past 6) |
| do two measures move together | scatter | `scatter` (prints r; with `--label COL` names up to 25 points) |
| one item against the others | bars with one highlighted | `bar --highlight "Bandung"` |
| several numbers and charts at once: a dashboard, a monthly recap | number tiles and a few charts on one picture | `dashboard_example.py`, or your own script copied from it (SKILL.md §5) |
| a single number | no chart: say the number | |
| how things connect, a process, an architecture | not a chart: a diagram | the `diagrams` skill |

Not offered, on purpose: 3D (hides values behind perspective), dual y-axes (any two lines can be made to "cross"),
stacked areas past three series, donuts and pies with many slices.

## Rules that change what the picture says

- **Bars start at zero.** chart.py always does; a bar from 90 to 100 drawn from 90 looks ten times bigger than it is.
  A line may start elsewhere (it shows change, not size), but chart.py starts it at zero when all values are positive;
  if the change is what matters and it is small next to the level, say the change in numbers too.
- **One colour per series.** Colours for each bar suggest the bars differ in kind. Use colour only for a second
  series, or `--highlight` for the one thing the chart is about.
- **Sort categories by value**, largest first, unless they have an order of their own (months, age groups, sizes,
  ratings): then keep that order (`--sort none` where chart.py cannot tell, e.g. "Small, Medium, Large").
- **Same units, same period.** Do not put IDR and USD, or a monthly and a yearly figure, on one axis.
- **Title = what, where, when**: "Sales by city, Jan–Jun 2026", not "Chart". The axis label carries the unit:
  `--ylabel "Sales" --currency IDR`, `--ylabel "Weight" --unit kg`.
- **Averages are not merged.** With `--agg mean` the small categories are dropped past `--top`, not added into
  "Others" (an average of averages is not an average).
- **Missing is not zero.** A month with no rows is absent from the line, not drawn at zero; say so if it matters.
- **The reader's locale, the data's currency**: `--locale` (en-US, id-ID, de-DE, en-IN …) sets separators, short forms
  (1.25M, 1,25 jt, 1,25 Mio., 12.5L, 125万) and month names on date axes; `--currency` (USD, IDR, EUR …) sets the
  symbol, its side and its decimals. Unclear which? Ask; do not default a person in Jakarta or Berlin to 1,234.5.

## Size and format

- Default `--size wide` is 1440×900 px, sharp on a phone and small to send (50–150 KB). `--size phone` (1000×1200)
  for a chart that will be read only on a phone; `square` for a social post.
- PNG for chats and documents. For print, the same PNG at this size is enough for half an A4 page.

## The look-check, written down

After `read`ing the PNG, one line each (`ok`, or what is wrong):

```text
title says what/where/when: ok
unit on the value axis: ok (Rp)
numbers match the printed list and §4's total: ok (IDR 102,172,000)
labels cut or overlapping: ok
readable at phone width: ok
anything unexplained: March spike = one order of IDR 16.25 million, row 125; said in the message
```

The message that sends the chart carries the last line at least: what the person should notice, and anything odd.
