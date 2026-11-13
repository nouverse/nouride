---
name: motion-graphics
description: Make a motion graphic or short video from code with Remotion (animated titles, explainers, intros, lower thirds, social clips, animated charts) and render it to MP4. Checks first whether this machine can render at all, and moves the render to another device through network-reach when it cannot. Use when asked for a motion graphic, an animation, an intro or outro, a video from text or data, or anything that has to move.
requires: node, npx
needs_tools: exec, read, write, send_file
author: Nouride
---

# Making a motion graphic

Remotion renders a React component frame by frame in a headless Chrome and encodes the frames with
its own bundled FFmpeg. The code is the easy part. What goes wrong is what you cannot see from the
code: text cut off at the edge, a scene that flashes, timing that drags. So **you look at what you
made before you call it done**: a still of every scene, a contact sheet of the whole thing, then frames
of the file you send. The person licenses Remotion for their own use; that is theirs, not a step here.

**Nothing you render reaches the person before it has been through step 5**: not the probe, not a
quick render to show progress, not a test render of a composition that was already in the
repository. The person judges whatever you send as your work, and a render nobody has looked at is
usually broken in a way one frame would have shown.

Do the steps in order. Each one is cheaper than the one after it. A project that already exists
skips step 2 and goes through every other one: a composition someone else wrote has not been looked
at just because it exists.

## 1. Can this machine render?

One command, before anything is installed:

```sh
uname -sm; [ -f /etc/alpine-release ] && echo MUSL; ldd --version 2>&1 | grep -qi musl && echo MUSL; [ -e /etc/NIXOS ] && echo NIXOS
nproc 2>/dev/null || sysctl -n hw.ncpu
free -m 2>/dev/null | awk '/^Mem:/{print "avail_mb", $7}' || echo "total_mb $(( $(sysctl -n hw.memsize) / 1048576 ))"
df -Pk . | awk 'NR==2{print "disk_free_mb", int($4/1024)}'; node -v 2>/dev/null || echo "NO NODE"
```

| What you see | Verdict |
|---|---|
| `MUSL` (Alpine), `NIXOS`, or a 32-bit CPU (`armv7l`, `i686`) | **cannot render here**: Remotion's Chrome and compositor do not run there. Go to step 7 |
| under 2 cores, under 2 GB available memory, or under 3 GB disk | **not enough**: go to step 7 |
| 2–3 cores or 2–4 GB available | **tight**: render here with `--concurrency=1` and stills at `--scale=0.5`, and tell the person it will be slow |
| more than that | fine |

These numbers are a starting guess, not Remotion's own limits. Step 3's probe render is the real
answer: trust it over the table.

No Node means installing it, which is the person's call: ask, or go to step 7 if another machine
already has it.

## 2. The project

Write it yourself rather than running an interactive generator. `exec` has no terminal to answer
prompts. In a new folder in the workspace:

```sh
npm init -y >/dev/null && npm i remotion @remotion/cli react react-dom && npm i -D typescript @types/react
npx remotion browser ensure
```

Every `remotion` and `@remotion/*` package must be **the same version**; `npx remotion versions`
says whether they are. Add a package with `npx remotion add @remotion/<name>`, which pins it to
match, never with a bare `npm i`.

`tsconfig.json` (without one, `tsc` in step 4 prints its help and checks nothing):

```json
{ "compilerOptions": { "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true }, "include": ["src"] }
```

`src/index.ts`:

```ts
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
```

`src/Root.tsx` registers each video. The id is what you render by name; the size, fps and length
live here and nowhere else:

```tsx
import { Composition } from "remotion";
import { Main } from "./Main";

export const Root = () => (
  <Composition id="Main" component={Main} width={1920} height={1080} fps={30} durationInFrames={30 * 12} />
);
```

The shape is where it is watched (step 4 asks): a screen or YouTube is `1920×1080`; Reels, TikTok, Shorts or a story,
a full phone screen, `1080×1920`; a feed post `1080×1350` or square `1080×1080`.

Remotion also publishes its own agent skills for the API itself: `npx -y skills add remotion-dev/skills`
in the project folder puts them under `.agents/skills/`, with no questions asked. `read`
`.agents/skills/remotion-best-practices/SKILL.md` before writing scenes: it follows the version you
installed, which this file does not. Offline, the rules in step 4 are enough.

