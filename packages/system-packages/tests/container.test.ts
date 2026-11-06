/**
 * `root/container/nouride-pkg-container` — nouride-pkg in Nouride's container image (0.8.15): served without systemd,
 * and what agents installed kept on the volume and installed again when the container is recreated.
 *
 * Run as shipped, with nouride-pkg and its apk backend, against a stand-in `apk` that prints what apk-tools 3.0.8 printed
 * in the 0.8.14 image (Alpine 3.24) and keeps a world file as apk does. The PATH holds only the tools the scripts use:
 * a GitHub runner has a real `apt-get`, which nouride-pkg would pick before apk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually } from "./wait.ts";

const ROOT = join(import.meta.dir, "../root");
const SCRIPT = join(ROOT, "container", "nouride-pkg-container");
const IMAGE_WORLD = ["alpine-baselayout", "apk-tools", "bash", "busybox", "openssh-client", "ripgrep", "socat"];
const TOOLS = ["awk", "cat", "chmod", "chown", "comm", "cp", "grep", "ln", "mkdir", "mktemp", "mv", "rm", "sed", "sh", "sleep", "sort"];

let dir = "";
let env: Record<string, string> = {};
const at = (...parts: string[]) => join(dir, ...parts);
const ran = () => (existsSync(at("ran.log")) ? readFileSync(at("ran.log"), "utf8") : "");
const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

function tool(name: string, body: string): void {
  writeFileSync(at("bin", name), `#!/bin/sh\n${body}\n`);
  chmodSync(at("bin", name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-pkg-container-"));
  for (const sub of ["bin", "apk", "keep"]) mkdirSync(at(sub));
  for (const name of TOOLS) {
    const real = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map((d) => join(d, name)).find((path) => existsSync(path));
    if (!real) throw new Error(`no ${name} on this machine`);
    symlinkSync(real, at("bin", name));
  }
  writeFileSync(at("apk", "world"), `${IMAGE_WORLD.join("\n")}\n`);
  writeFileSync(at("installed"), `${IMAGE_WORLD.join("\n")}\nreadline\n`);
  // apk as the image has it: the simulations print apk-tools 3.0.8's own lines, and a change is logged and kept in the
  // world file the way apk keeps /etc/apk/world. `OFFLINE` fails whatever would need the network, and a name the
  // repositories do not have fails the whole transaction, as apk's does.
  tool(
    "apk",
    `world="$NOURIDE_PKG_APK/world"; installed="${at("installed")}"
case "$1" in
  search) for n in jq oniguruma ffmpeg; do [ "$n" = "$3" ] && echo "$n-1.0-r0"; done; exit 0 ;;
  info) grep -qxF "$3" "$installed"; exit $? ;;
  cache) echo "apk cache $2" >> "${at("ran.log")}"; exit 0 ;;
esac
case " $* " in
  *" --simulate jq "*) case "$1" in
    add) printf '(1/2) Installing oniguruma (6.9.10-r0)\\n(2/2) Installing jq (1.8.2-r0)\\nOK: 36.0 MiB in 65 packages\\n' ;;
    del) printf '(1/2) Purging jq (1.8.2-r0)\\n(2/2) Purging oniguruma (6.9.10-r0)\\nOK: 35.1 MiB in 63 packages\\n' ;;
  esac; exit 0 ;;
  *" --simulate bash "*) printf '(1/2) Purging bash (5.3.9-r1)\\n(2/2) Purging readline (8.3.3-r1)\\nOK: 32.3 MiB in 63 packages\\n'; exit 0 ;;
  *" --simulate "*) exit 1 ;;
esac
case " $* " in *" --no-network "*) ;; *) [ -n "\${OFFLINE:-}" ] && { echo "ERROR: network unreachable" >&2; exit 1; } ;; esac
if [ "$1" = add ]; then
  for n in "$@"; do case "$n" in -*|add) ;; jq|oniguruma|ffmpeg) ;; *) echo "ERROR: unable to select packages: $n (no such package)" >&2; exit 1 ;; esac; done
fi
echo "apk $*" >> "${at("ran.log")}"
op="$1"; shift
for n in "$@"; do
  case "$n" in -*) continue ;; esac
  if [ "$op" = add ]; then echo "$n" >> "$world"; echo "$n" >> "$installed"
  else grep -vxF "$n" "$world" > "$world.new"; mv "$world.new" "$world"; fi
done
echo "OK"`,
  );
  // busybox has these in the image; macOS has neither.
  tool("timeout", 'shift; exec "$@"');
  tool("flock", "exit 0");
  env = {
    NOURIDE_PKG_PATH: at("bin"),
    NOURIDE_PKG_LIB: ROOT,
    NOURIDE_PKG_LOCK: at("lock"),
    NOURIDE_PKG_KEEP: at("keep"),
    NOURIDE_PKG_APK: at("apk"),
    NOURIDE_PKG_SOCKET: at("nouride-pkg.sock"),
    NOURIDE_PKG_GROUP: "staff",
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function container(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync("/bin/sh", [SCRIPT, ...args], { cwd: dir, timeout: 20_000, encoding: "utf8", input: options.stdin ?? "", env: { ...env, ...options.env } });
  const out = result.stdout.trim().split("\n");
  return { code: result.status, status: out[out.length - 1] ?? "", out: result.stdout, err: result.stderr };
}

/** `start`, its output to a file: the listener it leaves running keeps what it inherited open, and a pipe would never end. */
function start(): number | null {
  const log = openSync(at("start.log"), "a");
  try {
    return spawnSync("/bin/sh", [SCRIPT, "start"], { cwd: dir, timeout: 20_000, stdio: ["ignore", log, log], env }).status;
  } finally {
    closeSync(log);
  }
}

