---
name: mockup-design
description: "Read before designing or mocking up a screen, a page, an app or a site for someone to look at. HTML first, one file per screen that works at a desktop's and a phone's width, drawn in a real browser, measured and looked at in rounds before anything is sent, then delivered the way the person picks: a link to open, pictures, pictures inside a phone and a laptop, or the HTML file. It has no look of its own: colours and fonts come from the person, their brand, or the request."
requires: node, npx
needs_tools: exec, read, write, send_file
author: Nouride
---

# Making a mockup

A mockup is **written as HTML first, always**: one file per screen, drawn by a real browser at a desktop's width and
at a phone's. Never a picture made any other way: not an image generator, not a drawing in SVG, not boxes in text.
HTML because you write it reliably, a browser lays it out exactly, one file is both the desktop and the phone, the
person can open it and press things, and it is the start of the real page if they like it.

What goes wrong is what you cannot see from the code: a page that scrolls sideways on a phone, a button too small for
a finger, grey text on grey, a desktop layout squeezed into a phone's width. So **every screen is drawn at both
widths, measured and looked at, round after round, before anything is sent**, and the person says first what form
they want it in.

## This skill has no look of its own

Nothing in this skill names a colour, a font, a corner, a spacing or a style, and no template comes with it. Where a
mockup's look comes from, in this order:

1. **What the person said**: the brief, a reference they named, a screenshot they sent (`read` it).
2. **What is theirs already**: their brand, their site, their app. Read it before you draw. In their project, the
   stylesheet or the theme holds the colours, the fonts, the corners and the spacing; on the web, open their site
   with the `browser-automation` skill and take them from there. A new page for a product that exists looks like
   that product.
3. **With neither, yours, chosen for this request**: who it is for and what it should feel like. Say in one line what
   you chose and why, so they can turn it. Not the look of the last mockup you made: each request gets its own.

The rules below are floors for use (can it be read, can it be pressed, does it fit), never a taste. A page can pass
every one of them and be ugly: that part is your eye, in step 3.

## What is beside this file

The SKILLS list gave you this file's path, ending in `mockup-design/SKILL.md`. Below, `MK` stands for that
directory's full path. Write it out in every command.

| File | What it is |
|---|---|
| `scripts/render.mjs` | draws each screen at a desktop's and a phone's width, writes the pictures, measures every screen and prints the findings. `--help` says how it is run: its code is not for reading |
| `scripts/judge.mjs` | the rules `render.mjs` measures by, each with its number and where the number comes from. Read it only when a finding surprises you |
| `scripts/frame.mjs` | puts a screen's pictures inside a phone and a laptop, for a person who asked for that. `--help` says how it is run |
| `references/craft.md` | what to look for that no script can measure. Read it before your first round |

`render.mjs` and `frame.mjs` borrow Playwright and its browser from the **`browser-automation` skill's folder**: if
this machine has not set it up, do that skill's steps 1 and 2 first (`<private>/browser`, by its full path).

## This machine

Drawing is a browser's work: three small screens at both widths peaked at about 130 MB of memory (measured on a Linux
box), and a screen heavy with pictures takes more. Before you write anything, run `browser-automation`'s step 1 here:

| It says | Then |
|---|---|
| fine | go on |
| tight | render with nothing else heavy running, and one screen at a time (`--only desktop`, then `--only mobile`) |
| not here, as on a 512 MB board | draw on another of the person's machines (`browser-automation` step 8). With none, say so **before** you start: you can still write the mockup and send it as a link or as the HTML file, but there will be no pictures, and nobody will have looked at it. That is theirs to accept |

## 1. Ask what form, once

Before anything is drawn, know these. Ask only what the request and the conversation do not already say, in **one**
message, in the person's language, as a list they can answer with a number:

- **What form they want it in**, more than one if they like:
  1. a **link** to open and press things in, on their phone too
  2. **pictures**: each screen at a desktop's width and at a phone's
  3. pictures **inside a phone and a laptop**, the way a product is shown off
  4. the **HTML file** itself
- **What it is of**: which screens (one is fine), who uses it, and the one thing a person must be able to do there.
- **Their look**: a brand, a site or an app to match, a reference they like, light or dark. "Nothing yet" is an
  answer: then you choose, and say what you chose.

