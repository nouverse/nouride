/**
 * Skills from elsewhere: find them, and bring one in as a pending draft.
 *
 * A search asks Nouverse's catalog (`catalog.ts`), which keeps the hubs' listings in its own order. The hubs are asked
 * themselves when one is named, when the catalog is turned off, and when it does not answer: a search that works
 * while Nouverse is down is worth the one branch, and the answer says which it was.
 *
 * Installing never writes to the pool. It fetches, normalizes (see `normalize.ts`), checks the name
 * against what is already there, and raises a draft in the same queue an agent's own skills wait in.
 * A person approves it like any other — reading the instructions agents will follow and the scripts
 * they will run, with where it came from beside them. That is the whole safety story, and it is the
 * same one whether a person asked for the install or an agent did.
 */

import { createLogger } from "@nouride/shared";
import type { SecretStore } from "@nouride/secrets";
import type { GlobalConfig } from "@nouride/shared";
import { readPool } from "@/modules/reflection/pool.ts";
import { proposeInstall } from "@/modules/reflection/install.ts";
import type { ReflectionEngine } from "@/modules/reflection/index.ts";
import type { SkillsCatalog } from "./catalog.ts";
import { HubError } from "./fetch.ts";
import { normalizeSkill } from "./normalize.ts";
import { fetchSkills, popularSkills, searchSource, SOURCE_IDS, type HubHit, type SourceDeps, type SourceId } from "./sources.ts";

export { SOURCE_IDS, type HubHit, type SourceId } from "./sources.ts";
export { HubError } from "./fetch.ts";
export { skillsCatalogFromEnvironment, type SkillsCatalog } from "./catalog.ts";

const log = createLogger("skills-hub");

export interface SkillHubDeps extends SourceDeps {
  agentsDir: string;
  builtinSkillsDir?: string;
  reflection: Pick<ReflectionEngine, "installDeps">;
  /** Nouverse's catalog, asked first. Absent: turned off, and the hubs are what a search asks. */
  catalog?: SkillsCatalog | undefined;
}

/** What a search or the list before one came from, and what the catalog said of its whole list. */
export interface HubFound {
  hits: HubHit[];
  /** A hub, or the catalog, that did not answer. */
  errors: { source: string; error: string }[];
  from: "catalog" | "hubs";
  /** The catalog's alone: how many match in all, and when its copy was last brought up to date. */
  total?: number;
  syncedAt?: string | null;
}

/**
 * The hub as the daemon runs it. The tool registry and the control API each build their own from what they already
 * hold, around the one catalog made at boot. The GitHub token is read per request, so one set after boot is used
 * without a restart.
 */
export function createSkillHub(deps: {
  config: GlobalConfig;
  secrets: Pick<SecretStore, "resolve">;
  reflection: Pick<ReflectionEngine, "installDeps">;
  builtinSkillsDir?: string | undefined;
  catalog?: SkillsCatalog | undefined;
}): SkillHub {
  return new SkillHub({
    ...(deps.catalog ? { catalog: deps.catalog } : {}),
    scratchDir: deps.config.daemon.dataDir,
    agentsDir: deps.config.daemon.agentsDir,
    ...(deps.builtinSkillsDir ? { builtinSkillsDir: deps.builtinSkillsDir } : {}),
    reflection: deps.reflection,
    get githubToken() {
      return deps.secrets.resolve("github_token");
    },
  });
}

export interface InstallResult {
  /** `flagged`: its source's scan found something, or could not be read (`FetchedSkill`). */
  drafts: { id: string; name: string; description: string; source: string; notes: string[]; warnings: string[]; flagged: boolean }[];
  refused: { name: string; reason: string }[];
  notes: string[];
}

/** How long the popular list is kept, and how many of it — Explore shows twelve; a page asking for more gets up to this. */
const POPULAR_TTL_MS = 60 * 60_000;
const POPULAR_KEPT = 24;
/** The catalog is one list where the hubs were three: it is asked for what three hubs' pages came to (it holds that to what it serves). */
const HUBS_ASKED = 3;
/** What the catalog is called where a hub's name goes: beside a failure, on the page and in a tool's answer. */
const CATALOG_NAME = "Nouverse's catalog";

