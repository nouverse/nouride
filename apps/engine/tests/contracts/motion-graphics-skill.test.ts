/**
 * What the shipped `motion-graphics` skill holds an agent to before a video reaches anyone (0.8.12). On 2026-10-31 an
 * agent sent a test render of a composition already in a repository: three scenes stacked at the top of the frame,
 * cards stretched over the footer. The skill already said to look first, but its probe render and an existing project
 * both went around the looking. These are the words that close those paths, and the contact sheet that no longer
 * wraps text differently from the video it shows.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { whichBinary } from "@nouride/runtime";

const source = readFileSync(join(import.meta.dir, "../../../../content/skills/motion-graphics/SKILL.md"), "utf8");
// As one line: where Markdown wraps a sentence is not part of what it says.
const skill = source.replace(/\s+/g, " ");

describe("nothing is sent before it is looked at", () => {
  test("no render reaches the person before step 5, the probe and an existing composition included", () => {
    expect(skill).toContain("**Nothing you render reaches the person before it has been through step 5**");
    expect(skill).toContain("not the probe, not a quick render to show progress, not a test render of a composition that was already in the repository");
    expect(skill).toContain("The probe measures the clock. Nobody receives it.");
  });

  test("a project that already exists goes through every step but the setup", () => {
    expect(skill).toContain("A project that already exists skips step 2 and goes through every other one");
  });

  test("the file is checked before it is sent, with the FFmpeg Remotion bundles", () => {
    expect(skill).toContain("Then check the file you are about to send, not the code that made it");
    expect(skill).toContain("npx remotion ffprobe");
    expect(skill).toContain("npx remotion ffmpeg -v error -y -ss $t -i out/video.mp4 -frames:v 1");
  });
});

describe("a round of looking is cheap enough to do", () => {
  test("one bundle per round, rebuilt after every edit", () => {
    // The round's command bundles once and renders every picture from the bundle (`round.mjs`, below).
    expect(skill).toContain("It prints each scene's arriving and settled frame, type-checks, bundles once, renders a still of `Main` and of `Check` at every one of those frames and the `Sheet`");
    expect(skill).toContain("**Bundle again after every edit**");
  });

  test("one settled still per scene, from the same scene lengths the video is built from", () => {
    expect(skill).toContain("**Settled stills.** One per scene, half a second before it ends");
    expect(skill).toContain("**Scene lengths live in one list** that the `<Series>` is built from");
  });

  /**
   * A transition is where neither the settled stills nor a 16-frame sheet look (0.8.12): settled stills sit at a scene's
   * end, and a 60 s video's sheet takes a frame every 4 s — a scene's title left under the next one, or a card flying
   * over a line while it comes in, falls between them.
   */
  test("and one arriving still per scene, a second in, in every round's stills", () => {
    expect(skill).toContain("**Arriving stills.** One per scene, a second after it starts: the scene before should be gone");
    expect(skill).toContain("Neither the settled stills nor the sheet are taken there.");
    expect(skill).toContain("The storyboard's scenes start at frames 0, 90 and 240, so its arriving stills are 30, 120 and 270.");
    // The round's own command takes them: 30 75, 120 225, 270 345 for the storyboard's three scenes.
    expect(source).toContain("node <this skill's folder>/round.mjs --scenes 3,5,4 --fps 30 --round 1");
  });

  test("defects are looked for by name", () => {
    expect(skill).toContain("Look for each of these by name");
    expect(skill).toContain("a word alone on the last line of a heading or a sentence");
    expect(skill).toContain("something from another scene still on screen");
    expect(skill).toContain("four avatars with one initial");
  });

  /**
   * Nix's feedback from a real test (0.8.12): told only to look for each item in turn, the per-item check was skipped.
   * So every round answers each item in writing, and the person gets that list with the video.
   */
  test("every round answers each item in writing, none or what was seen, and the video goes with the list", () => {
    expect(skill).toContain("**Write the answers down, every round.** Each item on that list gets a line: `none`, or what you saw and on which picture.");
    expect(skill).toContain("A line that is not `none` is fixed before the next round.");
    expect(skill).toContain("The message that sends the video carries the last round's list");
    expect(skill).toContain("with one line per scene and the last round's list from step 5");
    expect(skill).toContain("the list in its report");
  });

  test("a round's stills, checks and sheet are read in one `read` (0.8.12)", () => {
    // Live: four pictures a request was the most there was, and a helper lost each set of stills as it opened the next.
    // There is no count now; one read puts the whole round in front of the agent at once.
    expect(skill).toContain("`read` every still and its check, then the sheet, all of them in one `read`");
    expect(skill).not.toContain("four pictures to a `read`");
  });

  test("the written list has a line for every item on the checklist", () => {
    const section = source.slice(source.indexOf("Look for each of these by name"), source.indexOf("**Write the answers down"));
    const items = section.split("\n").filter((line) => line.startsWith("- ")).length;
    const answers = /```text\nRound 2[^\n]*\n([\s\S]*?)```/.exec(source)?.[1]?.split("\n").filter((line) => line.startsWith("- ")) ?? [];
    expect(items).toBeGreaterThan(0);
    expect(answers.length).toBe(items);
    for (const answer of answers) expect(answer).toMatch(/: (none|\S.*)$/);
  });
});

