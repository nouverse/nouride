/**
 * The dashboard's daemon-config editor, and the one thing it kept getting wrong: which file it is.
 *
 * `FileService.daemonConfigPath()` derived the path as `<dataDir>/config.toml` while the loader
 * reads `<root>/.nouride/config.toml`. Those are the same file only on an install that never set a
 * data directory — which the default one does. So on any real install the editor read a file that
 * did not exist, showed an empty textarea beside a working Save button, and a save would have
 * written a second config nothing loads. On the live box: `path` came back as
 * `/srv/nouride/.nouride/data/config.toml` and `content` as 0 bytes, next to a 5 KB real config.
 *
 * The header of `config/global/paths.ts` records this exact derivation being fixed once already,
 * for the setup wizard. This was the third copy of the guess, and it had no test — hence this file,
 * which pins the path to what the loader itself answers rather than to a string written here.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import type { AgentRegistry } from "@nouride/persona";
import { FileService } from "@/modules/setup/files.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-daemon-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REAL_CONFIG = `[daemon]\ndata_dir = "./.nouride/data"\n\n[dashboard]\nenabled = true\n`;

/**
 * An install shaped like the ones this broke on: a config at the root, data in a subdirectory, and
 * a decoy at the path the old derivation produced. A test that omitted the decoy would pass against
 * the bug — both reads would simply find nothing.
 */
function install(): { configPath: string; dataDir: string; decoy: string } {
  const home = mkdtempSync(join(root, "install-"));
  const configPath = defaultConfigPath(home);
  const dataDir = join(home, ".nouride", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, REAL_CONFIG);
  const decoy = join(dataDir, "config.toml");
  writeFileSync(decoy, "# nothing loads this file\n");
  return { configPath, dataDir, decoy };
}

const registry = { get: () => undefined, reload: async () => {} } as unknown as AgentRegistry;

function service(configPath: string): FileService {
  return new FileService({
    agentsDir: join(root, "agents"),
    configPath,
    registry,
    config: DEFAULT_CONFIG,
    audit: undefined,
  });
}

let paths: ReturnType<typeof install>;
beforeEach(() => {
  paths = install();
});

describe("which file the editor edits", () => {
  test("it is the path the loader resolves, not one derived from the data directory", () => {
    expect(service(paths.configPath).daemonConfigPath()).toBe(paths.configPath);
    // Stated as an inequality too: the point is not the string, it is that the two differ at all.
    expect(paths.configPath).not.toBe(paths.decoy);
  });

  test("it reads the real config rather than the decoy beside the database", async () => {
    await expect(service(paths.configPath).readDaemonConfig()).resolves.toBe(REAL_CONFIG);
  });

  test("a save lands in the file the daemon boots from", async () => {
    const svc = service(paths.configPath);
    const edited = `${REAL_CONFIG}\n[security.access]\nallowlist = ["telegram:1"]\n`;

    await expect(svc.writeDaemonConfig(edited, "tester")).resolves.toEqual({
      ok: true,
      restartRequired: true,
    });

    expect(readFileSync(paths.configPath, "utf8")).toBe(edited);
    // Untouched: a write that also rewrote the decoy would hide the bug from the read above.
    expect(readFileSync(paths.decoy, "utf8")).toBe("# nothing loads this file\n");
  });

  test("an empty answer means the file is genuinely absent — the fresh-install case", async () => {
    const missing = join(root, "no-such-install", ".nouride", "config.toml");
    await expect(service(missing).readDaemonConfig()).resolves.toBe("");
  });

  test("it refuses a config that would not parse, and leaves the old one in place", async () => {
    const svc = service(paths.configPath);
    const result = await svc.writeDaemonConfig("[daemon\ndata_dir =", "tester");

    expect(result.ok).toBe(false);
    expect(readFileSync(paths.configPath, "utf8")).toBe(REAL_CONFIG);
  });
});
