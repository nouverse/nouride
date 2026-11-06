/**
 * This daemon's own install is not the agents' to change.
 *
 * The binary, the dashboard, the shipped skills and the WhatsApp bridge sit beside `.nouride/`, owned by
 * the service account — that is what lets `nouride update` replace them without root. The same account
 * runs every agent's commands, so nothing in the filesystem stops an agent writing there, and two things
 * go wrong when one does: whatever it changed is silently put back by the next update, and a binary it
 * replaced is what the daemon runs at its next start, with every secret this daemon holds.
 *
 * The plausible accident is not an attack. It is an agent asked to "update nouride" building a newer
 * one and copying it over the running binary, or "fixing" a shipped skill in place and losing the fix a
 * week later. Both have a real door, and the refusal names it.
 *
 * Refused at the gate, like `reachesOwnCli`, so no approval level answers it. **Steering, not
 * containment**: a script can always spell a path no matcher catches. Reading is never refused — `ls`,
 * `file`, `cat`, copying a shipped skill *out* to change it — only a write that lands inside.
 */

import { basename, dirname, fileExistsSync, join } from "@nouride/runtime";
import { isShellScript } from "./exec-background.ts";

/** What `nouride update` and `install.sh` replace — the same names as the update's swap set. */
const PAYLOAD = ["nouride", "dashboard", "skills", "wa-bridge", "frontend"];

/** Any mention of a path is a change to it. */
const CHANGES = new Set(["mv", "rm", "rmdir", "unlink", "chmod", "chown", "chgrp", "touch", "truncate", "mkdir", "shred", "patch", "tee"]);
/** The last path, or `-t <dir>`, is the one written. */
const COPIES = new Set(["cp", "install", "ln", "rsync", "scp"]);
const EDITS_IN_PLACE = new Set(["sed", "perl"]);
const DOWNLOADS = new Set(["curl", "wget"]);
const UNPACKS = new Set(["tar", "bsdtar", "unzip"]);
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "bun", "deno"]);
const WRITE_CALLS = /open\s*\([^)]*['"][wax]b?\+?['"]|write_(text|bytes)|writeFile|copyFile|copyfile|shutil\.(copy|move)|rename|replace\(|unlink|rmtree|rmSync|chmod/;
/** Words that run the rest of the segment: the program is the word after them. */
const WRAPPERS = new Set(["sudo", "nohup", "env", "exec", "command", "time", "nice"]);

interface Install {
  dir: string;
  paths: string[];
}

export const OWN_INSTALL_REFUSAL =
  "That writes into this daemon's own install (%s). The binary, dashboard, shipped skills and bridge there are replaced by every update, and the binary is what the daemon runs at its next start, so they are never changed by hand. A newer version goes in with `nouride update` (the `nouride` tool, or the person runs it); a shipped skill you want different is copied into the skills pool or your own pack and edited there. Reading them is fine.";

/** The payload path a command would write, or null. */
export function writesOwnInstall(argv: string[], bin: string | undefined = process.env.NOURIDE_BIN): string | null {
  const install = ownInstall(bin);
  if (!install) return null;
  const text = isShellScript(argv) ? argv.slice(2).join(" ") : argv.join(" ");
  if (!text.includes(install.dir)) return null;

  for (const match of text.matchAll(/(?:>>?|>\|)\s*['"]?([^\s'";&|()<>]+)/g)) {
    if (inPayload(match[1] ?? "", install)) return match[1]!;
  }
  for (const words of isShellScript(argv) ? segments(text) : [argv]) {
    const hit = segmentWrite(words, install);
    if (hit) return hit;
  }
  return null;
}

/** A compiled install has its binary beside `.nouride/`; a source checkout does not, and its tree is the developer's. */
function ownInstall(bin: string | undefined): Install | null {
  if (!bin) return null;
  const dir = dirname(dirname(bin));
  if (!fileExistsSync(join(dir, "nouride"))) return null;
  return { dir, paths: PAYLOAD.map((name) => join(dir, name)) };
}

function inPayload(raw: string, install: Install): boolean {
  const path = raw.replace(/\/+$/, "");
  return install.paths.some((payload) => path === payload || path.startsWith(`${payload}/`));
}

function isInstallDir(raw: string, install: Install): boolean {
  return raw.replace(/\/+$/, "") === install.dir;
}

/** A script split at its operators, each part into words with the quotes taken off. Rough on purpose: see above. */
function segments(script: string): string[][] {
  return script
    .split(/\n|;|&&|\|\||\|/)
    .map((part) => (part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^(['"])([\s\S]*)\1$/, "$2")))
    .map((words) => {
      let start = 0;
      while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!) || WRAPPERS.has(words[start]!))) start += 1;
      return words.slice(start);
    })
    .filter((words) => words.length > 0);
}

function segmentWrite(words: string[], install: Install): string | null {
  const program = basename(words[0] ?? "");
  const args = words.slice(1);
  const paths = args.filter((arg) => !arg.startsWith("-"));
  const valueAfter = (flags: string[]): string | undefined => {
    const at = args.findIndex((arg) => flags.includes(arg));
    return at >= 0 ? args[at + 1] : args.find((arg) => flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)))?.split("=")[1];
  };

  if (CHANGES.has(program)) return paths.find((path) => inPayload(path, install)) ?? null;
  if (EDITS_IN_PLACE.has(program) && args.some((arg) => /^-[a-z]*i/.test(arg) || arg.startsWith("--in-place"))) {
    return paths.find((path) => inPayload(path, install)) ?? null;
  }
  if (COPIES.has(program)) {
    const target = valueAfter(["-t", "--target-directory"]) ?? paths.at(-1) ?? "";
    if (inPayload(target, install)) return target;
    // Into the install directory itself: a payload name among the sources is the binary or a tree replaced.
    const sources = paths.slice(0, -1).map((path) => basename(path.replace(/\/+$/, "")));
    if (isInstallDir(target, install) && (program === "rsync" || sources.some((name) => PAYLOAD.includes(name)))) return target;
    return null;
  }
  if (DOWNLOADS.has(program)) {
    const out = valueAfter(["-o", "-O", "--output", "--output-document"]);
    return out && inPayload(out, install) ? out : null;
  }
  if (UNPACKS.has(program)) {
    const into = valueAfter(["-C", "--directory", "-d"]);
    return into && (inPayload(into, install) || isInstallDir(into, install)) ? into : null;
  }
  if (program === "dd") {
    const out = args.find((arg) => arg.startsWith("of="))?.slice(3);
    return out && inPayload(out, install) ? out : null;
  }
  if (INTERPRETERS.has(program)) {
    const code = args.join(" ");
    const named = install.paths.find((payload) => code.includes(payload));
    return named && WRITE_CALLS.test(code) ? named : null;
  }
  return null;
}