describe("assets: asked for first, then found, checked and cut by the book (0.8.12)", () => {
  // So the skill works on a small model too — where to find, how to cut, and always ask the person first.
  const assets = readFileSync(join(import.meta.dir, "../../../../content/skills/motion-graphics/references/assets.md"), "utf8");

  test("the skill asks the person about assets before looking, and points to the reference", () => {
    expect(skill).toContain("**Ask the person about the assets first, every time**");
    expect(skill).toContain("`references/assets.md` beside this file: read it before the storyboard");
    expect(skill).toContain("Assets: logo (theirs, logo.svg)");
  });

  test("the reference: ask, a licence for everything found, credits, and commands that run with what Remotion bundles", () => {
    expect(assets).toContain("## 1. Ask the person first");
    expect(assets).toContain("A file whose licence you cannot find is not used.");
    expect(assets).toContain("`CREDITS.md`");
    expect(assets).toContain('F="npx remotion ffmpeg -v error -y"');
    expect(assets).toContain('-vf "crop=1200:675:100:80"');
    expect(assets).toContain("-ss 5 -t 4 -i assets-src/clip.mp4");
    // Tried on the box: Remotion's FFmpeg has no `afade` and no `.m4a` muxer; the reference says so and fades in code.
    expect(assets).toContain("This FFmpeg has no `afade`, and cannot write `.m4a`");
    expect(assets).not.toMatch(/-af "[^"]*afade/);
    expect(assets).not.toMatch(/\.m4a /);
  });
});

test("every line that puts words or a number on screen carries its source in the storyboard (0.8.12)", () => {
  // Live: a small model's storyboard showed `nouride.com` and a tagline nobody had said.
  expect(skill).toContain("every line that puts words or a number on screen with its `source:`, where you read it");
  expect(skill).toContain("A line with no source you can write there is a line you made up");
  expect(skill).toContain("A URL on screen is one you opened.");
  expect(skill).toContain("source: example.com/features");
});

describe("a whole video is a mission", () => {
  test("drafted with the storyboard in its brief, so starting it is the one yes", () => {
    expect(skill).toContain("from a chat, draft it as a mission with `mission`, and put the storyboard in its brief, which becomes its `BRIEF.md`");
    expect(skill).toContain("starting the mission is one yes for the storyboard and the work");
    expect(skill).not.toContain("Where you can start a mission");
  });
});