```text
Before I draw it, three things:
1. How do you want it? (1) a link you can open and click, (2) pictures, desktop and phone,
   (3) pictures inside a phone and a laptop, (4) the HTML file. More than one is fine.
2. Which screens? I am thinking the home page and the order page.
3. Is there a look to match: your site, your brand colours, something you like? Or shall I choose?
```

When their words already say it ("send me a picture", "kirim link-nya", "just make it"), do not ask: say in one
line what you took as the answer. With nothing said and nobody to ask, it is pictures (2).

More than about four screens, or screens that need research first, is long work: from a chat, draft it as a mission
with `mission`, the screens and the form in its brief.

## 2. Write the screens, HTML first

```sh
mkdir -p <work>/mockup/assets
```

`<work>` is a folder in your workspace, or the mission's folder. One file per screen, named for the screen:
`<work>/mockup/home.html`, `<work>/mockup/order.html`. Each rule here prevents a failure that has happened:

- **A file opens by itself.** Its CSS is in a `<style>` in the file, or in one `style.css` beside the screens when
  several share it. No build step and nothing to install: the person may open the file with a double click.
- **Every file has** `<meta name="viewport" content="width=device-width, initial-scale=1">`. Without it a phone
  draws the page as wide as a desk and shrinks it.
- **One file, both widths.** The phone's layout is designed, not the desktop's squeezed: columns become one, the
  menu changes shape, what matters most comes first, and what is pressed is the size of a fingertip. Media queries,
  in the same file.
- **The page's real words**, in the person's language: what the screen would say on an ordinary day, with names,
  prices and dates as their country writes them, and a long name where long names happen. No lorem ipsum
  (`render.mjs` finds it). What you do not know about their product you ask, or take from their site; a number you
  made up to fill a table is plainly a sample.
- **The screen as it is most of the time.** An empty, a loading or a failed state is a file of its own, when they
  ask for it or when it is the point.
- **Pictures: theirs first.** Otherwise a plain box that says what goes there ("product photo, 4:3"). Never a photo
  from the web you have no licence for; the `motion-graphics` skill's `references/assets.md` says where to find
  ones you may use. Icons are inline SVG or words: an icon font from a CDN is an empty square offline.
- **Fonts**: the ones their brand names, loaded with a `<link>` or `@font-face`, with a fallback in the list.
  `render.mjs` says when a font was not there and the page was drawn in the next one.
- **Screens that lead to each other link to each other** (`<a href="order.html">`), so the link form can be
  clicked through.
- **The layout is CSS.** A script is for what is pressed (a menu that opens, a tab), never for where things sit.
- **Light and dark**, when they asked for both: under `prefers-color-scheme`, so `--dark` draws the second one.

## 3. Render, measure and look, every round

Read `references/craft.md` once, before the first round. Then, every round:

```sh
node MK/scripts/render.mjs <work>/mockup/home.html <work>/mockup/order.html --browser-dir <private>/browser
```

It writes `<work>/mockup/render/` (or `--out DIR`). For a screen named `home`: `home-desktop.png` and
`home-mobile.png`, the whole page at each width, which is what the person is sent; `home-desktop-1.png`,
`home-mobile-1.png`, `-2.png` and so on, the same page one window at a time, which is what **you** read; and
`home-mobile-check.png` where something was found, each finding outlined in red and numbered. It prints:

```text
home at mobile (390 wide, 2140px tall): 2 finding(s), outlined in home-mobile-check.png
  1. sideways: the page is 38px wider than the window (390px) and scrolls sideways
  2. tap: 30x26 to press (under 44x44): <a.more> "See all"
```

| Finding | What it means | Fix |
|---|---|---|
| `sideways` | the page is wider than the window and scrolls sideways; what sticks out is named | let it wrap, shrink, or scroll inside its own box: a fixed width, a long word, a table, a full width plus padding |
| `viewport` | no viewport tag, so a phone shrinks the page | the tag in step 2 |
| `small` | text under 12 px | larger, and fewer words to make room; never smaller text to make things fit |
| `zoom` | at a phone's width, a field with text under 16 px: the phone zooms the page when it is tapped | 16 px or more in fields |
| `tap` | at a phone's width, something to press under 44 by 44 px | padding counts: give it the height and the width |
| `contrast` | text too close in colour to what is behind it | darker or lighter, within the page's own colours |
| `cut` | text cut off by its own box | let the box grow, wrap, or say less |
| `overlap` | text over other text | one thing per place: remove what put them together |
| `picture` | a picture did not load | the path is relative to the screen's file, and the file is there |
| `filler` | lorem ipsum | the page's real words |
| `empty` | nothing was drawn | read the `page:` lines it printed |