## 3. Probe render

Before writing the real video, render a second of the placeholder and time it:

```sh
time npx remotion render src/index.ts Main --frames=0-29 --concurrency=1 "$TMPDIR/probe.mp4"
```

Seconds taken ÷ 30 × total frames is roughly what the full render costs at this concurrency. Over
about 15 minutes, or a crash (killed for memory, `error while loading shared libraries`), and this
machine is not the place: step 7. A missing library on Linux is a system package (`libnss3`,
`libgbm1`, `libasound2` and friends); installing it is the person's call, so name the package
and ask, or move on to another machine.

The probe measures the clock. Nobody receives it.

## 4. Storyboard, then code

**Ask what form, once**, in the same message as the assets, and only what the request does not already say:

- **Where it is watched**, which decides its shape: a screen or YouTube (16:9); Reels, TikTok, Shorts or a story
  (9:16, a full phone screen); a feed post (4:5 or square).
- **How long**, when they have a length in mind. With none, it is as long as its scenes need to be read (below).
- **Sound**: their music or their voice as a file, music found with a licence, or none. Many people watch a feed
  with the sound off, so what the clip says is on screen either way.

When their words already say it ("reels", "buat TikTok", "an intro for my talk"), do not ask it again: say in one
line what you took as the answer. With nothing said and nobody to ask, it is 16:9 with no sound.

**Ask the person about the assets first, every time** (their logo, screenshots, photos, footage, music, brand font
and colours) before you look for any. Theirs beat anything found; find only what they say to find, or what they do
not have. How to ask, where to find with a licence, and the commands that crop, resize, cut and trim them are in
`references/assets.md` beside this file: read it before the storyboard.

Write the plan and send it before the code, each asset with where it comes from, and every line that puts words or a
number on screen with its `source:`, where you read it:

```text
1920×1080, 30 fps, 12 s. Font: <theirs, or the one you chose>. Colors: <background>, <text>, <accent>.
Assets: logo (theirs, logo.svg); dashboard screenshot (taken from app.example.com); no music.
1. 0–3 s    "Nouride" fades up and scales 0.9→1, accent line draws under it      source: the name they gave
2. 3–8 s    three points slide in from the left, one per second, 8 words max     source: example.com/features
3. 8–12 s   logo, the URL underneath, holds 2 s then fades out                    source: example.com (checked: it answers)
```

The font and the colours on its first line are theirs where they have any. With none, choose them for this video,
for who it is for and what it should feel like, and say in one line why. This skill names none: a look copied from an
example is nobody's.

**A clip for a feed** (9:16, 4:5, square) is watched by someone about to swipe on. That decides its order, never its
look:

- **The first scene is the hook**: what the clip is about, in words on screen, moving from its first frame. No logo
  alone, no fade from black, no greeting.
- **One idea a scene**, and a scene as long as its words need, no longer.
- **What it says is on screen**: with the sound off it still says everything.
- **The last scene is the end card**: what to do next and the account's name, held long enough to be read.
- **In a 9:16 frame**, what matters stays out of the top 14%, the bottom 35% and the outer 6% of each side, where the
  app draws its own bars and buttons. `Check` measures it (step 5).

**Words need time.** A line is on screen, fully arrived, for a second for every 17 characters it has, and never under
a second: the pace subtitles are held to (Netflix's ceiling for subtitles is 17 characters a second in many
languages, 20 in English), and on-screen text has motion beside it to compete with. Count it in the storyboard,
beside each line that is a sentence: `"Giling tepat sebelum diseduh" (28 characters: 2 s)`. A scene that cannot give
its words their time says less, or is longer.

A line with no source you can write there is a line you made up: a tagline, a URL, a feature list. Ask for it, or
take it from their site or docs, before it goes in the storyboard. A small model wrote `nouride.com` and a tagline
nobody had said (live, 0.8.12). A URL on screen is one you opened.

Wait for a yes unless they said to just make it. Changing a line of this is free; changing a render
is not.

