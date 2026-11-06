/**
 * What adding a catalog entry to an agent would write: the MCP form, filled in — never saved from here. A person reads
 * it on the form (or the CLI prints it), gives what only they have (a token, a slug), and saves it through the same
 * door a server typed by hand goes through.
 *
 * One way to run it is chosen, in this order: a remote endpoint (nothing to run here), then an npm package through
 * `npx`, a Python one through `uvx`, an image through `docker` — each only when that program is on this machine. A
 * version is always pinned: an entry that moves on does not move an agent with it.
 */

import { publisherOf, type CatalogArgument, type CatalogEntry, type CatalogInput, type CatalogPackage } from "./entry.ts";
import { blockerText, pickRunner, runnersOf, type Blocker, type CanRun } from "./runners.ts";

export interface DraftInput {
  name: string;
  description?: string;
  required: boolean;
}

export interface InstallDraft {
  /** The server's name in the agent's pack, and its tools' prefix. */
  name: string;
  title?: string;
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /** Literal variables the package sets, with the values it gives. */
  env?: Record<string, string>;
  /** Variables the package needs a value for that are not secret. */
  envInputs?: DraftInput[];
  /** Variables the package marks secret: kept in the secret store (`env_secrets`). */
  secretEnv?: DraftInput[];
  /** Literal headers a remote endpoint wants. */
  headers?: Record<string, string>;
  /** The credential a remote endpoint wants: sent as `Authorization: Bearer` unless `header` names another. */
  token?: DraftInput & { header?: string };
  /** `name@version` in the registry. */
  source: string;
  publisher: string;
  runsVia: "remote" | "npm" | "pypi" | "docker";
  /** What the person still has to change before it can work, said for them. */
  notes: string[];
}

/** The form, or why there is none here: a sentence for a person, and the reason in a shape a badge is built from. */
export type DraftResult = { draft: InstallDraft } | { unsupported: string; blocked: Blocker };

/** What a row of results shows of an entry. */
export interface CatalogSummary {
  name: string;
  version: string;
  title?: string;
  description: string;
  /** Its website, or else its repository. */
  link?: string;
  /** The ways it can run, best first: `remote`, then its stdio packages' kinds. Empty: none Nouride can start. */
  runs: string[];
  /** The credentials the first of them asks for, by name. */
  needs: string[];
  /** The forms it comes in that Nouride does not start: `nuget`, `mcpb`, `npm over streamable-http`. */
  other: string[];
}

const GENERIC = new Set(["mcp", "server", "mcp-server", "mcp_server", "api", "remote"]);

/** A name for the pack: the entry's own, short, in the characters a server's name may have. */
export function serverNameFor(entry: Pick<CatalogEntry, "name">): string {
  const tail = entry.name.slice(entry.name.indexOf("/") + 1).toLowerCase();
  const publisher = publisherOf(entry.name).split(/[./]/).filter((part) => !["com", "io", "ai", "dev", "net", "org", "app", "github"].includes(part)).pop() ?? "";
  const base = GENERIC.has(tail) ? publisher || tail : tail.replace(/^mcp[-_]|[-_]mcp$|[-_]mcp[-_]server$|[-_]server$/g, "");
  const name = base.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$|_+$/g, "").replace(/__+/g, "_").slice(0, 32).replace(/[-_]+$/, "");
  return name || "mcp";
}

const placeholder = (hint: string) => `<${hint}>`;

/** One argument as argv, and a note when it holds something the person must fill in. */
function argv(argument: CatalogArgument, notes: string[]): string[] {
  const value = argument.value ?? argument.default;
  const hint = argument.valueHint ?? argument.name?.replace(/^-+/, "") ?? "value";
  if (value?.includes("{")) notes.push(`Replace the {…} in the argument ${argument.name ?? value}.`);
  if (argument.type === "positional") {
    if (value) return [value];
    if (!argument.isRequired) return [];
    notes.push(`Fill in ${placeholder(hint)} in the arguments.`);
    return [placeholder(hint)];
  }
  if (!argument.name) return [];
  if (value) return [argument.name, value];
  if (!argument.isRequired) return [];
  notes.push(`Fill in ${placeholder(hint)} after ${argument.name} in the arguments.`);
  return [argument.name, placeholder(hint)];
}

