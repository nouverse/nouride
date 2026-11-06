/**
 * The free disk a CLI run reads, stood in for: preloaded into the CLI's process by a test (`runCli`'s `preload`), so
 * `nouride doctor` sees `FAKE_FREE_DISK_MB` instead of what the machine running the tests has left. Doctor's own disk
 * line read the machine's, and a CI runner with 540 MB free turned the one problem a test expected into two.
 *
 * Through `require`, whose object the runtime's named import of `statfsSync` reads: a default import's copy is not it.
 */

const fs = require("node:fs") as typeof import("node:fs");
const mb = Number(process.env.FAKE_FREE_DISK_MB);
if (!Number.isFinite(mb)) throw new Error("free-disk.ts needs FAKE_FREE_DISK_MB");
const real = fs.statfsSync;
const BLOCK = 4096;
fs.statfsSync = ((path: import("node:fs").PathLike, options?: import("node:fs").StatFsOptions) => ({
  ...real(path, options as never),
  bsize: BLOCK,
  bavail: Math.floor((mb * 1024 * 1024) / BLOCK),
})) as typeof fs.statfsSync;