describe("the contact sheet shows the video as it is", () => {
  const sheet = /`src\/Sheet\.tsx`:\s*```tsx\n([\s\S]*?)```/.exec(source)?.[1] ?? "";

  test("the snippet is found", () => {
    expect(sheet).toContain("export const makeSheet");
  });

  test("each cell is the whole video at its own width, scaled down", () => {
    // A cell sized as a share of the sheet minus its gaps came out 24 px narrower than a 1080-wide video, and a
    // headline that took two lines in the video took three in the sheet.
    expect(sheet).toContain("width: width / columns");
    expect(sheet).toContain("position: \"relative\", width, height, transform: `scale(${1 / columns})`");
    expect(sheet).not.toContain("gap:");
    expect(sheet).not.toContain("400%");
  });

  test("frames run along the rows", () => {
    // AbsoluteFill is a flex column: without the row, the frames ran down the columns and the sheet read out of order.
    expect(sheet).toContain("flexDirection: \"row\", flexWrap: \"wrap\"");
  });
});

describe("what goes on screen", () => {
  test("every claim has a source, and no adjective stands in for a number", () => {
    expect(skill).toContain("Every claim on screen comes from a source you can name");
    expect(skill).toContain("A number nobody measured does not go on screen");
  });

  test("overlapping sequences are named as the layering they are", () => {
    expect(skill).toContain("**A `<Sequence>` is a full-frame layer of its own**");
    expect(skill).toContain("One scene per `<Series.Sequence>`, none overlapping");
  });
});

/**
 * What can be measured is measured (0.8.12): in an unguided test with six planted defects, Nexa read a 26 px line on three
 * rounds of stills and wrote `none` for small text. `Check.tsx` ships beside the skill and measures four items of its
 * list in the render's own browser; live on the box it found the five planted defects that are measurable and nothing
 * on the clean source but its own two 32 px labels.
 */
