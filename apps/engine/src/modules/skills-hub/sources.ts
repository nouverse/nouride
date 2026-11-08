/**
 * Where a skill can come from, and how to find one: GitHub, skills.sh, ClawHub, and any site that
 * publishes `/.well-known/skills/index.json`.
 *
 * Each was probed against its live API before it was listed here (2026-10-06):
 *
 * | source | search | fetch |
 * |---|---|---|
 * | GitHub | — (code search needs a login) | the repo's tarball from codeload, pinned to a commit |
 * | skills.sh | `GET /api/search?q=` | the GitHub repo it indexes |
 * | ClawHub | `GET /api/v1/skills?search=` | `GET /api/v1/download?slug=&version=` — a ZIP |
 * | well-known | the index itself | each file the index lists |
 *
 * A reference names one source: `github:owner/repo/path@ref` (or a github.com URL, or bare
 * `owner/repo`), `skills.sh:owner/repo/skill`, `clawhub:slug`, `well-known:https://site[/skill]`.
 * Fetching only *reads*: nothing here writes to the pool. See `index.ts` for what happens next.
 */

import {
  extractTarGz,
  join,
  listDir,
  makeTempDir,
  readFileBytes,
  readTextFileSync,
  readZip,
  removePath,
  statFile,
  writeFileAtomic,
} from "@nouride/runtime";
import { HubError, hubBytes, hubJson, hubText, type HubFetchDeps } from "./fetch.ts";

export type SourceId = "github" | "skills.sh" | "clawhub" | "well-known";
export const SOURCE_IDS: SourceId[] = ["skills.sh", "clawhub", "well-known", "github"];

export interface RawFile {
  /** Relative to the skill's own directory. `SKILL.md` is one of them. */
  path: string;
  bytes: Uint8Array;
}

export interface FetchedSkill {
  /** The directory it lived in, which names it when its frontmatter does not. */
  dirName: string;
  files: RawFile[];
  /** Pinned: `github:owner/repo@<sha>/path`, `clawhub:slug@1.2.0`. */
  source: string;
  /** Where a person can look at it. */
  url: string;
  /** Things the source itself said about it — ClawHub's scan verdict, for one. */
  warnings: string[];
  /**
   * Its source's scan found something, or could not be read (0.8.23): what the dashboard says in its own words, its
   * `warnings` beneath them. A source that scans nothing flags nothing.
   */
  flagged: boolean;
}

export interface HubHit {
  ref: string;
  source: SourceId;
  name: string;
  description: string;
  url: string;
  installs?: number;
  stars?: number;
}

export interface SourceDeps extends HubFetchDeps {
  /** Where tarballs are unpacked for a moment. Removed before `fetchSkills` returns. */
  scratchDir: string;
  /** The sites asked by `well-known` search. */
  wellKnownSites?: string[];
}

const DEFAULT_WELL_KNOWN = ["https://agentskills.io"];
/** A whole repository: anthropics/skills is ~3 MB compressed. */
const MAX_TARBALL = 60_000_000;
/** One skill: more than this is not a skill, it is a project. */
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 12_000_000;
/** A repository with more than this many skills is installed this many at a time. */
const MAX_SKILLS_PER_INSTALL = 25;

type Ref =
  | { kind: "github"; owner: string; repo: string; path: string; ref?: string }
  | { kind: "skills.sh"; owner: string; repo: string; skill: string }
  | { kind: "clawhub"; owner?: string; slug: string; version?: string }
  | { kind: "well-known"; origin: string; name?: string };

