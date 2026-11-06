/**
 * One server of the official MCP registry, as Nouride reads it: what it is, who published it, and how it can run —
 * read from the registry's `server.json` (schema 2025-09-29 and 2025-12-11), keeping only what installing needs.
 *
 * Read defensively: the registry is public and its entries are written by anyone who proves a namespace, so a field of
 * the wrong type is dropped rather than trusted, and an entry with no way to run at all is not kept.
 */

/** An input the entry asks for: an environment variable, a header, or a variable inside one. */
export interface CatalogInput {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  /** A fixed value, possibly holding `{variable}` placeholders. */
  value?: string;
  default?: string;
  /** The placeholders `value` holds, each an input of its own. */
  variables?: Record<string, CatalogInput>;
}

export interface CatalogArgument {
  type: "positional" | "named";
  /** A named argument's flag, e.g. `--port`. */
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  isRequired?: boolean;
}

export interface CatalogPackage {
  /** `npm`, `pypi`, `oci`, `mcpb`, … */
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  /** How the started process speaks: `stdio` is the one Nouride runs. */
  transport: string;
  runtimeArguments: CatalogArgument[];
  packageArguments: CatalogArgument[];
  environmentVariables: CatalogInput[];
}

export interface CatalogRemote {
  type: "streamable-http" | "sse";
  url: string;
  headers: CatalogInput[];
  variables?: Record<string, CatalogInput>;
}

export interface CatalogEntry {
  name: string;
  version: string;
  title?: string;
  description: string;
  websiteUrl?: string;
  repository?: string;
  remotes: CatalogRemote[];
  packages: CatalogPackage[];
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRaw) : []);
/** A web address, or nothing: the page shows it as a link, and a `javascript:` one is a script a click runs. */
const webAddress = (value: unknown): string | undefined => {
  const url = text(value);
  try {
    return url && ["http:", "https:"].includes(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};

function input(raw: Raw): CatalogInput | null {
  const name = text(raw.name);
  if (!name) return null;
  const variables = isRaw(raw.variables)
    ? Object.fromEntries(
        Object.entries(raw.variables)
          .filter((entry): entry is [string, Raw] => isRaw(entry[1]))
          .map(([key, value]) => [key, input({ ...value, name: key })])
          .filter((entry): entry is [string, CatalogInput] => entry[1] !== null),
      )
    : undefined;
  return {
    name,
    ...(text(raw.description) ? { description: text(raw.description)! } : {}),
    ...(flag(raw.isRequired) !== undefined ? { isRequired: flag(raw.isRequired)! } : {}),
    ...(flag(raw.isSecret) !== undefined ? { isSecret: flag(raw.isSecret)! } : {}),
    ...(text(raw.value) ? { value: text(raw.value)! } : {}),
    ...(text(raw.default) ? { default: text(raw.default)! } : {}),
    ...(variables && Object.keys(variables).length ? { variables } : {}),
  };
}

function argument(raw: Raw): CatalogArgument | null {
  const type = raw.type === "named" ? "named" : raw.type === "positional" ? "positional" : null;
  if (!type) return null;
  return {
    type,
    ...(text(raw.name) ? { name: text(raw.name)! } : {}),
    ...(text(raw.value) ? { value: text(raw.value)! } : {}),
    ...(text(raw.default) ? { default: text(raw.default)! } : {}),
    ...(text(raw.valueHint) ? { valueHint: text(raw.valueHint)! } : {}),
    ...(flag(raw.isRequired) !== undefined ? { isRequired: flag(raw.isRequired)! } : {}),
  };
}

const inputs = (value: unknown) => list(value).map(input).filter((entry): entry is CatalogInput => entry !== null);
const argumentsOf = (value: unknown) => list(value).map(argument).filter((entry): entry is CatalogArgument => entry !== null);

/** A registry `server` object as Nouride keeps it, or null when it names nothing or offers no way to run. */
export function normalizeEntry(raw: unknown): CatalogEntry | null {
  if (!isRaw(raw)) return null;
  const name = text(raw.name);
  const version = text(raw.version);
  if (!name || !version || !name.includes("/")) return null;
  const remotes = list(raw.remotes)
    .map((remote): CatalogRemote | null => {
      const url = text(remote.url);
      const type = remote.type === "sse" ? "sse" : remote.type === "streamable-http" ? "streamable-http" : null;
      if (!url || !type || !/^https?:\/\//.test(url)) return null;
      const variables = input({ name: "url", variables: remote.variables })?.variables;
      return { type, url, headers: inputs(remote.headers), ...(variables ? { variables } : {}) };
    })
    .filter((remote): remote is CatalogRemote => remote !== null);
  const packages = list(raw.packages)
    .map((pkg): CatalogPackage | null => {
      const registryType = text(pkg.registryType);
      const identifier = text(pkg.identifier);
      if (!registryType || !identifier) return null;
      const transport = isRaw(pkg.transport) ? (text(pkg.transport.type) ?? "stdio") : "stdio";
      return {
        registryType,
        identifier,
        ...(text(pkg.version) ? { version: text(pkg.version)! } : {}),
        ...(text(pkg.runtimeHint) ? { runtimeHint: text(pkg.runtimeHint)! } : {}),
        transport,
        runtimeArguments: argumentsOf(pkg.runtimeArguments),
        packageArguments: argumentsOf(pkg.packageArguments),
        environmentVariables: inputs(pkg.environmentVariables),
      };
    })
    .filter((pkg): pkg is CatalogPackage => pkg !== null);
  if (remotes.length === 0 && packages.length === 0) return null;
  const repository = isRaw(raw.repository) ? webAddress(raw.repository.url) : undefined;
  return {
    name,
    version,
    ...(text(raw.title) ? { title: text(raw.title)! } : {}),
    description: text(raw.description) ?? "",
    ...(webAddress(raw.websiteUrl) ? { websiteUrl: webAddress(raw.websiteUrl)! } : {}),
    ...(repository ? { repository } : {}),
    remotes,
    packages,
  };
}

/**
 * Who published it, as a person reads it: the namespace the registry made them prove, turned the right way round —
 * `com.notion/mcp` is notion.com's, `io.github.github/github-mcp-server` is github.com/github's.
 */
export function publisherOf(name: string): string {
  const namespace = name.slice(0, name.indexOf("/"));
  const github = /^io\.github\.(.+)$/.exec(namespace);
  if (github) return `github.com/${github[1]}`;
  return namespace.split(".").reverse().join(".");
}
