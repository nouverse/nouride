---
name: nouclip
description: "Summarize a video or YouTube link from its timed transcript, download a video or a section, and cut short vertical clips with nouclip: splice ranges in any order (hook first), skip bumpers, reframe to 9:16, 1:1 or 4:5, burn word-by-word subtitles, trim silences, mix ducked music, find the best moments. Reads YouTube captions before transcribing. Use when asked what a video says, to summarize it, to download a video or section, or for shorts, reels, TikToks, clips, subtitles or highlights."
requires: nouclip, ffmpeg, yt-dlp
needs_tools: exec, read, write, send_file
author: Nouride
---

# Videos with nouclip

`nouclip` gets a video's **words with timestamps** (from a YouTube video's own captions when it has
them, from a Whisper endpoint otherwise) and does two things with them: gives them to you to read,
and cuts, splices, reframes and subtitles clips.

This file is the procedure and the rules. The flags are in `nouclip --help` and `nouclip <command> --help`,
which are never out of date: read a command's help before its first use, and before deciding a flag does
or does not exist.

## 1. Have the tools, and keep nouclip current

```sh
nouclip --version; ffmpeg -version | head -1; yt-dlp --version
```

Install what is missing the way your instructions say to install software, never with a script piped
into a shell:

- **nouclip:** `bun add -g nouclip` or `npm install -g nouclip`. With neither, the release binary for this
  machine (`nouclip-linux-x64`, `nouclip-darwin-arm64`, `nouclip-darwin-x64`, from
  `https://github.com/nouverse/nouclip/releases/latest`), put in place as your instructions say.
- **yt-dlp:** `pip install yt-dlp`, or `brew install yt-dlp`.
- **ffmpeg** and ffprobe: `nouride pkg install ffmpeg` where system packages are on, `brew install ffmpeg`
  on macOS, otherwise a static build for this machine with `install -m 755 <file> "$NOURIDE_BIN/"`,
  never a link into a cache directory, which clearing the cache breaks. `ffmpeg -version` printing a
  library error is as missing as no ffmpeg. A transcript from YouTube captions needs only yt-dlp.

**Updating** is the command it was installed with. `command -v nouclip` says which: a link into
`lib/node_modules` is npm, one under `~/.bun` is Bun (`… -g nouclip@latest`), a plain file is the release
binary, downloaded again. Update when a flag here comes back as `unknown option`: `--timeline`, `--skip`,
`stitch`, `--captions`, `--no-scale` and YouTube links on `transcript` and `highlight` are recent. A
YouTube download that suddenly fails is usually a stale yt-dlp.

## 2. Before a run

**Long runs go in the background.** Downloads, `auto`, `crop`, `subtitle` and transcriptions take
minutes: `exec` with `background: true`, and you are woken with the result. In the foreground they are
killed at the timeout and the work is lost: six runs of `yt-dlp` and `nouclip` were, in one month on a
live box. `info`, `list` and `--help` stay in the foreground.

**Look before you download.** `nouclip info --json` names the workspace in use (`NOUCLIP_WORKSPACE_DIR`,
else a `.nouclip/` in the current directory, else `~/.nouclip/`), and `nouclip list all --json` what it
holds: `downloads/`, `transcripts/` (word JSON, `.ass` scripts), `segments/`, `output/`. Sources are
cached and never fetched twice (`--force` on `download` or `auto` fetches again), and `nouclip download`
with a start and an end fetches only that section.

## 3. Where the words come from, and the language