function inputOf(variable: CatalogInput): DraftInput {
  return { name: variable.name, ...(variable.description ? { description: variable.description } : {}), required: variable.isRequired === true };
}

function environment(pkg: CatalogPackage, draft: Pick<InstallDraft, "env" | "envInputs" | "secretEnv" | "notes">): void {
  for (const variable of pkg.environmentVariables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) continue;
    if (variable.isSecret) {
      (draft.secretEnv ??= []).push(inputOf(variable));
      continue;
    }
    const value = variable.value ?? variable.default;
    if (value !== undefined && !value.includes("{")) (draft.env ??= {})[variable.name] = value;
    else if (variable.isRequired) (draft.envInputs ??= []).push(inputOf(variable));
  }
}

function fromPackage(entry: CatalogEntry, pkg: CatalogPackage, runner: string): InstallDraft {
  const notes: string[] = [];
  const version = pkg.version ?? entry.version;
  const runtime = pkg.runtimeArguments.flatMap((argument) => argv(argument, notes));
  const own = pkg.packageArguments.flatMap((argument) => argv(argument, notes));
  const draft: InstallDraft = {
    name: serverNameFor(entry),
    ...(entry.title ? { title: entry.title } : {}),
    transport: "stdio",
    command: runner,
    source: `${entry.name}@${entry.version}`,
    publisher: publisherOf(entry.name),
    runsVia: pkg.registryType === "oci" ? "docker" : (pkg.registryType as "npm" | "pypi"),
    notes,
  };
  environment(pkg, draft);
  if (pkg.registryType === "npm") {
    const yes = runner === "npx" && !runtime.some((arg) => arg === "-y" || arg === "--yes") ? ["-y"] : [];
    draft.args = [...yes, ...runtime, `${pkg.identifier}@${version}`, ...own];
  } else if (pkg.registryType === "pypi") {
    draft.args = [...runtime, `${pkg.identifier}==${version}`, ...own];
  } else {
    // Docker hands a container nothing of its own environment: each variable is passed in by name.
    const passed = [...Object.keys(draft.env ?? {}), ...(draft.envInputs ?? []).map((v) => v.name), ...(draft.secretEnv ?? []).map((v) => v.name)].flatMap((name) => ["-e", name]);
    const image = /:[^/]+$/.test(pkg.identifier) || pkg.identifier.includes("@sha256:") ? pkg.identifier : `${pkg.identifier}:${version}`;
    draft.args = ["run", "-i", "--rm", ...passed, ...runtime, image, ...own];
  }
  return draft;
}

function fromRemote(entry: CatalogEntry, remote: CatalogEntry["remotes"][number]): InstallDraft {
  const notes: string[] = [];
  const draft: InstallDraft = {
    name: serverNameFor(entry),
    ...(entry.title ? { title: entry.title } : {}),
    transport: remote.type,
    url: remote.url,
    source: `${entry.name}@${entry.version}`,
    publisher: publisherOf(entry.name),
    runsVia: "remote",
    notes,
  };
  for (const name of remote.url.match(/\{[^}]+\}/g) ?? []) {
    const variable = remote.variables?.[name.slice(1, -1)];
    notes.push(`Replace ${name} in the URL${variable?.description ? `: ${variable.description}` : ""}.`);
  }
  for (const header of remote.headers) {
    const bearer = /^bearer\s+\{([^}]+)\}$/i.exec(header.value ?? "");
    const whole = /^\{([^}]+)\}$/.exec(header.value ?? "");
    const secretVariable = (key: string) => header.variables?.[key]?.isSecret === true || header.isSecret === true;
    const takes = (): boolean => {
      if (draft.token) {
        notes.push(`It also asks for the header ${header.name}: set it by hand after adding.`);
        return false;
      }
      return true;
    };
    if (bearer && header.name.toLowerCase() === "authorization" && secretVariable(bearer[1]!)) {
      if (takes()) draft.token = { ...inputOf(header), required: header.isRequired !== false };
    } else if (whole && secretVariable(whole[1]!)) {
      if (takes()) draft.token = { ...inputOf(header), required: header.isRequired !== false, header: header.name };
    } else if (header.value === undefined && header.isSecret) {
      if (!takes()) continue;
      // A bare `Authorization` the entry leaves to the person is almost always a bearer token: sent as one.
      draft.token = { ...inputOf(header), required: header.isRequired !== false, ...(header.name.toLowerCase() === "authorization" ? {} : { header: header.name }) };
    } else if (header.value !== undefined && !header.value.includes("{")) {
      (draft.headers ??= {})[header.name] = header.value;
    } else if (header.isRequired) {
      notes.push(`Set the header ${header.name} by hand after adding${header.description ? `: ${header.description}` : ""}.`);
    }
  }
  return draft;
}