const said = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SkillHub {
  constructor(private readonly deps: SkillHubDeps) {}

  /**
   * Nouverse's catalog, in its order, when no hub is named. Otherwise, and when the catalog does not answer, every
   * source at once, each with its own deadline, merged in turns so no one hub's ranking buries the others. A source
   * that fails is reported beside the results, not instead of them: the catalog too.
   */
  async search(query: string, options: { sources?: SourceId[]; limit?: number } = {}): Promise<HubFound> {
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
    const fell: HubFound["errors"] = [];
    if (!options.sources?.length && this.deps.catalog) {
      try {
        const page = await this.deps.catalog.search(query, limit * HUBS_ASKED);
        return { hits: page.hits, errors: [], from: "catalog", total: page.total, syncedAt: page.syncedAt };
      } catch (err) {
        fell.push({ source: CATALOG_NAME, error: said(err) });
      }
    }
    const sources = options.sources?.length ? options.sources : SOURCE_IDS;
    const settled = await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, hits: await searchSource(source, query, limit, this.deps) };
        } catch (err) {
          return { source, hits: [] as HubHit[], error: said(err) };
        }
      }),
    );
    const hits: HubHit[] = [];
    const longest = Math.max(0, ...settled.map((s) => s.hits.length));
    for (let i = 0; i < longest && hits.length < limit * sources.length; i += 1) {
      for (const s of settled) if (s.hits[i]) hits.push(s.hits[i]!);
    }
    return {
      hits,
      errors: [...fell, ...settled.flatMap((s) => ("error" in s && s.error ? [{ source: s.source, error: s.error }] : []))],
      from: "hubs",
    };
  }

  /**
   * What Explore shows before a search: Nouverse's own list, its picks first, kept as the catalog keeps a search. A
   * catalog that is off, does not answer or holds nothing yet leaves ClawHub's most used, kept an hour, so opening
   * the tab is one request to ClawHub an hour at most. A failure is not kept: the next open asks again.
   */
  async popular(limit = 12): Promise<HubFound> {
    const fell: HubFound["errors"] = [];
    if (this.deps.catalog) {
      try {
        const page = await this.deps.catalog.search("", POPULAR_KEPT);
        if (page.hits.length > 0) return { hits: page.hits.slice(0, limit), errors: [], from: "catalog", total: page.total, syncedAt: page.syncedAt };
      } catch (err) {
        fell.push({ source: CATALOG_NAME, error: said(err) });
        log.warn("the skills catalog did not answer; ClawHub's most used are shown", { error: said(err) });
      }
    }
    const now = Date.now();
    if (!this.popularCache || now - this.popularCache.at >= POPULAR_TTL_MS) this.popularCache = { at: now, hits: await popularSkills(POPULAR_KEPT, this.deps) };
    return { hits: this.popularCache.hits.slice(0, limit), errors: fell, from: "hubs" };
  }

  private popularCache: { at: number; hits: HubHit[] } | null = null;

  /** Fetch, normalize, check, and raise a pending draft per skill found. Throws `HubError` when nothing could be fetched. */
  async install(
    ref: string,
    who: { agentId: string; gatewayId?: string; chatId?: string; byAgent: boolean },
  ): Promise<InstallResult> {
    const { skills, notes } = await fetchSkills(ref, this.deps);
    const pool = await readPool(this.deps.agentsDir, this.deps.builtinSkillsDir);
    const result: InstallResult = { drafts: [], refused: [], notes };
    const taken = new Set<string>();

    for (const fetched of skills) {
      const candidate = normalizeSkill(fetched);
      if ("error" in candidate) {
        result.refused.push({ name: fetched.dirName, reason: candidate.error });
        continue;
      }
      const existing = pool.find((skill) => skill.name === candidate.name);
      const reason = existing
        ? existing.scope === "builtin"
          ? `Nouride ships a skill called "${candidate.name}" already`
          : `a skill called "${candidate.name}" is already installed`
        : this.deps.reflection.installDeps().drafts.pendingAllByName(candidate.name).length > 0 || taken.has(candidate.name)
          ? `a draft called "${candidate.name}" is already waiting for a decision`
          : null;
      if (reason) {
        result.refused.push({ name: candidate.name, reason });
        continue;
      }

      const provenance = [
        `URL: ${fetched.url}`,
        ...fetched.warnings,
        ...candidate.notes.map((note) => `- ${note}`),
        candidate.files.length ? `Files: ${candidate.files.map((file) => file.path).join(", ")}` : "Files: none besides SKILL.md",
      ].join("\n");
      const proposed = await proposeInstall(this.deps.reflection.installDeps(), {
        agentId: who.agentId,
        ...(who.gatewayId ? { gatewayId: who.gatewayId } : {}),
        ...(who.chatId ? { chatId: who.chatId } : {}),
        byAgent: who.byAgent,
        source: fetched.source,
        name: candidate.name,
        description: candidate.description,
        requires: candidate.requires,
        needsTools: candidate.needsTools,
        body: candidate.body,
        files: candidate.files,
        provenance,
      });
      if (!proposed.ok) {
        result.refused.push({ name: candidate.name, reason: proposed.error });
        continue;
      }
      taken.add(candidate.name);
      result.drafts.push({
        id: proposed.draft.id,
        name: candidate.name,
        description: candidate.description,
        source: fetched.source,
        notes: candidate.notes,
        warnings: fetched.warnings,
        flagged: fetched.flagged,
      });
    }
    log.info("skills fetched for install", { ref, by: who.agentId, drafts: result.drafts.length, refused: result.refused.length });
    return result;
  }
}

/** A failure worth showing as it is — a hub said no, a reference was malformed — or a generic one. */
export function hubErrorMessage(err: unknown): string {
  if (err instanceof HubError) return err.message;
  return `could not fetch it: ${err instanceof Error ? err.message : String(err)}`;
}
