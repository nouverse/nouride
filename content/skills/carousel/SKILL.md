---
name: carousel
description: "Read before making a carousel or any set of pictures to swipe through on Instagram, LinkedIn, TikTok or a chat. The form asked once, an outline with sources for a yes, every slide in one HTML file drawn at the platform's exact size, measured for a phone (small text, cut, off the edge, contrast, a missing glyph) and looked at in rounds, then sent in order as one album, or as a PDF. It has no look of its own: colours and fonts come from the person, their brand, or the request."
requires: node, npx
needs_tools: exec, read, write, send_file
author: Nouride
---

# Making a carousel

A carousel is a handful of pictures somebody swipes through on a phone: a first slide that makes them stop, one
idea a slide, and a last one that says what to do next. It is **written as one HTML file, every slide in it**, and a
real browser draws each slide at the exact size the platform shows. One file because that is what keeps eight slides
looking like one thing: one stylesheet, one margin, one size of heading. Never a picture made any other way.

What goes wrong is what you cannot see from the code: text that is fine at your size and unreadable on a phone, a
line that runs off the slide, pale grey on white, an emoji drawn as an empty box, eight slides that do not look like
one set. So **every slide is drawn, measured and looked at, round after round, before anything is sent**.

And what is wrong with a carousel most often is its words, which no script measures: a claim nobody gave you, a
slide that says two things. So there are **two turns, not one**: the first ends with the outline, the words of every
slide, sent for a yes. Nothing is written to a file or drawn before that yes.

## This skill has no look of its own

Nothing in this skill names a colour, a font, a corner, a layout or a style, and no template comes with it. Where a
carousel's look comes from, in this order:

1. **What the person said**: the brief, a post of theirs they like, a reference they sent (`read` it).
2. **What is theirs already**: their brand, their logo, their feed, their site. A carousel for an account that exists
   looks like that account. Open their site or their profile with the `browser-automation` skill and take the
   colours and the fonts from there; ask for the logo as a file.
3. **With neither, yours, chosen for this request**: who it is for and what it should feel like. Say in one line what
   you chose and why, so they can turn it. Not the look of the last carousel you made: each request gets its own.

The rules below are floors for being read on a phone, never a taste. A carousel can pass every one of them and be
dull: that part is your eye, in step 4.

## What is beside this file

The SKILLS list gave you this file's path, ending in `carousel/SKILL.md`. Below, `CR` stands for that directory's
full path. Write it out in every command.

| File | What it is |
|---|---|
| `scripts/slides.mjs` | draws every slide at its exact size, writes the pictures and one sheet of all of them, measures each slide and prints the findings; with `--pdf`, the document too. Step 4 has its whole command: its code and its `--help` are not for reading |
| `scripts/judge.mjs` | the rules `slides.mjs` measures by, each with its number and where the number comes from. Read it only when a finding surprises you |

`slides.mjs` borrows Playwright and its browser from the **`browser-automation` skill's folder**, `<private>/browser`
by its full path. The next section says whether it is there.

**Every step you take is paid for again by every step after it**: what you read, what you write and what a command
prints all stay in front of you until the turn ends. So this skill is written to be followed in few steps: read only
what it names, when it names it; one command where one will do; a fix as an edit, never the file written again.

## This machine

Drawing is a browser's work: a carousel of five slides peaked at 93 MB of memory and took 2.3 seconds (measured on a
Linux box, three runs; a slide heavy with pictures takes more). One command, before you write anything, says whether
this machine can and whether the browser is set up:

```sh
free -m 2>/dev/null | awk '/^Mem:/{print "avail_mb", $7}' || echo "total_mb $(( $(sysctl -n hw.memsize) / 1048576 ))"
ls <private>/browser/node_modules/playwright-core >/dev/null 2>&1 && echo "browser: set up" || echo "browser: not set up"
```

| It says | Then |
|---|---|
| `browser: set up`, and 1 GB available or more | go on. Do **not** read the `browser-automation` skill: nothing below needs it |
| `browser: not set up` | load the `browser-automation` skill, do its steps 1 and 2 once, and come back |
| 600 MB to 1 GB available | tight: render with nothing else heavy running |
| under 600 MB available: not here, as on a 512 MB board | draw on another of the person's machines (`browser-automation` step 8). With none, say so **before** you start: you can still write the outline and the HTML file, but there will be no pictures from this machine |

