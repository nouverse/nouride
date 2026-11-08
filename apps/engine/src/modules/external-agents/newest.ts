/**
 * The newest version each coding CLI's package has published, as the npm registry says (0.8.24): read at most once a
 * day, and again when a person asks (Check again), so a box hears that one is out without asking the registry on every
 * scan or page load. Kept in `daemon_state`, so a restart does not ask again either.
 *
 * Nothing is said of a package the registry did not answer for — no network, a refusal, an answer that is not a version:
 * a stale one shown as the newest would be a guess. Only the CLIs installed here are asked about, so a box with none
 * asks nothing (EXTERNAL_AGENTS §5.4).
 */

import { createLogger } from "@nouride/shared";

const log = createLogger("external-agents");

const REGISTRY = "https://registry.npmjs.org";
/** How long a read stands. */
const DAY_MS = 24 * 60 * 60_000;
/** How long one package's answer is waited for: the registry is a convenience, never a reason to hold a page. */
const READ_MS = 10_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The last read: when it ran, the packages it asked about, and the newest of each that answered. */
export interface NewestRead {
  at: number;
  asked: string[];
  versions: Record<string, string>;
}

export interface NewestDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Where the last read is kept across a restart. Absent: in this process alone. */
  kept?: { load(): NewestRead | null; save(read: NewestRead): void };
}

export class NewestVersions {
  private last: NewestRead | null;
  private reading: Promise<NewestRead> | null = null;

  constructor(private readonly deps: NewestDeps = {}) {
    this.last = deps.kept?.load() ?? null;
  }

  /** The newest of each of `packages` the registry said: asked again when the last read is a day old, missed one, or `fresh`. */
  async of(packages: readonly string[], fresh = false): Promise<Record<string, string>> {
    if (packages.length === 0) return {};
    const now = (this.deps.now ?? Date.now)();
    const asked = new Set(this.last?.asked ?? []);
    if (fresh || !this.last || now - this.last.at >= DAY_MS || packages.some((name) => !asked.has(name))) {
      this.reading ??= this.read(packages, now).finally(() => {
        this.reading = null;
      });
      this.last = await this.reading;
      this.deps.kept?.save(this.last);
    }
    const versions = this.last.versions;
    return Object.fromEntries(packages.flatMap((name) => (versions[name] ? [[name, versions[name]]] : [])));
  }

  private async read(packages: readonly string[], now: number): Promise<NewestRead> {
    const versions: Record<string, string> = {};
    const unread: string[] = [];
    await Promise.all(
      packages.map(async (name) => {
        const version = await this.latest(name);
        if (version) versions[name] = version;
        else unread.push(name);
      }),
    );
    if (unread.length > 0) log.warn("the npm registry did not say the newest version of a coding CLI, so nothing is said of it", { packages: unread });
    log.info("the newest coding CLI versions read from the npm registry", { versions });
    return { at: now, asked: [...packages], versions };
  }

  /** The registry's `latest` for one package, or null. */
  private async latest(name: string): Promise<string | null> {
    try {
      const res = await (this.deps.fetch ?? fetch)(`${REGISTRY}/${name}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(READ_MS) });
      if (!res.ok) return null;
      const version = ((await res.json()) as { version?: unknown }).version;
      return typeof version === "string" && VERSION.test(version) ? version : null;
    } catch {
      return null;
    }
  }
}
