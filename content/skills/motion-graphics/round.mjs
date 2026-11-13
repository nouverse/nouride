#!/usr/bin/env node
// round.mjs - one round of looking at a Remotion video, as one command: the frames to look at, worked out from its
// scenes; one bundle; a still and a check of each frame; the contact sheet. Part of the motion-graphics skill.
//
//   node round.mjs --scenes 3,5,4 --fps 30 [--round 1] [--out DIR] [--scale 0.5] [--entry src/index.ts] [--dry-run]
//
// Run it in the project's folder. --scenes is each scene's length in seconds, in order, as the storyboard has them;
// --fps the video's. Of each scene it takes two frames: arriving, a second after it starts, where the scene before
// should be gone and what comes in is halfway; and settled, half a second before it ends, where everything has come in
// and nothing has started to leave. A scene too short for both keeps a third of itself at each end.
//
// It type-checks, bundles once (a still from a bundle skips webpack), and renders, into --out (default: rounds/ in the
// project), for round N: rN-FRAME.png of Main, rN-check-FRAME.png of Check, and rN-sheet.png of Sheet. What an
// earlier run of the same round wrote there goes first. Then it names the pictures to read.
// --dry-run prints the frames and the commands and runs none.
//
// Exit 0 when every picture was written; 1 bad arguments; 2 the project does not type-check or bundle (the errors are
// above the line that says so); 3 a still was not rendered, most often a composition that is not registered.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

function usage(msg, code = 1) {
  if (msg) console.error(`round.mjs: ${msg}`);
  console.error("usage: node round.mjs --scenes 3,5,4 --fps 30 [--round 1] [--out DIR] [--scale 0.5] [--entry src/index.ts] [--dry-run]");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const opt = { scenes: null, fps: null, round: "1", out: "rounds", scale: "0.5", entry: "src/index.ts", dry: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--scenes") opt.scenes = args[++i];
  else if (a === "--fps") opt.fps = args[++i];
  else if (a === "--round") opt.round = args[++i];
  else if (a === "--out") opt.out = args[++i];
  else if (a === "--scale") opt.scale = args[++i];
  else if (a === "--entry") opt.entry = args[++i];
  else if (a === "--dry-run") opt.dry = true;
  else usage(`unknown option ${a}`);
}
const fps = Number(opt.fps);
const scenes = String(opt.scenes ?? "").split(",").map((s) => Number(s.trim()));
if (!opt.scenes || scenes.some((s) => !Number.isFinite(s) || s <= 0)) usage("--scenes is each scene's length in seconds, in order: --scenes 3,5,4");
if (!Number.isInteger(fps) || fps <= 0) usage("--fps is the video's frames a second: --fps 30");
if (!/^\d+$/.test(opt.round)) usage("--round is a number: 1 for the first round");
if (!(Number(opt.scale) > 0 && Number(opt.scale) <= 1)) usage("--scale is how large the pictures are, over 0 and up to 1: 0.5 is half");

/** Each scene's arriving and settled frame. For 3, 5 and 4 seconds at 30 fps: 30 and 75, 120 and 225, 270 and 345. */
function framesOf(lengths, rate) {
  const frames = [];
  let start = 0;
  for (const seconds of lengths) {
    const length = Math.round(seconds * rate);
    const third = Math.floor(length / 3);
    const arriving = start + Math.min(rate, third);
    const settled = start + length - Math.min(Math.round(rate / 2), third);
    frames.push({ arriving, settled: Math.max(settled, arriving) });
    start += length;
  }
  return frames;
}

const pairs = framesOf(scenes, fps);
const frames = [...new Set(pairs.flatMap((pair) => [pair.arriving, pair.settled]))];
const out = resolve(opt.out);
const tag = `r${opt.round}`;
const pictures = [...frames.flatMap((frame) => [join(out, `${tag}-${frame}.png`), join(out, `${tag}-check-${frame}.png`)]), join(out, `${tag}-sheet.png`)];
const still = (id, file, frame) => ["npx", "remotion", "still", "build", id, file, ...(frame === undefined ? [] : [`--frame=${frame}`]), `--scale=${opt.scale}`, "--log=error"];
const commands = [
  ["npx", "tsc", "--noEmit"],
  ["npx", "remotion", "bundle", opt.entry, "--out-dir=build", "--log=error"],
  ...frames.flatMap((frame) => [still("Main", join(out, `${tag}-${frame}.png`), frame), still("Check", join(out, `${tag}-check-${frame}.png`), frame)]),
  still("Sheet", join(out, `${tag}-sheet.png`)),
];

console.log(`round ${opt.round}: ${scenes.length} scene(s) at ${fps} fps, ${Math.round(scenes.reduce((a, b) => a + b, 0) * fps)} frames`);
pairs.forEach((pair, index) => console.log(`  scene ${index + 1} (${scenes[index]} s): arriving ${pair.arriving}, settled ${pair.settled}`));
if (opt.dry) {
  for (const command of commands) console.log(command.join(" "));
  process.exit(0);
}

mkdirSync(out, { recursive: true });
for (const old of readdirSync(out)) if (old.startsWith(`${tag}-`) && old.endsWith(".png")) rmSync(join(out, old), { force: true });
for (const [index, command] of commands.entries()) {
  const done = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (done.status === 0) continue;
  if (index < 2) {
    console.error(`round.mjs: \`${command.join(" ")}\` failed: fix what it says above, then run the round again. Nothing was rendered`);
    process.exit(2);
  }
  console.error(`round.mjs: \`${command.join(" ")}\` failed. Main, Check and Sheet are registered beside each other with the same size, fps and length (SKILL.md step 5)`);
  process.exit(3);
}
console.log(`wrote ${out}/: ${tag}-FRAME.png (the video at that frame), ${tag}-check-FRAME.png (what is measured there), ${tag}-sheet.png (how it moves)`);
console.log(`next: read these in one read call, then write the round's list (SKILL.md step 5): ${pictures.join(", ")}`);