## 1. Ask what form, once

Before anything is written, know these. Ask only what the request and the conversation do not already say, in
**one** message, in the person's language, as a list they can answer with a number:

- **Where it is posted**, which decides the shape of every slide:
  1. Instagram or LinkedIn feed, portrait: **4:5** (1080 by 1350)
  2. square: **1:1** (1080 by 1080)
  3. a taller portrait, where the account posts it: **3:4** (1080 by 1440)
  4. a story, a status, TikTok photos: **9:16** (1080 by 1920), a full phone screen
- **What it is about, and from what**: the topic, and the material it is made from (their notes, a page, a document,
  numbers). You write from what they give you or what you can open, not from memory.
- **How many slides.** With nothing said: as many as it has ideas, most often five to eight.
- **Their look**: the brand, the logo as a file, the account's name as it should stand on the last slide, a post of
  theirs to match. "Nothing yet" is an answer: then you choose, and say what you chose.
- **The caption**: whether they want the words that go under the post too, and hashtags or none.

```text
Before I make it, four things:
1. Where is it posted? (1) Instagram or LinkedIn feed, portrait, (2) square, (3) taller portrait,
   (4) a story or TikTok, full screen.
2. What is it made from: shall I work from the page you sent, or do you have notes?
3. Is there a look to match: your brand colours, your logo, a post you like? Or shall I choose?
4. Do you want the caption for under the post too?
```

When their words already say it ("carousel IG", "buat LinkedIn", "just make it"), do not ask: say in one line what you
took as the answer. With nothing said and nobody to ask, it is 4:5, and the caption comes with it.

A carousel that needs research first, or more than about ten slides, is long work: from a chat, draft it as a mission
with `mission`, the form and the outline in its brief.

## 2. The outline, for a yes

**Send the outline and end your turn there.** In the turn that sends it you write no file and run no command: the
next turn, after their yes, is the one that draws. Changing a line of an outline is free; changing a drawn slide is a
round. Only two things skip the wait: they said to just make it ("langsung aja", "no need to ask"), or you are in a
mission, whose brief is the outline they said yes to.

Write it slide by slide, every line that states a fact with its `source:`, where you read it:

```text
7 slides, 4:5, for <the account>. Look: <theirs, or what you chose and why, in one line>.
1. (the first slide) <the line that makes someone stop: what they get, or the question they have>
2. <one idea, in a heading and a sentence>                     source: <their notes, p. 2>
3. <one idea>                                                  source: <the page they sent>
   <a reason or a tip you added to it>                         source: mine, not from your notes
...
7. (the last slide) <what to do next, and the account's name>  source: <the name they gave>
Caption: <two or three sentences, then the hashtags if they want them>
```

What makes a carousel work is its order, not its look, so settle it here:

- **The first slide is the only one everybody sees.** It says what the swipe is worth, in a line read in a second,
  and it holds no logo wall and no greeting.
- **One idea a slide.** A slide with two is two slides. A heading and a sentence, or a heading and three short
  points: someone swiping gives a slide a few seconds.
- **Each slide leads to the next**: a step, a count, a question the next one answers. The order is the story.
- **The last slide says what to do**: save it, follow, open the link, write to them. With the account's name.
- **Every fact has a source** you can name. A line with none is one you made up: a number, a quote, a claim about
  their product. Ask for it or take it from their material before it goes on a slide. A statistic nobody measured does
  not go on a slide.
- **What you add to their material is in the outline too**: a tip, a reason, a number of seconds they did not give
  you. Marked `source: mine, not from your notes`, so they can strike it. Nothing reaches a slide that was not a
  line of the outline.
- **Their language**, the way their readers write it.

The outline they said yes to is what you draw: a slide's words do not grow while you draw it.

## 3. Write the slides, one HTML file

This step starts once the outline has its yes. `<work>` is a folder in your workspace, or the mission's folder. Every slide is in **one** file,
`<work>/carousel/slides.html`, written with `write`, which makes the folders. Pictures of theirs go in
`<work>/carousel/assets/`. Each rule here prevents a failure that has happened:

- **A slide is an element with the class `slide`**, one after another in the order they are posted:
  `<section class="slide">`. `slides.mjs` draws each one as a picture of its own.
