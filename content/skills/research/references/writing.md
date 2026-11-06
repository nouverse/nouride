# Shapes of an answer

The answer comes first, the support after it. Every sentence that carries a fact carries its `[n]`. Write in the
person's language; quote sources in theirs.

## A chat answer

For a question asked in the chat with a short answer. Under about 300 words; a phone screen is narrow.

```text
Yes, worth it. It pays back in about <a>–<b> years (my estimate, computed from [1]–[4]), as long as most of the power
is used at home: what is fed into the grid earns <n> cents per kWh [2], far less than the <n> cents a kWh costs [4].

- Installing 8 kWp: EUR <a>–<b> (installer quotes, <month year>) [1]
- Output near Munich: about <n> kWh per kWp per year [3]
- Household power: <n> cents per kWh (statistics office, <period>) [4]

Not certain: the prices in [1] are installers' claims; there is no official price data.

Sources:
1. <title>, <publisher>, <date>. <url>
2. ...
```

Write it in the person's language; the shape stays the same.

(Everything in `<…>` is a placeholder. Every figure in a real answer comes from the ledger.)

- **First line: the answer** (yes/no, the number, the recommendation) and its main condition.
- Then 3–6 lines of support, each with its source.
- Then what is uncertain or unknown, in one or two lines. Leave it out only if nothing is.
- Sources at the end, numbered as cited. A computed figure is marked as yours, with which sources it came from.

## A report

For a survey, a comparison of several options, or anything the person will keep or pass on. Markdown; PDF when asked
(SKILL.md §7).

```markdown
# <The question, as a title>

<Date> · <Who it is for, if anyone>

## Summary
3–6 sentences: the answer, the main reasons, the main uncertainty. Someone who reads only this knows what you found.

## <One section per sub-question>
What the sources say, with [n]. Where they disagree, both, and why they differ.
A table where several options are compared on the same points, every cell with a source or marked "—" (not found).

## Calculation (only when you computed something)
The formula, each input with its [n], the result marked as an estimate.

## What is not known
What you looked for and did not find, and where you looked.

## Method
One short paragraph: languages searched, kinds of sources, the date range, what was excluded and why.

## Sources (written by `ledger.py render`)
```

- A comparison table: options as rows, the points the person cares about as columns. Same units in a column. Each
  cell's figure is cited (`12 million [3]`), or `—` when not found; never left blank silently, never filled by a guess.
- Headings in the report's language (the person's).
- Do not pad. A section with nothing to say is dropped, not filled.

## Citations

- `[n]` after the fact it supports, before the full stop: `… rose 2.1% [3].`
- Two sources: `[3, 5]`. A paragraph resting on one source cites it once, at its first fact, and again where a
  different source comes in.
- A quote: in quotation marks, with its `[n]`. Translate it only if the person's language differs, and say
  "(translated)" in the report's language.
- The list at the end is written by `ledger.py render` (title, publisher, date, URL, accessed date). Do not edit the
  numbers by hand afterwards; change the report and render again.
- `ledger.py check` reads `[1]` to `[999]` as citations. Do not put other numbers in square brackets in the report
  (write a year as 2024, not [2024]).
