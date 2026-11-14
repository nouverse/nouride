/**
 * The newest version each coding CLI's package has published, as the npm registry says (0.8.24): read at most once a
 * day, and again when a person asks (Check again), so a box hears that one is out without asking the registry on every
 * scan or page load. Kept in `daemon_state`, so a restart does not ask again either.
 *
 * Nothing is said of a package the registry did not answer for — no network, a refusal, an answer that is not a version:
 * a stale one shown as the newest would be a guess. Only the CLIs installed here are asked about, so a box with none
 * asks nothing.
 */

import type { CliOut } from "@nouride/acp";
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
  /**
   * Of each connector whose row names the CLI it carries: that CLI's own version in the connector's newest, and the
   * CLI's own newest. Absent in a read kept from before these were read, which is then read again.
   */
  carried?: Record<string, { byNewest?: string; newest?: string }>;
}

/** A connector asked about, with the CLI it carries where its row names one (`CliRow.carries`). */
export interface AskedPackage {
  package: string;
  carries?: { package: string; field: string };
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

  /**
   * What is out of each connector asked about, as the registry said: its newest version, and where its row names the
   * CLI it carries, that CLI's own version in the newest and the CLI's own newest. Asked again when the last read is a
   * day old, missed one, was kept before the carried CLIs were read, or `fresh`.
   */
  async of(asked: readonly AskedPackage[], fresh = false): Promise<Record<string, CliOut>> {
    if (asked.length === 0) return {};
    const now = (this.deps.now ?? Date.now)();
    const before = new Set(this.last?.asked ?? []);
    const unread = asked.some((entry) => !before.has(entry.package)) || (this.last?.carried === undefined && asked.some((entry) => entry.carries));
    if (fresh || !this.last || now - this.last.at >= DAY_MS || unread) {
      this.reading ??= this.read(asked, now).finally(() => {
        this.reading = null;
      });
      this.last = await this.reading;
      this.deps.kept?.save(this.last);
    }
    const { versions, carried } = this.last;
    return Object.fromEntries(
      asked.flatMap(({ package: name }) => {
        const out: CliOut = { ...(versions[name] ? { version: versions[name] } : {}), ...(carried?.[name]?.byNewest ? { carries: carried[name].byNewest } : {}), ...(carried?.[name]?.newest ? { own: carried[name].newest } : {}) };
        return Object.keys(out).length > 0 ? [[name, out]] : [];
      }),
    );
  }

  private async read(asked: readonly AskedPackage[], now: number): Promise<NewestRead> {
    const versions: Record<string, string> = {};
    const carried: NonNullable<NewestRead["carried"]> = {};
    const unread: string[] = [];
    await Promise.all(
      asked.map(async ({ package: name, carries }) => {
        const newest = await this.manifest(`${name}/latest`);
        const version = versionOf(newest?.version);
        if (version) versions[name] = version;
        else unread.push(name);
        if (!carries) return;
        // The CLI in the newest connector, where the connector pins one version of it: a range names none.
        const pinned = versionOf((newest?.dependencies as Record<string, unknown> | undefined)?.[carries.package]);
        const byNewest = pinned ? versionOf((await this.manifest(`${carries.package}/${pinned}`))?.[carries.field]) : null;
        const own = versionOf((await this.manifest(`${carries.package}/latest`))?.[carries.field]);
        carried[name] = { ...(byNewest ? { byNewest } : {}), ...(own ? { newest: own } : {}) };
      }),
    );
    if (unread.length > 0) log.warn("the npm registry did not say the newest version of a coding CLI, so nothing is said of it", { packages: unread });
    log.info("the newest coding CLI versions read from the npm registry", { versions, carried });
    return { at: now, asked: asked.map((entry) => entry.package), versions, carried };
  }

  /** One version of a package as the registry describes it (`<name>/latest`, `<name>/<version>`), or null. */
  private async manifest(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await (this.deps.fetch ?? fetch)(`${REGISTRY}/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(READ_MS) });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

/** A value that is one version and nothing else; a range, a tag or anything that is not text is none. */
const versionOf = (value: unknown): string | null => (typeof value === "string" && VERSION.test(value) ? value : null);