describe("the measurable defects are measured, by a file that ships with the skill", () => {
  const check = readFileSync(join(import.meta.dir, "../../../../content/skills/motion-graphics/Check.tsx"), "utf8");

  test("the skill copies Check.tsx into src/, registers it, and renders a check of every still", () => {
    expect(skill).toContain("**Measured, not judged.** Six things on the list below are measured, and a measure does not skip one");
    expect(skill).toContain("Copy `Check.tsx` from this skill's folder, beside this file, into `src/`");
    expect(source).toContain('<Composition id="Check" component={makeCheck(Main)} {...MAIN} />');
    expect(skill).toContain("renders a still of `Main` and of `Check` at every one of those frames");
    expect(skill).toContain("A finding is fixed, or written in the round's list with why it is meant");
  });

  test("it measures the six the skill names, and says so on the frame", () => {
    expect(check).toContain("export const makeCheck = (Video: ComponentType) =>");
    for (const kind of ['kind: "small"', 'kind: "margin"', 'kind: "covered"', 'kind: "contrast"', 'kind: "alone"', 'kind: "overlap"']) expect(check).toContain(kind);
    expect(check).toContain("Math.min(width, height) / 30");
    expect(check).toContain("nothing measured wrong");
    // A clean frame is marked in a corner, small: a bar across the top hid every frame's top (live, 0.8.12).
    expect(check).toContain('{found && found.length === 0 && (\n        <div style={{ position: "absolute", right: 0, bottom: 0');
    expect(skill).toContain("the whole frame with a small green `nothing measured wrong` in its bottom-right corner");
    // It waits for the fonts and the pictures before it measures, or a fallback font's widths are what it judges.
    expect(check).toContain("delayRender(");
    expect(check).toContain("document.fonts.ready");
  });

  test("copied into src/, it passes the skill's own grep for code that flickers", () => {
    // Step 4's grep runs over src/: a check that tripped it would teach the agent to ignore the grep.
    const pattern = /Math\.random|setTimeout|setInterval|requestAnimationFrame|Date\.now|new Date\(|@keyframes|transition:|animation:|animate-|transition-|<img |<video |<audio /;
    expect(check).not.toMatch(pattern);
    expect(source).toContain("grep -rnE 'Math\\.random|setTimeout|setInterval|requestAnimationFrame|Date\\.now|new Date\\(|@keyframes|transition:|animation:|animate-|transition-|<img |<video |<audio ' src/");
  });

  test("the stills' frames are printed from the scene list, and all of them are taken every round", () => {
    // Nero's run (0.8.12): it picked its own frames and, after round 1, looked only where it had changed something —
    // the planted caption in the margin, in from 3.8 s into its scene, fell between them and went out with the video.
    expect(skill).toContain("**The frames come from the scene list, all of them every round.**");
    expect(skill).toContain("`round.mjs` (below) works them out from the scene lengths: `30 75`, `120 225`, `270 345` for the storyboard.");
    expect(skill).toContain("Every round renders all of them, not only the scenes you changed");
  });

  test("a clean grep is not a failed command", () => {
    // Nero's run (0.8.12): the grep found nothing, exited 1, and the job that ran the checks was reported failed.
    expect(source).toContain(`src/ && echo "FIX THESE" || echo "none of these"`);
    expect(skill).toContain("A grep that finds nothing exits 1, which is why the line ends with `|| echo`");
  });
});

/**
 * A clip made as content, for a feed: what it is asked first, what makes one work, and what more is measured.
 *
 * The skill made a video and asked about assets, never where the video would be watched: a clip for Reels came out as
 * a 16:9 film, its title in the band the app covers with its own buttons, its sentences up for a second. The shape is
 * asked with the assets; a feed clip's order is said as rules of structure, never of look; a line's time on screen is
 * counted from its length; and in a 9:16 frame `Check` measures what the app covers, where the 5% margin was all it
 * knew, and the contrast of text that has arrived.
 */
describe("a clip made for a feed", () => {
  const check = readFileSync(join(import.meta.dir, "../../../../content/skills/motion-graphics/Check.tsx"), "utf8");

  test("where it is watched is asked once, with the assets, and decides the frame", () => {
    expect(skill).toContain("**Ask what form, once**, in the same message as the assets, and only what the request does not already say");
    expect(skill).toContain("- **Where it is watched**, which decides its shape: a screen or YouTube (16:9); Reels, TikTok, Shorts or a story (9:16, a full phone screen); a feed post (4:5 or square).");
    expect(skill).toContain("With nothing said and nobody to ask, it is 16:9 with no sound.");
    expect(skill).toContain("a full phone screen, `1080×1920`; a feed post `1080×1350` or square `1080×1080`");
    expect(source.indexOf("**Ask what form, once**")).toBeLessThan(source.indexOf("**Ask the person about the assets first, every time**"));
  });

  test("its order is said as structure: a hook first, one idea a scene, its words on screen, an end card", () => {
    expect(skill).toContain("That decides its order, never its look:");
    for (const rule of ["- **The first scene is the hook**", "- **One idea a scene**", "- **What it says is on screen**: with the sound off it still says everything.", "- **The last scene is the end card**"]) expect(skill).toContain(rule);
    expect(skill).toContain("No logo alone, no fade from black, no greeting.");
  });

  test("words are given their time: a second for every 17 characters, counted in the storyboard and answered every round", () => {
    expect(skill).toContain("**Words need time.** A line is on screen, fully arrived, for a second for every 17 characters it has, and never under a second");
    expect(skill).toContain("`\"Giling tepat sebelum diseduh\" (28 characters: 2 s)`");
    expect(skill).toContain("- a line of words on screen for less than its time (a second for every 17 characters, never under one)");
    expect(skill).toContain("- words given their time:");
  });

  test("in a 9:16 frame the check measures what the app covers, in place of the margin, and the skill gives its numbers", () => {
    expect(skill).toContain("what matters stays out of the top 14%, the bottom 35% and the outer 6% of each side");
    expect(check).toContain("const COVERED = { top: 0.14, bottom: 0.35, side: 0.06 };");
    expect(check).toContain("const fullScreen = Math.abs(width / height - 9 / 16) < 0.01;");
    // One or the other: a full-screen frame is held to its bands, every other frame to the 5% margin.
    expect(check).toContain("    if (fullScreen) {");
    expect(check).toContain("    } else if (rects.some((b) => b.x < mx || b.y < my || b.x + b.w > width - mx || b.y + b.h > height - my)) {");
  });

  test("contrast is measured only on text that has arrived, against a plain colour: a fade is not a finding", () => {
    expect(check).toContain("if (front && back && front.a > 0.95 && opacityOf(el) > 0.95) {");
    expect(check).toContain("const needs = px >= min * 2 || (px >= min * 1.555 && weight >= 700) ? 3 : 4.5;");
    expect(check).toContain('if (s.backgroundImage && s.backgroundImage !== "none") return null;');
    expect(skill).toContain("text that has arrived and is too close in colour to the plain colour behind it (under 4.5:1, or 3:1 for large text)");
  });
});

describe("a round is one command", () => {
  const script = join(import.meta.dir, "../../../../content/skills/motion-graphics/round.mjs");
  const run = (args: string[]) => {
    const done = spawnSync(whichBinary("node") ?? process.execPath, [script, ...args], { encoding: "utf8" });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  test("the skill gives it whole, and says what it writes and what to read", () => {
    expect(source).toContain("node <this skill's folder>/round.mjs --scenes 3,5,4 --fps 30 --round 1");
    expect(skill).toContain("One round is one command, run in the project's folder.");
    expect(skill).toContain("into `rounds/` (`r1-75.png`, `r1-check-75.png`, `r1-sheet.png`), and its last line names the pictures to read");
  });

  test("its frames are the skill's: a second into each scene, and half a second before its end", () => {
    const dry = run(["--scenes", "3,5,4", "--fps", "30", "--dry-run"]);
    expect(dry.code).toBe(0);
    const said = dry.out.split("\n");
    expect(said.slice(0, 4)).toEqual(["round 1: 3 scene(s) at 30 fps, 360 frames", "  scene 1 (3 s): arriving 30, settled 75", "  scene 2 (5 s): arriving 120, settled 225", "  scene 3 (4 s): arriving 270, settled 345"]);
    // A scene too short for a second and a half keeps a third of itself at each end, and its frames stay inside it.
    expect(run(["--scenes", "1,0.5", "--fps", "30", "--dry-run"]).out.split("\n").slice(1, 3)).toEqual(["  scene 1 (1 s): arriving 10, settled 20", "  scene 2 (0.5 s): arriving 35, settled 40"]);
  });

  test("it type-checks, bundles once, then a still and a check of every frame, then the sheet", () => {
    const commands = run(["--scenes", "3,5", "--fps", "30", "--round", "2", "--out", "/tmp/r", "--dry-run"]).out.split("\n").filter((line) => line.startsWith("npx "));
    expect(commands.slice(0, 2)).toEqual(["npx tsc --noEmit", "npx remotion bundle src/index.ts --out-dir=build --log=error"]);
    expect(commands.slice(2, 4)).toEqual(["npx remotion still build Main /tmp/r/r2-30.png --frame=30 --scale=0.5 --log=error", "npx remotion still build Check /tmp/r/r2-check-30.png --frame=30 --scale=0.5 --log=error"]);
    expect(commands.filter((line) => line.includes(" still build Main ")).map((line) => /--frame=(\d+)/.exec(line)?.[1])).toEqual(["30", "75", "120", "225"]);
    expect(commands.at(-1)).toBe("npx remotion still build Sheet /tmp/r/r2-sheet.png --scale=0.5 --log=error");
    expect(commands.filter((line) => line.includes(" bundle "))).toHaveLength(1);
  });

  test("bad arguments are one line and exit 1", () => {
    expect(run([])).toMatchObject({ code: 1 });
    expect(run(["--scenes", "3,x", "--fps", "30"]).err).toContain("--scenes is each scene's length in seconds, in order: --scenes 3,5,4");
    expect(run(["--scenes", "3", "--fps", "0"]).err).toContain("--fps is the video's frames a second");
    expect(run(["--scenes", "3", "--fps", "30", "--scale", "2"]).err).toContain("--scale is how large the pictures are");
    expect(run(["--scenes", "3", "--fps", "30", "--frames", "1"]).err).toContain("unknown option --frames");
  });
});