For a YouTube link, `auto`, `transcript` and `highlight` read the video's own captions **before** sending
any audio to Whisper (free, no endpoint, nothing downloaded). In order: **uploaded captions** in `--lang`
(a person wrote them; timed per line, so word timing is estimated), then **YouTube's speech recognition**
in `--lang` (timed per word, with a recognizer's mistakes), then **Whisper** (step 8). An automatic
translation is never used. `--captions only` fails rather than transcribe; `--captions off` always
transcribes, for captions known to be poor.

**`--lang` is the language spoken** in the video: `en` for an English talk. It defaults to `id`, and
asking for `id` on an English video finds no captions, or a translation. nouclip logs which source it
took. Keep it: it says how good the words are. An uploaded track in another language than the one spoken
is a translation: fine to read and summarize, wrong for subtitles that have to match the speaker.

## 4. Summarize a video

nouclip does not summarize; **you do**, from its timed transcript. No LLM key is needed.

```sh
nouclip transcript "<url>" --lang en -f txt -o "$TMPDIR/video.txt"                 # captions: nothing downloaded
nouclip transcript "<url>" --lang en --range 10:00-25:00 -o "$TMPDIR/part.txt"     # one part; times start at 0
nouclip transcript ./recording.mp4 --lang id -o "$TMPDIR/recording.txt"            # a file: Whisper
```

The file is paragraphs like `[04:33 -> 04:52] …`. Then:

- **`read` it in parts, or `grep` it.** A two-hour podcast is about 150,000 characters. For one topic,
  search for it and read around the hits.
- **Timestamps on everything.** Chapters as `[mm:ss] title`, points with the moment they are made. The
  person can jump there, and "clip that part" has its range ready.
- **Only what was said.** A transcript has no picture: say so when the question is about the screen.
- **Names and numbers as written.** A machine transcript mishears them; quote rather than correct, and
  say where the words came from.
- **In the person's language**, whatever the video's is.

"What are the best moments?" is `nouclip highlight "<url>" --lang en`, scored from the same words, with a
start and a length for each; `--keyword` narrows it to a topic. Without an LLM key it scores them
locally.

## 5. Times, timelines and skips

A time is `13:25`, `01:13:25`, `13m25s`, `45s` or `85.5`; one range is `--range 13:25-14:50`, or `--from`
with `--to` or `--duration`.

A short rarely plays in source order: the punchline goes first, then the setup, and the channel bumper or
sponsor read in between is cut. `auto`, `cut` and `stitch` take:

- `--timeline "1:30-1:35 + 0:00-0:15 + 0:25-0:50"`: the ranges to keep, **in the order they play**, each
  with an end. It replaces `--range`, `--from`, `--to` and `--duration`: list every range in it.
  `--timeline-file` takes the same as JSON.
- `--skip "0:06-0:14, 1:10-1:20"`: windows cut out of what was selected, or of the whole file when
  nothing was: `--range 0:00-1:30 --skip 0:06-0:14` keeps 0:00–0:06 and 0:14–1:30.

**Timestamps come from the transcript, never a guess.** Pick the hook (the punchline or the strongest
claim), the setup and the payoff from its `[mm:ss -> mm:ss]` paragraphs, and leave applause or a pause out
with `--skip`.

It is one frame-accurate pass with a 30 ms fade at every cut. A YouTube link downloads only the window
from the earliest start to the latest end, so a hook from the last minute and a setup from the first is
nearly the whole video. Subtitles follow the new order, and no caption spans a cut. When the source was
transcribed already and only the edit changes, `stitch` re-times its `.whisper.json` (timed against the
video you are stitching) instead of transcribing again:

```sh
nouclip stitch podcast.mp4 --timeline "1:30-1:35 + 0:00-0:15" \
  --subtitles <workspace>/transcripts/podcast.whisper.json -o stitched.mp4 --output-subtitles stitched.whisper.json
nouclip subtitle stitched.mp4 --sub stitched.whisper.json --style standard -o final.mp4
```

## 6. A clip: draft, fix the words, look, ask, render

Never render the final video in one step. Subtitles are machine words (names, brands and slang come out
wrong), and the person approves the cut before anything is burned in.

```sh
nouclip auto "<url or file>" --range 13:25-14:10 --lang id --aspect 9:16 --style hormozi --draft
nouclip auto "<url>" --lang en --timeline "1:30-1:35 + 0:00-0:15 + 0:25-0:50" --style hormozi --draft
ffmpeg -loglevel error -ss 5 -i "<framed video>" -frames:v 1 -vf scale=540:-2 "$TMPDIR/draft.jpg"
nouclip subtitle "<framed video>" --sub "<the corrected .ass>" -o final.mp4      # after the yes
```

1. **Draft** with `--draft`, which stops before burning and prints the framed video, the `.ass` subtitle
   script and the word JSON. `--silence-trim` cuts pauses longer than 0.6 s (`--silence-gap` sets it) and
   moves the subtitles with the cuts.
2. **Fix the words** in the `.ass`: names, acronyms, casing. Change text; leave the timestamps.
3. **Look.** A frame of the framed video (the `ffmpeg` line), then `read` it: the framing, whether the
   speaker is in shot.
4. **Ask.** Send the frame and a short plan (the range or timeline, the hook line, the style, silence
   trim, music) and **wait for a yes**. Changing the plan is free; rendering again is not.
5. **Render** with `subtitle`, after the yes. Music: `--bgm music.mp3` loops under the video and ducks
   while someone speaks (`--bgm-volume`, 0.10 by default; `--no-ducking` keeps it flat).
6. **Look again.** A frame of `final.mp4`, `read`: subtitles inside the frame, not over a face, readable.

Rendering 1080×1920 with subtitles is real CPU work: on a small box it is slow, not broken. Say so. Too
slow to be useful: load the `network-reach` skill and run the same commands on a bigger machine of theirs.

It is memory too: FFmpeg reframing a 1080p source to 1080×1920 peaked at about 450 MB (measured on a Linux box). Check
before a render:

```sh
uname -m; free -m 2>/dev/null | awk '/^Mem:/{print "avail_mb", $7}' || echo "total_mb $(( $(sysctl -n hw.memsize) / 1048576 ))"
```

Under 700 MB available (any 512 MB board), render on another machine as above; a starting guess from that
measurement. A summary, a transcript from captions or Whisper, and a download need no render and run on a small board.

## 7. Frame, style, and which style for which audio

- **Aspect** `--aspect`: `9:16` (the default, for Shorts, Reels, TikTok), `1:1`, `4:5`, `16:9`, `4:3`, or
  `W:H`. `crop` reframes a video on its own, without subtitles.
- **Framing** `--mode`: `blur` (the default: the whole picture over a blurred copy; podcasts, screen
  shares), `center` (crop to fill; one person in the middle), `pad` (bars), `stretch`.
- **Style** `--style`, five presets. `standard`: whole phrases in balanced two-line wraps, held still for
  2–3 s, no per-word highlight (for translated subtitles, international podcasts and teaching). `hormozi`:
  loud all-caps, neon green highlight, words pop. `storyteller`: natural case, soft cyan highlight.
  `cinematic`: wide-spaced all-caps, golden amber. `default`: all-caps, yellow highlight. Each carries its
  own size and colours: pass `--font-size`, `--primary-color` or `--highlight-color` only to change one
  the person asked about.

**The audio's language decides the style.**

- **Same language.** English audio, English subtitles: a kinetic preset (`default`, `hormozi`,
  `storyteller`, `cinematic`). The eye and the ear get the same word at the same moment.
- **Translated.** English audio, Indonesian subtitles: `standard`. A per-word highlight on a translation
  lights words the speaker is not saying at that moment, and splits phrases that belong together.
- **Kinetic on a translation, when the person asks for it.** The acoustic anchor protocol:
  - Never spread a sentence's time evenly over the translated words: word order changes, the speaker
    pauses, and the subtitles drift.
  - Find the bursts of speech in the word timestamps (a gap over 0.3 s ends one) and give each burst
    its own phrase of the translation, 3 to 6 words.
  - Lock the translation's emphasis words ("BERLAWANAN", "TIDAK ADA LAGI") to the moment the speaker
    lands the punchline.
  - Always `--no-scale`.

**Jitter.** Words that pop make libass move a bottom- or centre-aligned line up and down as each one
scales. `--no-scale` (on `auto` and `subtitle`) keeps every word at 100% and highlights by colour alone:
use it whenever lines jump, and always on a translation.

**Translating** needs no translation API. You are the translator. Machine translation is literal, keeps
the filler ("Anda tahu"), and breaks compound phrases across lines. Take the clip's words as JSON
(`nouclip transcript "<url or file>" --lang en -f json --range 13:25-14:10 -o "$TMPDIR/words.json"`),
`read` them, write them again in natural spoken language with every sentence keeping its `start` and
`end`, and burn that: `nouclip subtitle <clip> --sub "$TMPDIR/translated.json" --style standard -o final.mp4`.

## 8. Whisper, and its keys

A local file, or a video without captions, is transcribed through `NOUCLIP_OPENAI_AUDIO_URL`: an
OpenAI-style `/audio/transcriptions` endpoint (OpenAI, Groq, or a Whisper server of theirs). Unset, it
tries `http://localhost:8880`; nothing there means every transcribing step fails, so ask which service
to use rather than guessing one. The address is not a secret: it goes in `~/.nouclip/.env` as
`NOUCLIP_OPENAI_AUDIO_URL=<address>`, which nouclip reads.

A key for that endpoint is a secret, never written into a file: it reaches nouclip as an environment
variable through your `exec_secrets`, under the name nouclip reads. If the person sends it here, it
reaches you as a `$TMP_SECRET_…` handle: keep it with `secret_save` as `nouclip_openai_audio_api_key`,
and every command of yours gets `$NOUCLIP_OPENAI_AUDIO_API_KEY` from then on. Or they add
`nouclip_openai_audio_api_key` on the dashboard's Secrets page or with
`nouride secret set nouclip_openai_audio_api_key --stdin`, and bind it to `nouclip` under
`[security.exec_secrets]` in your config.toml. A key for `highlight`'s LLM goes the same way, as
`nouclip_openai_llm_api_key`. `[ -n "$NOUCLIP_OPENAI_AUDIO_API_KEY" ] && echo set` checks one; never
print it.

## Sending it

`send_file` the clip with one line on what it is; a summary goes in the reply itself. Chat apps cap
uploads (a Telegram bot at 50 MB): a longer clip is encoded smaller or cut shorter, never silently not
sent. What someone else posted belongs to them: clipping it for the person's own use is theirs to decide,
and republishing it theirs to answer for. Say so once if they plan to post it.
