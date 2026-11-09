/**
 * Whether the installed systemd unit is the one this version writes — and, on a privileged root install, putting it
 * right after an update has proved itself.
 *
 * `nouride update` and the Box's own updates replace the binary and never the unit, which only `install.sh` and
 * the Box flasher write. So a unit kept whatever it was installed with: a guard whose restore list lacked `frontend/` on
 * every box flashed before 2026-10-15, and none of the directives later releases add. `nouride doctor` noticed one of
 * them — a `KillMode` regex — and nothing noticed the rest.
 *
 * The expected unit is written with the installed one's own measurements — its user, directory, command, memory
 * ceiling, `/tmp` size and environment — so only what the template changed is a difference, not the machine.
 */

import { readTextFileIfExists, runCommand, statFile, systemProgram, writeTextFileAtomic } from "@nouride/runtime";
import { SYSTEM_KEY_FILE } from "@nouride/secrets";
import { systemdUnit, type UnitParams } from "@/service/unit.ts";

export const INSTALLED_UNIT = "/etc/systemd/system/nouride.service";

const run = (argv: string[]) =>
  runCommand(argv, { cwd: "/", timeoutMs: 30_000, maxOutputBytes: 4_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }).catch(() => null);

/**
 * The systemd on this machine, so a unit carries only what it knows (`UnitParams.systemdVersion`). Read when a unit is
 * written, and right for the machine it is written on. Null when it cannot be read.
 */
export async function systemdVersion(): Promise<number | null> {
  const result = await run([systemProgram("systemctl"), "--version"]);
  return parseSystemdVersion(result?.exitCode === 0 ? result.stdout : "");
}

/** `{ systemdVersion }`, or nothing when it is unknown — for spreading into `UnitParams`. */
export const versionOf = (version: number | null): { systemdVersion?: number } => (version ? { systemdVersion: version } : {});