- **One rule gives every slide its size**, the size from step 1, and nothing may stretch it:
  `.slide { width: 1080px; height: 1350px; overflow: hidden; position: relative; box-sizing: border-box; }`.
  Sizes inside a slide are in `px`: a slide is a picture, not a page that is resized.
- **One stylesheet for all of them**, in a `<style>` in the file: the margin, the heading, the body text and the
  page mark are each written once and used on every slide. That is what makes them one set. A slide that needs to
  differ (the first, the last) adds a class; it does not start again.
- **Text for a phone.** A slide is drawn 1080 px wide and read on a phone at about a third of that. `slides.mjs`
  holds every piece of text to 33 px (12 px on the phone); that is the floor for a footnote, and what is read is
  larger than the floor. Fewer words make room: never smaller text.
- **The same margin on every slide**, and nothing closer to an edge than 5% of the slide. On a **9:16** slide, what
  matters stays out of the top 14%, the bottom 35% and the outer 6% of each side: the app draws its own bars and
  buttons there.
- **The outline's words**, every slide of it, in its order, and no more: a slide that grew a second idea while you
  wrote it is cut back before it is drawn. No lorem ipsum (`slides.mjs` finds it).
- **Pictures: theirs first.** Otherwise a plain box that says what goes there ("photo of the product, 4:5"). Never a
  photo from the web you have no licence for; the `motion-graphics` skill's `references/assets.md` says where to find
  ones you may use. A picture's path is relative to the file.
- **Icons are inline SVG or words.** An icon font from a CDN is an empty square offline, and an **emoji** is drawn
  only by a machine that has a font for it: `slides.mjs` says when it has none (`glyph`).
- **Fonts**: the ones their brand names, loaded with a `<link>` or `@font-face`, with a fallback in the list.
  `slides.mjs` says when a font was not there and the slides were drawn in the next one.
- **No script.** A slide is still: nothing on it moves, loads late or is pressed.
- **A page mark and a "swipe" cue are theirs to want.** When a slide has one, every slide has it in the same place.

## 4. Render, measure and look, every round

One command a round. This is all of it: there is nothing to look up in its `--help`.

```sh
node CR/scripts/slides.mjs <work>/carousel/slides.html --browser-dir <private>/browser --size 4:5
```

`--size` is the shape from step 1 (`4:5`, `1:1`, `3:4`, `9:16`, or a size of their own as `1200x1500`). Add `--pdf`
when it is posted as a document (LinkedIn), for `carousel.pdf`, a page a slide.

It writes `<work>/carousel/out/` (or `--out DIR`): `slide-01.png`, `slide-02.png` and so on, each slide at its exact
size, which is what the person is sent; `sheet.png`, every slide in one picture, numbered, which is what **you**
read; and `check-03.png` for a slide where something was found, each finding outlined in red and numbered. It prints:

```text
slide 1: 9 word(s), largest text 112px: nothing measured wrong
slide 3: 64 word(s), largest text 72px: 2 finding(s), outlined in check-03.png
  1. small: 26px text (under 33, which is 12px on a phone): <p.note> "Berlaku sampai akhir bulan" (slides.html:88, its rule at :31)
  2. outside: runs 40px past the slide's right edge, where the picture ends: <h2> "Pengiriman ke seluruh Indonesia" (slides.html:86)
```

**A finding says where the fix is**: the element, what causes it, and the line of your file it stands on and the
line of its CSS rule. Fix it there. Nothing has to be read again to find the place: not your own file from its top,
and never the scripts, which say nothing a finding does not.

| Finding | What it means | Fix |
|---|---|---|
| `size` | a slide did not come out at the size asked for | the one rule of step 3, and nothing that stretches it |
| `small` | text under 33 px: under 12 px once a phone shows the slide | larger, and fewer words to make room |
| `outside` | text runs past the slide's edge: it is cut off in the picture | a shorter line, a smaller box, or less of it |
| `edge` | text closer to an edge than 5% of the slide | the same margin as every other slide |
| `covered` | on a 9:16 slide, text where the app draws over it | toward the middle; kept on purpose, it is said in your message |
| `contrast` | text too close in colour to what is behind it | darker or lighter, within the carousel's own colours |
| `cut` | text cut off by a box inside the slide | let the box grow, wrap, or say less |
| `overlap` | text over other text | one thing per place |
| `picture` | a picture did not load | the path is relative to the file, and the file is there |
| `glyph` | a character this machine has no glyph for, drawn as an empty box: an emoji, most often | an inline SVG, or a word |
| `filler` | lorem ipsum | the slide's real words |
| `empty` | nothing on a slide | read the `page:` lines it printed |