/** What a reference means, or a sentence saying how to write one. */
export function parseRef(input: string): Ref | string {
  const raw = input.trim();
  const usage =
    "Name a source: `owner/repo[/path]`, a github.com URL, `skills.sh:owner/repo/skill`, `clawhub:slug`, or `well-known:https://site`.";
  if (!raw) return usage;

  const prefixed = /^(github|skills\.sh|clawhub|well-known):(.+)$/i.exec(raw);
  if (prefixed) {
    const [, kind, rest] = prefixed as unknown as [string, string, string];
    if (kind.toLowerCase() === "well-known") return wellKnownRef(rest) ?? usage;
    if (kind.toLowerCase() === "clawhub") {
      const match = /^@?(?:([\w.-]+)\/)?([\w.-]+)(?:@([\w.+-]+))?$/.exec(rest.trim());
      return match ? { kind: "clawhub", ...(match[1] ? { owner: match[1] } : {}), slug: match[2]!, ...(match[3] ? { version: match[3] } : {}) } : usage;
    }
    if (kind.toLowerCase() === "skills.sh") {
      const parts = rest.replace(/^https?:\/\/(www\.)?skills\.sh\//, "").split("/").filter(Boolean);
      return parts.length >= 3 ? { kind: "skills.sh", owner: parts[0]!, repo: parts[1]!, skill: parts.slice(2).join("/") } : usage;
    }
    return githubRef(rest) ?? usage;
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname === "github.com" || url.hostname === "www.github.com") return githubRef(raw) ?? usage;
    if (url.hostname.endsWith("skills.sh")) {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length >= 3 ? { kind: "skills.sh", owner: parts[0]!, repo: parts[1]!, skill: parts.slice(2).join("/") } : usage;
    }
    if (url.hostname.endsWith("clawhub.ai")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const slug = parts.at(-1);
      return slug ? { kind: "clawhub", ...(parts.length >= 2 ? { owner: parts.at(-2)!.replace(/^@/, "") } : {}), slug } : usage;
    }
    return wellKnownRef(raw) ?? usage;
  }
  return githubRef(raw) ?? usage;
}

function githubRef(text: string): Ref | null {
  let rest = text.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/, "");
  let ref: string | undefined;
  const at = /@([\w./-]+)$/.exec(rest);
  if (at) {
    ref = at[1];
    rest = rest.slice(0, at.index);
  }
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...tail] = parts as [string, string, ...string[]];
  // `/tree/<ref>/<path>` and `/blob/<ref>/<path>/SKILL.md`, as copied from the browser.
  if ((tail[0] === "tree" || tail[0] === "blob") && tail[1]) {
    ref ??= tail[1];
    tail.splice(0, 2);
  }
  if (tail.at(-1) === "SKILL.md") tail.pop();
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { kind: "github", owner, repo, path: tail.join("/"), ...(ref ? { ref } : {}) };
}

function wellKnownRef(text: string): Ref | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "https:") return null;
    const match = /\/\.well-known\/skills\/([^/]+)/.exec(url.pathname);
    const name = match?.[1] && match[1] !== "index.json" ? match[1] : url.pathname.replace(/^\/+|\/+$/g, "") || undefined;
    return { kind: "well-known", origin: url.origin, ...(name && !name.includes("/") && !name.startsWith(".") ? { name } : {}) };
  } catch {
    return null;
  }
}

// --- fetching ------------------------------------------------------------------------------------

export async function fetchSkills(input: string, deps: SourceDeps): Promise<{ skills: FetchedSkill[]; notes: string[] }> {
  const ref = parseRef(input);
  if (typeof ref === "string") throw new HubError(ref);
  switch (ref.kind) {
    case "github":
      return await fromGithub(ref.owner, ref.repo, ref.path, ref.ref, deps);
    case "skills.sh": {
      const all = await fromGithub(ref.owner, ref.repo, "", undefined, deps, ref.skill);
      if (all.skills.length === 0) throw new HubError(`${ref.owner}/${ref.repo} has no skill called "${ref.skill}"`);
      return all;
    }
    case "clawhub":
      return { skills: [await fromClawhub(ref.slug, ref.owner, ref.version, deps)], notes: [] };
    case "well-known":
      return await fromWellKnown(ref.origin, ref.name, deps);
  }
}