Every claim on screen comes from a source you can name: the product's own site or docs, a
measurement with its date. Put the source beside the line in the storyboard. A number nobody measured
does not go on screen, and neither does an adjective with no number behind it ("ultra-fast",
"next-gen").

A whole video is long work, several rounds of rendering and looking: from a chat, draft it as a
mission with `mission`, and put the storyboard in its brief, which becomes its `BRIEF.md`. The person
reads it on the mission's page, and starting the mission is one yes for the storyboard and the work;
the chat stays free while it runs. Inside the mission the brief is the storyboard they said yes to.
Where you cannot draft one, send the storyboard here and wait for the yes.

Then the code. These rules are where generated Remotion code goes wrong. Each one breaks the
video, not the style:

- **Every movement is a function of the frame.** `const frame = useCurrentFrame()`, then
  `interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })` or
  `spring({ frame, fps })`. Never CSS `transition`, `animation` or `@keyframes`, Tailwind
  `animate-*`/`transition-*`, `setTimeout`, `requestAnimationFrame` or `Date`: Remotion renders
  frames out of order and in parallel, and anything that runs on the clock flickers or freezes.
- **Always clamp** `interpolate`. Unclamped, opacity runs past 1 and positions keep flying after the
  animation ends.
- **No `Math.random()`**: `random("seed-1")` from `remotion`, the same on every frame and every render.
- **Time in seconds × fps**, from `useVideoConfig()`: `2 * fps`, never a bare `60`. A change of fps
  must not change the timing.
- **Scenes are `<Sequence from={…} durationInFrames={…}>`** or `<Series>`. Inside a sequence,
  `useCurrentFrame()` starts at 0, so each scene is written from its own start.
- **A `<Sequence>` is a full-frame layer of its own**, absolutely positioned, not a block in your
  flex layout. Two that overlap in time are drawn on top of each other, both pinned to the top of
  the frame. One scene per `<Series.Sequence>`, none overlapping, and the layout inside the scene.
- **Scene lengths live in one list** that the `<Series>` is built from. Step 5 takes its frames from
  the same numbers.
- **Assets** go in `public/` and are loaded with `staticFile("x.png")` into `<Img>`, `<OffthreadVideo>`
  and `<Audio>` from Remotion, never a bare `<img>` or `<video>`, which the render does not wait for.
- **Fonts** through `@remotion/google-fonts/<Name>` (`loadFont()`), or `staticFile` plus
  `@remotion/fonts`. A font that is not loaded renders as the fallback, silently.
- **Layout**: nothing within 5% of any edge, text no smaller than 1/30 of the shorter side (36 px on
  a 1080-wide or 1080-high frame), one idea on screen at a time. Colors and fonts from the
  storyboard, in one constants file.

Then, before rendering anything:

```sh
npx tsc --noEmit && npx remotion compositions src/index.ts
grep -rnE 'Math\.random|setTimeout|setInterval|requestAnimationFrame|Date\.now|new Date\(|@keyframes|transition:|animation:|animate-|transition-|<img |<video |<audio ' src/ && echo "FIX THESE" || echo "none of these"
```

A grep hit is a bug until you have looked at it. A grep that finds nothing exits 1, which is why the
line ends with `|| echo`: without it a clean project reads as a failed command.

## 5. Look at it

A round is one script and a few pictures: bundle once, render the pictures from the bundle, `read`
them, fix, go again. A still rendered from a bundle skips webpack: seven stills and a sheet took 21
seconds on a 6-core machine, where seven stills from the source took 60. **Bundle again after every
edit**; a still from an old bundle shows the old code.

**Settled stills.** One per scene, half a second before it ends: everything has come in and nothing
has started to leave, so that is where a layout problem is biggest. The storyboard above, at 30 fps,
ends its scenes at frames 90, 240 and 360, so its settled stills are 75, 225 and 345.

**Arriving stills.** One per scene, a second after it starts: the scene before should be gone, and
what comes in is halfway (a title still showing under the next scene, a card flying across a line of
text, a word that wraps only while it grows). Neither the settled stills nor the sheet are taken there.
The storyboard's scenes start at frames 0, 90 and 240, so its arriving stills are 30, 120 and 270.