Exit `4` means findings; `0` means nothing measured wrong, **not** that the mockup is good. `--only mobile` draws
one width, `--also tablet` a third, `--dark` each screen again as a device set to dark shows it. A served mockup is
drawn from its address: `node MK/scripts/render.mjs http://127.0.0.1:8787/order ...`.

Then **look**. The script's last line names the pictures to read: read them all in **one** `read` call, each window
of each screen at each width. The whole-page picture alone is not enough: a phone's page in one picture is a third
of its size, and nothing in it can be judged. Then write one line for each of these, every round, with the screen
and the width, or `none`:

```text
Round 2, 2 screens, desktop and phone
- measured findings (render.mjs): none
- the first thing the eye lands on is the thing that matters: order, phone: the total is below the fold -> moved up
- the phone's layout is designed, not the desktop's squeezed: none
- things that should line up, and space that is even: home, desktop: the cards' titles sit at two heights -> one
- the same thing looks the same everywhere (a button, a card, a heading): none
- the words: real, in their language, none cut or wrapped badly: order: "Lanjutkan pembayaran" breaks in two -> shorter
- it looks like theirs, not like the last thing I made: none
- everything they asked for is there, and nothing they did not: missing the "pay later" choice -> added
```

A check kept in your head is the one that gets skipped. A line that is not `none` is fixed, then **render again and
read again**: a fix at one width can break the other. **Four rounds is the limit**: then send what you have with
your list and ask what to change. A finding you decide to keep, because it is what they asked for, is named in your
message, not left for them to find. If your model cannot see images, say so: fix what is measured, and send the
pictures for the person to judge.

## 4. Send it, the way they picked

Both widths, always: the desktop and the phone. With it, a short message, not a tour of the screen, which they can
see: what you took as given, what you chose for the look when nothing was said and why, what is not done, and what
the rounds found and fixed, in two or three lines.

- **Pictures**: `send_file` each `<name>-desktop.png` and `<name>-mobile.png` from the render folder, each with a
  caption that says the screen and the width.
- **Inside a phone and a laptop**:

  ```sh
  node MK/scripts/frame.mjs --browser-dir <private>/browser --out <work>/mockup/render --name home \
    --phone <work>/mockup/render/home-mobile-1.png --laptop <work>/mockup/render/home-desktop-1.png --bg "<a colour of the mockup's own>"
  ```

  It writes `home-phone.png`, `home-laptop.png` and `home-devices.png`, the two together. A device shows one
  screen: the first window of the page, whole, with the phone's status band above it. `--bg` is what the devices stand
  on: one of the mockup's own colours, so the picture belongs to it; `transparent` for none; a plain grey when you
  give nothing. `read` what it wrote before you send it, then `send_file` `home-devices.png`, and the whole-page
  pictures too when the page is longer than one screen.
- **A link**: load the `share-preview` skill and follow it, serving the mockup's folder
  (`python3 -m http.server 8787 --bind 127.0.0.1` with `cwd` set to `<work>/mockup`), and send the address of the
  first screen. Say what `share-preview` says to say: anyone with the link can open it, and it lasts while this
  machine keeps it up.
- **The HTML file**: `send_file` the screen's `.html`, with one line that it opens in any browser. A screen with
  pictures beside it is sent as the folder, zipped: `cd <work> && zip -r mockup.zip mockup -x "mockup/render/*"`.
- In a mission: `mission` done with what they picked in `files`, the round list in the report. The check pictures
  and the windows are evidence, not what is delivered.

## 5. When they want a change

- **The change is made in the file they saw**, never in a new mockup from nothing: they would lose what they liked.
- **Keep what they saw first**: `cp -r <work>/mockup <work>/mockup-v1` (then `-v2`, and so on). "The earlier one" is
  asked for more often than not.
- Then step 3 again, every round, the windows read again at both widths: a change in one place moves another. Then
  send what changed, the frames drawn again where they asked for frames. A before and an after side by side when the
  change is the point.
- **Two directions, when they ask for options** or the brief leaves the look wide open: two at most, the first
  screen only, the same words in both, each named by what differs. The rest is built in the one they pick.
- When they say yes to it, the HTML is where the real page starts. Say so.