/** `systemd 252 (252.30-1~deb12u2)` → 252. Pure. */
export function parseSystemdVersion(text: string): number | null {
  const match = /^systemd (\d+)\b/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `refreshPrivilegedUnit` against this machine: the installed unit, kept as `.previous` when replaced, and systemd. */
export async function refreshInstalledUnit(log: RefreshDeps["log"]): Promise<boolean> {
  const version = await systemdVersion();
  return await refreshPrivilegedUnit({
    read: () => readTextFileIfExists(INSTALLED_UNIT).catch(() => null),
    write: async (text) => {
      const previous = await readTextFileIfExists(INSTALLED_UNIT);
      if (previous !== null) await writeTextFileAtomic(`${INSTALLED_UNIT}.previous`, previous, { mode: 0o644 });
      await writeTextFileAtomic(INSTALLED_UNIT, text, { mode: 0o644 });
    },
    reload: async () => (await run([systemProgram("systemctl"), "daemon-reload"]))?.exitCode === 0,
    ...versionOf(version),
    ...(statFile(SYSTEM_KEY_FILE) ? { keyFile: SYSTEM_KEY_FILE } : {}),
    root: process.getuid?.() === 0,
    log,
  });
}

/** What a unit we wrote was written with, read back from it; null for a unit that is not ours. */
export function installedUnitParams(text: string, systemdVersion?: number): UnitParams | null {
  if (!/^Environment=NOURIDE_SERVICE_KIND=systemd$/m.test(text)) return null;
  const one = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1]?.trim();
  const execStart = one("ExecStart");
  const workingDir = one("WorkingDirectory");
  const user = one("User");
  if (!execStart || !workingDir || !user) return null;
  const env: Record<string, string> = {};
  for (const match of text.matchAll(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    // These the template writes itself.
    if (match[1] === "HOME" || match[1] === "NOURIDE_SERVICE_KIND" || match[1] === "NOURIDE_CGROUP") continue;
    env[match[1]!] = match[2]!;
  }
  const memoryHigh = Number(one("MemoryHigh"));
  const tmpSize = Number(/^TemporaryFileSystem=\/tmp:size=(\d+)/m.exec(text)?.[1]);
  const envFile = /^EnvironmentFile=([^-].*)$/m.exec(text)?.[1]?.trim();
  const keyFile = /^EnvironmentFile=-(.*)$/m.exec(text)?.[1]?.trim();
  return {
    execStart,
    workingDir,
    user,
    // The privileged unit is the one without the sandbox; NoNewPrivileges is in every ordinary one.
    ...(/^NoNewPrivileges=true$/m.test(text) ? {} : { privileged: true }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(envFile ? { envFile } : {}),
    ...(keyFile ? { keyFile } : {}),
    ...(Number.isFinite(memoryHigh) && memoryHigh > 0 ? { memoryHighBytes: memoryHigh } : {}),
    ...(Number.isFinite(tmpSize) && tmpSize > 0 ? { tmpSizeBytes: tmpSize } : {}),
    ...(systemdVersion ? { systemdVersion } : {}),
  };
}

/**
 * The sizes a unit was written with that this machine no longer has: `MemoryHigh` and `/tmp`'s tmpfs are measured
 * from its memory when the unit is written, and the comparison above carries them over on purpose — so a container
 * given more memory, or less, kept the ceiling it was installed with, and nothing said so. Off by more than a quarter
 * is said; closer is the same machine measured twice. Pure.
 */
export function staleSizes(installed: string, measured: { memoryHighBytes?: number; tmpSizeBytes?: number }): string[] {
  const params = installedUnitParams(installed);
  if (!params) return [];
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  const off = (was: number | undefined, now: number | undefined) => was !== undefined && now !== undefined && Math.abs(now - was) > was / 4;
  const notes: string[] = [];
  if (off(params.memoryHighBytes, measured.memoryHighBytes)) {
    notes.push(`MemoryHigh is ${gib(params.memoryHighBytes!)}, sized for a machine with ${gib((params.memoryHighBytes! / 4) * 5)}; this one would get ${gib(measured.memoryHighBytes!)}`);
  }
  if (off(params.tmpSizeBytes, measured.tmpSizeBytes)) {
    notes.push(`/tmp is a ${gib(params.tmpSizeBytes!)} tmpfs; this machine would get ${gib(measured.tmpSizeBytes!)}`);
  }
  return notes;
}

/** The directives that differ — comments and blank lines are not settings. Pure. */
export function unitDrift(installed: string, expected: string): { added: string[]; removed: string[] } {
  const directives = (text: string) => new Set(text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
  const have = directives(installed);
  const want = directives(expected);
  return { added: [...want].filter((line) => !have.has(line)), removed: [...have].filter((line) => !want.has(line)) };
}

/** The installed unit against what this version writes, or null when there is none of ours to compare. */
export function compareInstalledUnit(installed: string | null, systemdVersion?: number, keyFile?: string): { expected: string; added: string[]; removed: string[]; privileged: boolean } | null {
  if (installed === null) return null;
  const read = installedUnitParams(installed, systemdVersion);
  if (!read) return null;
  // The key's file where `install.sh` (or a root daemon) made it since the unit was written (0.8.19).
  const params = keyFile ? { ...read, keyFile } : read;
  const expected = systemdUnit(params);
  return { expected, ...unitDrift(installed, expected), privileged: params.privileged === true };
}

export interface RefreshDeps {
  /** The installed unit's text, or null. */
  read(): Promise<string | null>;
  /** Replace it, keeping the one it replaces beside it. */
  write(text: string): Promise<void>;
  /** `systemctl daemon-reload`: the new unit applies from the next start. */
  reload(): Promise<boolean>;
  systemdVersion?: number;
  /** Root's file of the secret store's key, when there is one: the unit loads it (0.8.19). */
  keyFile?: string;
  /** Whether this process runs as root — the only one that can write the unit. */
  root: boolean;
  log: { info(message: string, data: Record<string, unknown>): void; warn(message: string, data: Record<string, unknown>): void };
}

/**
 * On a privileged root install, write the unit this version would, once an update has confirmed itself.
 *
 * After the confirmation, never before: the new binary has then proved it runs under the old unit, and the new unit
 * applies from the next start — which, on a box, is the next update's, with the guard counting again. Only our own
 * privileged unit, and only as root: an ordinary install's unit is root's and its daemon is not, so there `doctor`
 * says it is due and `install.sh` rewrites it. Answers whether it rewrote anything.
 */
export async function refreshPrivilegedUnit(deps: RefreshDeps): Promise<boolean> {
  if (!deps.root) return false;
  const compared = compareInstalledUnit(await deps.read(), deps.systemdVersion, deps.keyFile);
  if (!compared || !compared.privileged) return false;
  if (compared.added.length === 0 && compared.removed.length === 0) return false;
  await deps.write(compared.expected);
  const reloaded = await deps.reload();
  (reloaded ? deps.log.info : deps.log.warn)("the service unit was rewritten for this version", {
    added: compared.added,
    removed: compared.removed,
    ...(reloaded ? {} : { hint: "systemctl daemon-reload did not run: the new unit applies after the next boot" }),
  });
  return true;
}