**The frames come from the scene list, all of them every round.** Picked by eye, they miss: a caption
that came in 3.8 s into a scene fell between the frames an agent chose, and passed. `round.mjs` (below)
works them out from the scene lengths: `30 75`, `120 225`, `270 345` for the storyboard. Every round
renders all of them, not only the scenes you changed: a fix in one scene moves what comes after it.

**Contact sheet.** One picture of how it moves: 16 frames spread over its length, 4×4. Build it in
Remotion itself. The FFmpeg it bundles has only the `scale` filter, no `fps` or `tile`, and a system
FFmpeg may not be there or may not start. `src/Sheet.tsx`:

```tsx
import type { ComponentType } from "react";
import { AbsoluteFill, Freeze, useVideoConfig } from "remotion";

// Each cell holds the whole video at its own size, scaled down — so text wraps as it does in the video.
export const makeSheet = (Video: ComponentType, frames: number[], columns = 4) => () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ flexDirection: "row", flexWrap: "wrap", alignContent: "flex-start", background: "#888" }}>
      {frames.map((frame, i) => (
        <div key={i} style={{ width: width / columns, height: height / columns, overflow: "hidden", outline: "2px solid #888", outlineOffset: -2 }}>
          <div style={{ position: "relative", width, height, transform: `scale(${1 / columns})`, transformOrigin: "top left" }}>
            <Freeze frame={frame}>
              <Video />
            </Freeze>
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
```

A cell narrower than the video wraps text where the video does not, and the sheet then shows a
problem the video does not have. `AbsoluteFill` is a flex column, which is why the row is set: without
it the frames run down the columns and the sheet reads out of order.

Register it beside `Main` with **the same size, fps and length**. A shorter one cuts off every
`<Sequence>` inside it and the sheet comes out empty:

```tsx
const MAIN = { width: 1920, height: 1080, fps: 30, durationInFrames: 30 * 12 };
const SPREAD = Array.from({ length: 16 }, (_, i) => Math.round((i * (MAIN.durationInFrames - 1)) / 15));
<Composition id="Main" component={Main} {...MAIN} />
<Composition id="Sheet" component={makeSheet(Main, SPREAD)} {...MAIN} />
```

**Measured, not judged.** Six things on the list below are measured, and a measure does not skip
one: text under 1/30 of the shorter side, text inside the 5% margin, in a 9:16 frame text where the app
draws over the video instead (the top 14%, the bottom 35%, the outer 6% of a side), text that has
arrived and is too close in colour to the plain colour behind it (under 4.5:1, or 3:1 for large text),
a word alone on a last line, text over a picture or over other text. In a real test an agent read a 26 px line on three rounds of
stills and wrote `none` for small text. Copy `Check.tsx` from this skill's folder, beside this file,
into `src/`, and register it beside `Sheet`:

```tsx
<Composition id="Check" component={makeCheck(Main)} {...MAIN} />
```

A still of `Check` is the frame with each finding outlined in red and listed across the top, or, when
it found nothing, the whole frame with a small green `nothing measured wrong` in its bottom-right corner. A finding is fixed, or written in the round's list with why it is
meant (a caption set over a photo on purpose). The rest of the list is judged by eye on the stills.

One round is one command, run in the project's folder. `round.mjs` is beside this file: write its full path. It
takes each scene's length in seconds, in order, as the storyboard has them:

```sh
node <this skill's folder>/round.mjs --scenes 3,5,4 --fps 30 --round 1
```

It prints each scene's arriving and settled frame, type-checks, bundles once, renders a still of `Main` and of
`Check` at every one of those frames and the `Sheet`, into `rounds/` (`r1-75.png`, `r1-check-75.png`,
`r1-sheet.png`), and its last line names the pictures to read. The next round is `--round 2`. When it stops at an
error, the error is the lines above its own: a type error or a bundle that failed renders nothing.

`read` every still and its check, then the sheet, all of them in one `read`. Text is judged on the stills; a cell of
the sheet is a quarter of the width, and the sheet is for when things arrive and leave. Look for each of these by name,
since "looks fine" misses them:

- a word alone on the last line of a heading or a sentence: break the line yourself where it should
  break