Exit `4` means findings; `0` means nothing measured wrong, **not** that the carousel is good. The words a slide
says and its largest text are printed for every slide: a slide with three times the words of the others, or a
heading a size of its own, is one to look at.

Then **look**. The script's last line names the pictures to read: `sheet.png` and the check pictures, all in **one**
`read` call. The sheet is the whole set side by side, which is how to see whether it is one set. Read a single
`slide-NN.png` only when the sheet leaves a question about that slide: each picture you read is carried by every step
after it. Then write one line for each of these, every round, with the slide's number, or `none`:

```text
Round 2, 7 slides, 4:5
- measured findings (slides.mjs): none
- the first slide, alone, makes someone stop, and can be read in a second: its line is two lines long -> shorter
- one idea a slide, and no slide with far more words than the rest: 5 says two things -> split
- they are one set: the same margin, the same heading, the same place for the page mark: 4's heading is larger -> one size
- each leads to the next, and the last says what to do, with the account's name: none
- the words are the outline's and no more, in their language, none cut or wrapped badly: none
- a slide is used: nothing crowded into its top with the rest of it empty: 2 to 4 end halfway down -> the body is larger
- it looks like theirs, not like the last thing I made: none
- everything they asked for is there, and nothing they did not: none
```

A check kept in your head is the one that gets skipped. A line that is not `none` is fixed, then **render again and
read again**: a fix on one slide can move another, since they share their rules. **A fix is an edit**: every fix of
a round in ONE `multi_edit`, at the lines the findings name, and never the whole file written a second time. To see
a few lines before you change them, `read` that slice (`offset`, `limit`), once.

**The rounds are the plan.** Drawing a carousel is one turn's work: it needs no `plan` and no notes of its own. **Four
rounds is the limit**: then send what you have with your list and ask what to change. A finding you decide to keep,
because it is what they asked for, is named in your message, not left for them to find. If your model cannot see
images, say so: fix what is measured, and send the pictures for the person to judge.

## 5. Send it

With it, a short message, not a tour of the slides, which they can see: what you took as given, what you chose for
the look when nothing was said and why, what the rounds found and fixed in a line or two, and anything you kept on
purpose.

- **The slides, as one set**: ONE `send_file` call with every slide in `paths`, in order
  (`<work>/carousel/out/slide-01.png`, `slide-02.png`, ...). They arrive together and in order, as one album where
  the chat has albums. Never a call a slide: that is eight messages, and no album. More than twenty slides go in two
  calls.
- **The caption**, when they wanted it: in your message, as text they can copy, not on a picture and not as the
  album's caption. The hashtags on a line of their own.
- **A document** (LinkedIn): the round's command with `--pdf`, then `send_file` `carousel.pdf`.
- **A link** to look at it first: load the `share-preview` skill and follow it, serving `<work>/carousel`.
- In a mission: `mission` done with the slides in `files`, the round list in the report. The sheet and the check
  pictures are evidence, not what is delivered.

You do not post it: where it goes is theirs to do, unless they gave you a way to post and asked you to.

## 6. When they want a change

- **The change is made in the file they saw**, never in a new carousel from nothing: they would lose what they
  liked.
- **Keep what they saw first**: `cp -r <work>/carousel <work>/carousel-v1` (then `-v2`, and so on).
- A change of words is a change of the outline first: say the new line back in your message when it is not theirs
  word for word.
- The change itself is an `edit` or a `multi_edit` of the file, as a fix is. Then step 4 again, the sheet read
  again: the slides share their rules, so a change to one is a change to look for on all. Send the whole set again,
  in one call, so the album they keep is the right one.
- **Another shape of the same carousel** (the feed's 4:5 as a 9:16 story): copy the file, change the one size rule,
  render with the other `--size`, and look again. What fitted one shape is not placed for the other.
