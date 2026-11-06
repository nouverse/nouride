/**
 * This process's environment and memory, out of reach of the commands it starts.
 *
 * Every command an agent runs is a process of the daemon's own user, and on Linux such a process may read
 * `/proc/<daemon>/environ` — every credential `.env`, an `EnvironmentFile=` or compose's `env_file` gave the daemon —
 * and `/proc/<daemon>/mem`. The exec classifier asks about those paths when it can see them; a script that builds the
 * path at run time it cannot. `prctl(PR_SET_DUMPABLE, 0)` closes it however the path is spelled: the kernel makes
 * this process's `/proc` files root's, and a process of the same user is refused them. The daemon keeps reading its
 * own, and its children are dumpable again from their `exec` on, so its measurements of them are unchanged.
 *
 * Through `bun:ffi`, because no JavaScript API reaches `prctl`. Linux only — elsewhere there is no such file to
 * protect — and best-effort: a libc this cannot open leaves the exec gate as the only line, which the caller says.
 */

import { dlopen, FFIType } from "bun:ffi";

const PR_SET_DUMPABLE = 4;

/** Where libc is on the libcs this ships against: glibc, then musl's names on x64 and arm64. */
function libcNames(): string[] {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return ["libc.so.6", `libc.musl-${arch}.so.1`, `ld-musl-${arch}.so.1`, "libc.so"];
}

/** `true` when this process is now non-dumpable; `false` off Linux, or where no libc could be opened. */
export function makeNonDumpable(): boolean {
  if (process.platform !== "linux") return false;
  for (const name of libcNames()) {
    try {
      const libc = dlopen(name, {
        prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      });
      try {
        return libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0;
      } finally {
        libc.close();
      }
    } catch {
      // Not this name; the next.
    }
  }
  return false;
}
