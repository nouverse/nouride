/**
 * The platform and architecture this process is running on, asked of the operating system when it is called.
 *
 * Not `process.platform` / `process.arch`: `bun build --compile --target=…` folds those two into string literals of the
 * target it compiled for, so code lifted out of one compiled binary and compiled again for another target keeps
 * believing it is the first. A darwin-arm64 binary made that way from the linux-x64 release's code said `linux/x64` in
 * `nouride update --check` and would have installed the Linux build over itself (finding 3 of issue #7 on
 * nouride-releases). `os.platform()` and `os.arch()` are calls, which no compile folds — the answer is the machine's.
 */

import { arch, platform } from "node:os";

export interface RunningPlatform {
  /** `linux`, `darwin`, … — what `uname` would say, in Node's spelling. */
  platform: string;
  /** `x64`, `arm64`, … */
  arch: string;
}

export function runningPlatform(): RunningPlatform {
  return { platform: platform(), arch: arch() };
}