describe("a request served in the container", () => {
  test("what an agent installed is written down on the volume, and what the image ships is not", () => {
    writeFileSync(at("apk", "world.image"), `${IMAGE_WORLD.join("\n")}\n`);
    const done = container(["serve"], { stdin: "install jq\n" });
    expect(done.status).toBe("@nouride-pkg ok install done");
    expect(done.out).toContain("+ oniguruma\n+ jq\n");
    expect(lines(at("keep", "world"))).toEqual(["jq"]);

    // Removed, it comes off the list: a recreate does not bring back what an agent took away.
    expect(container(["serve"], { stdin: "remove jq\n" }).status).toBe("@nouride-pkg ok remove done");
    expect(lines(at("keep", "world"))).toEqual([]);
  });

  test("a name a restore could not put back stays on the list: the next request does not forget it", () => {
    // Started with no network and a cache from an older release: ffmpeg is kept and not installed. A request answered
    // then wrote the list from the world alone, and the next recreate had nothing to install.
    writeFileSync(at("apk", "world.image"), `${IMAGE_WORLD.join("\n")}\n`);
    writeFileSync(at("keep", "world"), "ffmpeg\n");
    expect(container(["serve"], { stdin: "status\n" }).status).toBe("@nouride-pkg ok protocol=1 backend=apk");
    expect(lines(at("keep", "world"))).toEqual(["ffmpeg"]);
    expect(container(["serve"], { stdin: "install jq\n" }).status).toBe("@nouride-pkg ok install done");
    expect(lines(at("keep", "world"))).toEqual(["ffmpeg", "jq"]);
  });

  test("what the image ships is protected: removing it would break this container until it is recreated", () => {
    writeFileSync(at("apk", "world.image"), `${IMAGE_WORLD.join("\n")}\n`);
    const refused = container(["serve"], { stdin: "remove bash\n" });
    expect(refused.status).toBe("@nouride-pkg refused bash is protected: removing it could leave this box unreachable");
    expect(ran()).toBe("");
  });
});

describe("installed again", () => {
  test("from the list on the volume, a line that is not a package name left out", () => {
    writeFileSync(at("keep", "world"), "jq\n--allow-untrusted\nffmpeg\n");
    const done = container(["restore"]);
    expect(done.code).toBe(0);
    expect(ran()).toContain("apk add --no-progress jq ffmpeg\n");
    expect(ran()).not.toContain("allow-untrusted");
    expect(done.err).toContain("not installing again, not a package name: --allow-untrusted");
    // The old versions an update leaves in the cache go.
    expect(ran()).toContain("apk cache clean");
  });

  test("with no network, from the cache alone", () => {
    writeFileSync(at("keep", "world"), "jq\n");
    expect(container(["restore"], { env: { OFFLINE: "1" } }).code).toBe(0);
    expect(ran()).toBe("apk add --no-network --no-progress jq\napk cache clean\n");
  });

  test("one name the repositories no longer have does not keep the rest from coming back", () => {
    writeFileSync(at("keep", "world"), "jq\ngone\n");
    const done = container(["restore"]);
    expect(done.code).toBe(1);
    expect(ran()).toContain("apk add --no-progress jq\n");
    expect(done.err).toContain("could not install again: gone");
    // Its cache stays for the next start.
    expect(ran()).not.toContain("apk cache clean");
  });

  test("nothing kept, nothing run", () => {
    expect(container(["restore"]).code).toBe(0);
    expect(ran()).toBe("");
  });
});

describe("start", () => {
  test("the cache on the volume, the image's world taken once, what was kept installed again, and a listener for connections", async () => {
    writeFileSync(at("keep", "world"), "jq\n");
    // The listener: its arguments written down, and each loop's pid, to stop them at the end.
    tool("socat", `echo "$PPID" >> "${at("loops")}"; printf '%s\\n' "$@" > "${at("socat.args")}"; exec sleep 30`);
    try {
      expect(start()).toBe(0);
      await eventually(() => existsSync(at("socat.args")), 4_000, "the listener started");

      expect(lstatSync(at("apk", "cache")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(at("apk", "cache"))).toBe(at("keep", "cache"));
      expect(lines(at("apk", "world.image"))).toEqual(IMAGE_WORLD);
      expect(ran()).toContain("apk add --no-progress jq\n");
      expect(lines(at("socat.args"))).toEqual([
        `UNIX-LISTEN:${at("nouride-pkg.sock")},fork,max-children=4,unlink-early,user=root,group=staff,mode=0660`,
        `EXEC:${ROOT}/container/nouride-pkg-container serve`,
      ]);

      // A restart of the same container: the world now holds jq, and the image's world is still the image's.
      expect(start()).toBe(0);
      expect(lines(at("apk", "world.image"))).toEqual(IMAGE_WORLD);
    } finally {
      await eventually(() => (existsSync(at("loops")) ? lines(at("loops")).length : 0) >= 2, 2_000, "both listeners started").catch(() => {});
      // Each loop's sleep, then the loop: by the pids they wrote, nothing matched by name.
      for (const loop of existsSync(at("loops")) ? lines(at("loops")) : []) spawnSync("/bin/sh", ["-c", `pkill -P ${Number(loop)}; kill ${Number(loop)}`]);
    }
  });
});