async function fromGithub(
  owner: string,
  repo: string,
  path: string,
  ref: string | undefined,
  deps: SourceDeps,
  only?: string,
): Promise<{ skills: FetchedSkill[]; notes: string[] }> {
  // Pinned before downloading, so what is reviewed is what gets installed, and a later "is there a
  // newer one" has something to compare against.
  const sha = (
    await hubText(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, deps, {
      maxBytes: 200,
      accept: "application/vnd.github.sha",
    })
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new HubError(`GitHub did not resolve ${owner}/${repo}@${ref ?? "HEAD"} to a commit`);

  const work = makeTempDir(deps.scratchDir, ".skills-hub-");
  try {
    const tarball = join(work, "repo.tar.gz");
    await writeFileAtomic(tarball, await hubBytes(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, deps, { maxBytes: MAX_TARBALL, timeoutMs: 60_000 }));
    const tree = join(work, "tree");
    await extractTarGz(tarball, tree);
    // codeload wraps everything in one `<repo>-<sha>/` directory.
    const top = listDir(tree).find((entry) => entry.isDirectory);
    if (!top) throw new HubError(`${owner}/${repo} is empty`);
    const root = join(tree, top.name);
    const base = path ? join(root, path) : root;
    if (!statFile(base)) throw new HubError(`${owner}/${repo} has no "${path}" at ${sha.slice(0, 7)}`);

    let dirs = statFile(join(base, "SKILL.md")) ? [""] : findSkillDirs(base, "", 0);
    if (only) {
      const wanted = only.toLowerCase();
      const byDir = dirs.filter((dir) => dir.split("/").at(-1)?.toLowerCase() === wanted);
      dirs = byDir.length ? byDir.slice(0, 1) : dirs.filter((dir) => frontmatterName(join(base, dir, "SKILL.md")) === wanted).slice(0, 1);
    }
    if (dirs.length === 0) throw new HubError(`no SKILL.md under ${owner}/${repo}${path ? `/${path}` : ""}`);

    const notes: string[] = [];
    if (dirs.length > MAX_SKILLS_PER_INSTALL) {
      notes.push(`${owner}/${repo} has ${dirs.length} skills; the first ${MAX_SKILLS_PER_INSTALL} were taken. Name a path for the others.`);
      dirs = dirs.slice(0, MAX_SKILLS_PER_INSTALL);
    }
    const skills = await Promise.all(
      dirs.map(async (dir) => {
        const skillPath = [path, dir].filter(Boolean).join("/");
        return {
          dirName: (skillPath.split("/").at(-1) || repo),
          files: await readTree(join(base, dir)),
          source: `github:${owner}/${repo}@${sha}${skillPath ? `/${skillPath}` : ""}`,
          url: `https://github.com/${owner}/${repo}/tree/${sha}${skillPath ? `/${skillPath}` : ""}`,
          warnings: [],
          flagged: false,
        } satisfies FetchedSkill;
      }),
    );
    return { skills, notes };
  } finally {
    removePath(work);
  }
}

/** Directories (relative to `base`) holding a `SKILL.md`, four levels deep at most. */
function findSkillDirs(base: string, rel: string, depth: number): string[] {
  if (depth > 4) return [];
  const found: string[] = [];
  for (const entry of listDir(join(base, rel))) {
    if (!entry.isDirectory || skipped(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (statFile(join(base, child, "SKILL.md"))) found.push(child);
    else found.push(...findSkillDirs(base, child, depth + 1));
  }
  return found.sort();
}

function frontmatterName(path: string): string | undefined {
  // Only the name line, so it does not matter whether the rest is YAML.
  try {
    const head = readTextFileSync(path).slice(0, 2000);
    return /^name:\s*["']?([^"'\n]+)/m.exec(head)?.[1]?.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

async function readTree(dir: string): Promise<RawFile[]> {
  const files: RawFile[] = [];
  let bytes = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    for (const entry of listDir(rel ? join(dir, rel) : dir)) {
      if (skipped(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(path, depth + 1);
        continue;
      }
      if (files.length >= MAX_SKILL_FILES) throw new HubError(`more than ${MAX_SKILL_FILES} files in one skill`);
      const data = await readFileBytes(join(dir, path));
      bytes += data.byteLength;
      if (bytes > MAX_SKILL_BYTES) throw new HubError(`one skill holds more than ${MAX_SKILL_BYTES} bytes`);
      files.push({ path, bytes: data });
    }
  };
  await walk("", 0);
  return files;
}

function skipped(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "__pycache__";
}

async function fromClawhub(slug: string, owner: string | undefined, pinned: string | undefined, deps: SourceDeps): Promise<FetchedSkill> {
  const base = "https://clawhub.ai/api/v1";
  const ownerQuery = owner ? `owner=${encodeURIComponent(owner)}` : "";
  const detail = await hubJson<{ skill?: { tags?: { latest?: string }; ownerHandle?: string }; latestVersion?: { version?: string }; owner?: { handle?: string } }>(
    `${base}/skills/${encodeURIComponent(slug)}${ownerQuery ? `?${ownerQuery}` : ""}`,
    deps,
    { maxBytes: 2_000_000 },
  );
  const version = pinned ?? detail.latestVersion?.version ?? detail.skill?.tags?.latest;
  if (!version) throw new HubError(`ClawHub has no published version of "${slug}"`);
  const who = owner ?? detail.owner?.handle ?? detail.skill?.ownerHandle;

  // ClawHub scans every version. Its verdict is shown with the draft, and "malicious" ends it here.
  const warnings: string[] = [];
  let concern = false;
  try {
    const scanned = await hubJson<{ version?: { security?: { status?: string; hasWarnings?: boolean; scanners?: Record<string, { status?: string; severity?: string }> } } }>(
      `${base}/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}${ownerQuery ? `?${ownerQuery}` : ""}`,
      deps,
      { maxBytes: 2_000_000 },
    );
    const security = scanned.version?.security;
    if (security?.status === "malicious") throw new HubError(`ClawHub's scan marks ${slug}@${version} as malicious, so it is not installed`);
    const flagged = Object.entries(security?.scanners ?? {})
      .filter(([, scan]) => scan.status && !["clean", "stale", "pending"].includes(scan.status))
      .map(([name, scan]) => `${name}: ${scan.status}${scan.severity ? ` (${scan.severity})` : ""}`);
    concern = flagged.length > 0 || (security?.status !== undefined && !["clean", "stale", "pending"].includes(security.status));
    warnings.push(`ClawHub scan: ${security?.status ?? "not scanned"}${flagged.length ? `. Flagged by ${flagged.join(", ")}` : ""}`);
  } catch (err) {
    if (err instanceof HubError && /malicious/.test(err.message)) throw err;
    concern = true;
    warnings.push("ClawHub scan: could not be read");
  }

  const zip = await hubBytes(
    `${base}/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}${ownerQuery ? `&${ownerQuery}` : ""}`,
    deps,
    { maxBytes: MAX_SKILL_BYTES, accept: "application/zip", timeoutMs: 60_000 },
  );
  const entries = readZip(zip, { maxBytes: MAX_SKILL_BYTES, maxFiles: MAX_SKILL_FILES });
  // ClawHub's own bookkeeping, not part of the skill.
  const files = entries.filter((entry) => entry.path !== "_meta.json" && !skipped(entry.path.split("/").at(-1) ?? ""));
  if (!files.some((file) => file.path === "SKILL.md")) throw new HubError(`ClawHub's ${slug}@${version} has no SKILL.md`);
  return {
    dirName: slug,
    files: files.map((entry) => ({ path: entry.path, bytes: entry.data })),
    source: `clawhub:${who ? `${who}/` : ""}${slug}@${version}`,
    url: `https://clawhub.ai/${who ? `${who}/` : ""}${slug}`,
    warnings,
    flagged: concern,
  };
}

interface WellKnownIndex {
  skills?: { name?: string; description?: string; files?: string[] }[];
}

async function fromWellKnown(origin: string, name: string | undefined, deps: SourceDeps): Promise<{ skills: FetchedSkill[]; notes: string[] }> {
  const index = await hubJson<WellKnownIndex>(`${origin}/.well-known/skills/index.json`, deps, { maxBytes: 2_000_000 });
  const listed = (index.skills ?? []).filter((skill) => typeof skill.name === "string" && /^[\w.-]+$/.test(skill.name));
  const chosen = name ? listed.filter((skill) => skill.name === name) : listed.slice(0, MAX_SKILLS_PER_INSTALL);
  if (chosen.length === 0) throw new HubError(name ? `${origin} lists no skill called "${name}"` : `${origin} lists no skills`);

  const skills: FetchedSkill[] = [];
  for (const skill of chosen) {
    const paths = (skill.files ?? ["SKILL.md"]).filter((path) => !path.split("/").some((part) => !part || part.startsWith("."))).slice(0, MAX_SKILL_FILES);
    if (!paths.includes("SKILL.md")) paths.unshift("SKILL.md");
    const files: RawFile[] = [];
    for (const path of paths) {
      files.push({ path, bytes: await hubBytes(`${origin}/.well-known/skills/${skill.name}/${path}`, deps, { maxBytes: 2_000_000 }) });
    }
    skills.push({
      dirName: skill.name!,
      files,
      source: `well-known:${origin}/${skill.name}`,
      url: `${origin}/.well-known/skills/${skill.name}/SKILL.md`,
      warnings: [],
      flagged: false,
    });
  }
  return { skills, notes: [] };
}

// --- searching -----------------------------------------------------------------------------------

interface ClawhubItem {
  slug?: string;
  ownerHandle?: string;
  displayName?: string;
  summary?: string;
  stats?: { installs?: number; downloads?: number; stars?: number };
}

function clawhubHit(item: ClawhubItem): HubHit {
  const path = `${item.ownerHandle ? `${item.ownerHandle}/` : ""}${item.slug}`;
  return {
    ref: `clawhub:${path}`,
    source: "clawhub",
    name: item.displayName ?? item.slug!,
    description: item.summary ?? "",
    url: `https://clawhub.ai/${path}`,
    ...(typeof item.stats?.downloads === "number" ? { installs: item.stats.downloads } : {}),
    ...(typeof item.stats?.stars === "number" ? { stars: item.stats.stars } : {}),
  };
}

/**
 * The most downloaded skills on ClawHub — what Explore shows before anything is typed. ClawHub is the hub that ranks a
 * whole list by use; skills.sh answers only a search of two letters or more.
 */
export async function popularSkills(limit: number, deps: SourceDeps): Promise<HubHit[]> {
  const data = await hubJson<{ items?: ClawhubItem[] }>(`https://clawhub.ai/api/v1/skills?sort=downloads&limit=${limit}`, deps, { maxBytes: 4_000_000, timeoutMs: 10_000 });
  return (data.items ?? []).filter((item) => item.slug).slice(0, limit).map(clawhubHit);
}

export async function searchSource(source: SourceId, query: string, limit: number, deps: SourceDeps): Promise<HubHit[]> {
  const q = encodeURIComponent(query);
  switch (source) {
    case "skills.sh": {
      const data = await hubJson<{ skills?: { id?: string; source?: string; skillId?: string; name?: string; installs?: number }[] }>(
        `https://skills.sh/api/search?q=${q}&limit=${limit}`,
        deps,
        { maxBytes: 2_000_000, timeoutMs: 10_000 },
      );
      return (data.skills ?? [])
        .filter((hit) => hit.id && hit.source)
        .map((hit) => ({
          ref: `skills.sh:${hit.id}`,
          source: "skills.sh" as const,
          name: hit.name ?? hit.skillId ?? hit.id!,
          description: `from ${hit.source}`,
          url: `https://skills.sh/${hit.id}`,
          ...(typeof hit.installs === "number" ? { installs: hit.installs } : {}),
        }));
    }
    case "clawhub": {
      const data = await hubJson<{ items?: ClawhubItem[] }>(
        // Three times the limit, because the filter below drops what does not match.
        `https://clawhub.ai/api/v1/skills?search=${q}&limit=${Math.min(limit * 3, 50)}`,
        deps,
        { maxBytes: 4_000_000, timeoutMs: 10_000 },
      );
      // ClawHub ranks by its own signals and answers "pdf" with a real-estate skill. Kept only when
      // the name or summary says one of the words asked for — the others are noise to choose from.
      const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
      return (data.items ?? [])
        .filter((item) => item.slug)
        .filter((item) => {
          const text = `${item.slug} ${item.displayName ?? ""} ${item.summary ?? ""}`.toLowerCase();
          return words.length === 0 || words.some((word) => text.includes(word));
        })
        .slice(0, limit)
        .map(clawhubHit);
    }
    case "well-known": {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: HubHit[] = [];
      for (const site of deps.wellKnownSites ?? DEFAULT_WELL_KNOWN) {
        const index = await hubJson<WellKnownIndex>(`${site}/.well-known/skills/index.json`, deps, { maxBytes: 2_000_000, timeoutMs: 10_000 });
        for (const skill of index.skills ?? []) {
          const text = `${skill.name} ${skill.description}`.toLowerCase();
          if (!skill.name || !words.some((word) => text.includes(word))) continue;
          hits.push({ ref: `well-known:${site}/${skill.name}`, source: "well-known", name: skill.name, description: skill.description ?? "", url: `${site}/.well-known/skills/${skill.name}/SKILL.md` });
        }
      }
      return hits.slice(0, limit);
    }
    case "github":
      // GitHub's code search needs a signed-in token for every call, and skills.sh already indexes
      // the public skill repositories. Installing by `owner/repo` still works without a search.
      return [];
  }
}