const RUNNABLE = new Set(["npm", "pypi", "oci"]);

/** An entry as a row of results shows it (pure). Its needs are those of the way it runs where every runner is installed. */
export function summaryOf(entry: CatalogEntry): CatalogSummary {
  const runs = [
    ...(entry.remotes.length > 0 ? ["remote"] : []),
    ...new Set(entry.packages.filter((pkg) => pkg.transport === "stdio" && RUNNABLE.has(pkg.registryType)).map((pkg) => pkg.registryType)),
  ];
  const other = [...new Set(entry.packages.filter((pkg) => !(pkg.transport === "stdio" && RUNNABLE.has(pkg.registryType))).map(formOf))];
  const best = draftFor(entry, () => true);
  const needs = "draft" in best ? [...(best.draft.secretEnv ?? []).map((input) => input.name), ...(best.draft.token ? [best.draft.token.name] : [])] : [];
  const link = entry.websiteUrl ?? entry.repository;
  return { name: entry.name, version: entry.version, ...(entry.title ? { title: entry.title } : {}), description: entry.description, ...(link ? { link } : {}), runs, needs, other };
}

const formOf = (pkg: CatalogPackage) => (pkg.transport === "stdio" ? pkg.registryType : `${pkg.registryType} over ${pkg.transport}`);

/** How a catalog row would run on this machine, or why it cannot — a row's word for what `draftFor` decides. */
export function routeOf(summary: Pick<CatalogSummary, "runs" | "other">, can: CanRun): { runsVia: InstallDraft["runsVia"] } | { unsupported: string; blocked: Blocker } {
  if (summary.runs.includes("remote")) return { runsVia: "remote" };
  const runners = runnersOf(summary.runs);
  const blocked: Blocker = { needs: [], forms: summary.other };
  if (runners.length === 0) return { unsupported: blockerText(blocked), blocked };
  const picked = pickRunner(runners, can);
  return "runner" in picked ? { runsVia: picked.runner.via } : { unsupported: blockerText(picked.blocked), blocked: picked.blocked };
}

/**
 * The form for this entry, or why there is none on this machine. `can` says whether a program runs here (`runners.ts`).
 * Of an entry's packages the one whose runner is easiest to have is tried first, as `routeOf` does, so the card and the
 * form never disagree about how it runs.
 */
export function draftFor(entry: CatalogEntry, can: CanRun): DraftResult {
  const remote = entry.remotes.find((r) => r.type === "streamable-http") ?? entry.remotes.find((r) => r.type === "sse");
  if (remote) return { draft: fromRemote(entry, remote) };
  const runnable = entry.packages.filter((pkg) => pkg.transport === "stdio" && RUNNABLE.has(pkg.registryType));
  const runners = runnersOf(runnable.map((pkg) => pkg.registryType));
  if (runners.length === 0) {
    const blocked: Blocker = { needs: [], forms: [...new Set(entry.packages.map(formOf))] };
    return { unsupported: blockerText(blocked), blocked };
  }
  const picked = pickRunner(runners, can);
  if (!("runner" in picked)) return { unsupported: blockerText(picked.blocked), blocked: picked.blocked };
  const pkg = runnable.find((candidate) => candidate.registryType === picked.runner.via || (picked.runner.via === "docker" && candidate.registryType === "oci"))!;
  const command = pkg.registryType === "npm" && pkg.runtimeHint === "bunx" && can("bunx") === true ? "bunx" : picked.runner.command;
  return { draft: fromPackage(entry, pkg, command) };
}
