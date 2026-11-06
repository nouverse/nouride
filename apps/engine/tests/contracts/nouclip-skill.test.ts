/**
 * The shipped `nouclip` skill, rewritten in 0.8.12 from a 586-line copy of nouclip's own SKILL.md (in the nouclip
 * repository, `skills/nouclip/SKILL.md`) to the procedure and the rules, with the flags left to `nouclip --help`. These
 * are the rules it kept, by the words that carry each — and the two things it no longer says: install by piping a
 * script into a shell, which `references/adding-an-agent.md` forbids, and API keys written into a `.env` file, where a
 * credential is a file anyone with the agent's shell can read.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@nouride/persona";

const source = readFileSync(join(import.meta.dir, "../../../../content/skills/nouclip/SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const skill = source.replace(/\s+/g, " ");

describe("what it no longer says", () => {
  test("no install script piped into a shell", () => {
    expect(source).not.toMatch(/curl[^\n`]*\|\s*(ba|z)?sh\b/);
    expect(source).not.toContain("install.sh");
    expect(skill).toContain("Install what is missing the way your instructions say to install software, never with a script piped into a shell");
    expect(skill).toContain("`bun add -g nouclip` or `npm install -g nouclip`");
  });

  test("no API key in a .env file: keys reach nouclip through exec_secrets", () => {
    // The address is all that goes in nouclip's `.env`: it is not a secret. The old copy wrote a `.env` and listed
    // every key beside it as configuration.
    expect(skill.split(".env").length - 1).toBe(1);
    expect(skill).toContain("it goes in `~/.nouclip/.env` as `NOUCLIP_OPENAI_AUDIO_URL=<address>`");
    expect(source).not.toMatch(/\|\s*`NOUCLIP_\w*API_KEY`/);
    expect(skill).toContain("A key for that endpoint is a secret, never written into a file: it reaches nouclip as an environment variable through your `exec_secrets`");
    expect(skill).toContain("keep it with `secret_save` as `nouclip_openai_audio_api_key`, and every command of yours gets `$NOUCLIP_OPENAI_AUDIO_API_KEY`");
    expect(skill).toContain("bind it to `nouclip` under `[security.exec_secrets]`");
    expect(skill).toContain("never print it");
  });

  test("no flag reference, no emoji heading, no shouting", () => {
    expect(skill).toContain("The flags are in `nouclip --help` and `nouclip <command> --help`");
    expect(source).not.toMatch(/^#+ .*\p{Extended_Pictographic}/mu);
    expect(source).not.toMatch(/MANDATORY|CRITICAL|STRICT DIRECTIVE/);
    expect(source.split("\n").length).toBeLessThan(230);
  });

  test("carries the author field the other built-in skills carry", () => {
    expect(parseFrontmatter(source).fields.author).toBe("Nouride");
  });
});

describe("the rules it kept", () => {
  test("checks its tools first, and updates the way it was installed", () => {
    expect(source).toContain("nouclip --version; ffmpeg -version | head -1; yt-dlp --version");
    expect(skill).toContain("**Updating** is the command it was installed with. `command -v nouclip` says which");
    expect(skill).toContain("Update when a flag here comes back as `unknown option`");
  });

  test("long runs go in the background, and the workspace is looked at before a download", () => {
    expect(skill).toContain("**Long runs go in the background.**");
    expect(skill).toContain("`nouclip info --json` names the workspace in use");
    expect(skill).toContain("Sources are cached and never fetched twice");
  });

  test("YouTube captions before Whisper, and --lang is the language spoken", () => {
    expect(skill).toContain("read the video's own captions **before** sending any audio to Whisper");
    expect(skill).toContain("An automatic translation is never used.");
    expect(skill).toContain("**`--lang` is the language spoken** in the video");
  });

  test("a summary is the agent's, from the timed transcript, with timestamps and only what was said", () => {
    expect(skill).toContain("nouclip does not summarize; **you do**, from its timed transcript.");
    expect(skill).toContain("**Timestamps on everything.**");
    expect(skill).toContain("**Only what was said.**");
    expect(skill).toContain("**In the person's language**, whatever the video's is.");
  });

  test("timelines play hook first, skips cut bumpers, and times come from the transcript", () => {
    expect(skill).toContain("the ranges to keep, **in the order they play**");
    expect(skill).toContain("`--skip \"0:06-0:14, 1:10-1:20\"`: windows cut out of what was selected");
    expect(skill).toContain("**Timestamps come from the transcript, never a guess.**");
    expect(skill).toContain("`stitch` re-times its `.whisper.json`");
  });

  test("a clip is drafted, its words fixed, looked at, asked about, then rendered", () => {
    expect(skill).toContain("Never render the final video in one step.");
    for (const step of ["**Draft** with `--draft`", "**Fix the words** in the `.ass`", "**Look.**", "**wait for a yes**", "**Render** with `subtitle`, after the yes", "**Look again.**"]) {
      expect(skill).toContain(step);
    }
  });

  test("the five typography presets, by name", () => {
    for (const preset of ["`standard`:", "`hormozi`:", "`storyteller`:", "`cinematic`:", "`default`:"]) expect(skill).toContain(preset);
  });

  test("the audio's language decides the style, and a kinetic translation follows the acoustic anchor protocol", () => {
    expect(skill).toContain("**The audio's language decides the style.**");
    expect(skill).toContain("**Translated.** English audio, Indonesian subtitles: `standard`.");
    expect(skill).toContain("The acoustic anchor protocol");
    expect(skill).toContain("Never spread a sentence's time evenly over the translated words");
    expect(skill).toContain("a gap over 0.3 s ends one");
    expect(skill).toContain("3 to 6 words");
    expect(skill).toContain("Lock the translation's emphasis words");
    expect(skill).toContain("Always `--no-scale`.");
  });

  test("jitter is fixed with --no-scale", () => {
    expect(skill).toContain("**Jitter.**");
    expect(skill).toContain("`--no-scale` (on `auto` and `subtitle`) keeps every word at 100% and highlights by colour alone");
  });

  test("silence trim, ducked music, reframing and the best moments", () => {
    expect(skill).toContain("`--silence-trim` cuts pauses longer than 0.6 s");
    expect(skill).toContain("ducks while someone speaks");
    expect(skill).toContain("**Aspect** `--aspect`: `9:16`");
    expect(skill).toContain("`nouclip highlight");
  });
});