- text or a picture inside the 5% margin, or a line that fits by a few pixels
- two things touching or overlapping: a picture over a line of text, a card over the footer
- something from another scene still on screen: a title showing under the next scene's card
- something stretched to fill the frame, such as a card as tall as the screen
- everything in one third of the frame and the rest empty
- the same thing where each should differ: four avatars with one initial, three cards with one icon
- text smaller than 1/30 of the shorter side
- in a 9:16 frame, something that matters where the app draws over it; text too pale against what is behind it
- a line of words on screen for less than its time (a second for every 17 characters, never under one)
- for a feed: the first scene says what it is about at once, and the last says what to do
- on the sheet: a scene arriving later than the storyboard says, or one that sits still for seconds

**Write the answers down, every round.** Each item on that list gets a line: `none`, or what you saw
and on which picture. A check kept in your head is the one that gets skipped: in a real test, told only
to look for each item in turn, the agent did not.

```text
Round 2 (stills 30, 75, 120, 225, 270, 345 and the sheet)
- a word alone on a last line: none
- inside the 5% margin: none
- touching or overlapping: 225, the chart's legend over the footer
- another scene still on screen: 120, the first scene's title under the chart, fading out late
- stretched to fill the frame: none
- one third full, the rest empty: none
- the same where each should differ: 345, three cards with one icon
- text under 1/30: none
- covered in a 9:16 frame, or too pale: none
- words given their time: 120, "Kopi yang digiling tepat sebelum diseduh" (40 characters) is up 1.5 s -> scene 2 is a second longer
- a feed's first and last scene: none
- sheet, timing: none
```

A line that is not `none` is fixed before the next round. The message that sends the video carries the
last round's list, so the person sees what was checked.

A frame you need to see closer is a `still` of `Main` at that frame.

Three rounds of fixing is the limit. Then send the person the stills, the sheet and the last list, and
ask what to change. A fourth guess is usually wrong in a new way.

If your model cannot see images, say so, and send the stills and the sheet for the person to judge.

## 6. Render and send

```sh
npx remotion render src/index.ts Main out/video.mp4
```

A render longer than a couple of minutes: `mkdir -p out`, start it with `service: true` and `> out/render.log 2>&1`,
and check the log rather than holding the turn.

Then check the file you are about to send, not the code that made it, with the FFmpeg Remotion
bundles:

```sh
npx remotion ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,nb_frames -of compact out/video.mp4
for t in 2 6 11.5; do npx remotion ffmpeg -v error -y -ss $t -i out/video.mp4 -frames:v 1 -vf scale=540:-1 "$TMPDIR/final-$t.png"; done
```

Duration, width × height and frame count match the storyboard. `read` a frame from the start, the middle and the
end the way you read the stills: they show what was encoded, which is where a fallback font, a black
frame or the wrong composition turns up.

Send `out/video.mp4` and the contact sheet in ONE `send_file` call, both in `paths`, the video first: they
arrive together. With them, one line per scene and the last round's list from step 5. In a mission they go
with `mission` done instead: the video and the sheet as its files, the list in its report. Chat apps cap
uploads (a Telegram bot at 50 MB): over that, render again with `--crf=28`, or shorter.

## 7. Render somewhere else

When step 1 or 3 says this machine cannot, tell the person plainly what fell short and by how much
("1.2 GB of memory free, this needs about 4"), and offer to render on another of their machines.
Then **load the `network-reach` skill** and reach a Linux or macOS machine by ssh. A Windows host
works too, with PowerShell quoting.

On that machine, run step 1 again before anything else. It is the one being judged now. Then:

```sh
rsync -az --exclude node_modules --exclude out ./ <host>:nouride-render/<project>/
ssh <host> 'cd nouride-render/<project> && mkdir -p out && npm ci && npx remotion browser ensure && npx remotion render src/index.ts Main out/video.mp4 > out/render.log 2>&1'
scp <host>:nouride-render/<project>/out/video.mp4 out/
```

Stills for step 5 render there too, and come back the same way to be read here. The project stays
here, where you edit it; the other machine only renders. Installing Node there is the person's call,
as it is here.

If no machine can, say so. Do not send a slideshow of stills and call it a video.
