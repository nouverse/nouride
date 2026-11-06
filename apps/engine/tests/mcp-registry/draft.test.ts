/**
 * A registry entry, read and turned into the MCP form it would fill in (0.7.19). The shapes are the registry's own, as
 * counted across its first nineteen hundred entries: remotes nine times in ten, `Authorization` as a bare secret or as
 * `Bearer {var}`, `X-API-Key`, a `{slug}` in a URL; npm, PyPI and OCI packages with positional and named arguments.
 */

import { describe, expect, test } from "bun:test";
import { normalizeEntry, publisherOf, type CatalogEntry } from "@/modules/mcp-registry/entry.ts";
import { draftFor, routeOf, serverNameFor, summaryOf, type InstallDraft } from "@/modules/mcp-registry/draft.ts";

const entry = (over: Record<string, unknown>): CatalogEntry => normalizeEntry({ name: "com.example/weather", version: "1.2.3", description: "Weather.", ...over })!;
const everything = () => true;
const draft = (over: Record<string, unknown>, has: (c: string) => boolean = everything): InstallDraft => {
  const result = draftFor(entry(over), has);
  if (!("draft" in result)) throw new Error(result.unsupported);
  return result.draft;
};
const remote = (headers: unknown[], url = "https://mcp.example.com/mcp") => ({ remotes: [{ type: "streamable-http", url, headers }] });

describe("reading an entry", () => {
  test("keeps what installing needs and drops what is malformed — a public file anyone with a namespace writes", () => {
    const read = normalizeEntry({
      name: "io.github.someone/tool",
      version: "2.0.0",
      title: "Tool",
      description: "Does things.",
      repository: { url: "https://github.com/someone/tool", source: "github" },
      remotes: [{ type: "streamable-http", url: "ftp://nope" }, { type: "carrier-pigeon", url: "https://x" }, { type: "sse", url: "https://x/sse" }],
      packages: [{ registryType: "npm", identifier: "@someone/tool", version: "2.0.0", environmentVariables: [{ name: "TOKEN", isSecret: true }, { nope: 1 }] }],
    });
    expect(read).toEqual({
      name: "io.github.someone/tool",
      version: "2.0.0",
      title: "Tool",
      description: "Does things.",
      repository: "https://github.com/someone/tool",
      remotes: [{ type: "sse", url: "https://x/sse", headers: [] }],
      packages: [{ registryType: "npm", identifier: "@someone/tool", version: "2.0.0", transport: "stdio", runtimeArguments: [], packageArguments: [], environmentVariables: [{ name: "TOKEN", isSecret: true }] }],
    });
  });

  test("a link is a web address or nothing: the page shows it as one, and a click on a `javascript:` one runs it", () => {
    expect(entry({ websiteUrl: "javascript:alert(1)", repository: { url: "data:text/html,<script>x</script>" }, ...remote([]) })).not.toHaveProperty("websiteUrl");
    expect(entry({ repository: { url: "javascript:alert(1)" }, ...remote([]) })).not.toHaveProperty("repository");
    expect(entry({ websiteUrl: "https://example.com/weather", ...remote([]) }).websiteUrl).toBe("https://example.com/weather");
  });

  test("an entry with no name, no namespace, or no way to run is not kept", () => {
    expect(normalizeEntry({ version: "1" })).toBeNull();
    expect(normalizeEntry({ name: "flat", version: "1", remotes: [{ type: "sse", url: "https://x" }] })).toBeNull();
    expect(normalizeEntry({ name: "a.b/c", version: "1" })).toBeNull();
  });

  test("its publisher, the right way round", () => {
    expect(publisherOf("com.notion/mcp")).toBe("notion.com");
    expect(publisherOf("io.github.github/github-mcp-server")).toBe("github.com/github");
    expect(publisherOf("ai.smithery/smithery-ai-slack")).toBe("smithery.ai");
  });
});

describe("a remote endpoint", () => {
  test("`Bearer {var}` with a secret variable is a bearer token to ask for", () => {
    const made = draft(remote([{ name: "Authorization", value: "Bearer {api_key}", isRequired: true, variables: { api_key: { isSecret: true, isRequired: true } }, description: "Your key." }]));
    expect(made).toMatchObject({ transport: "streamable-http", url: "https://mcp.example.com/mcp", runsVia: "remote", token: { name: "Authorization", required: true, description: "Your key." }, notes: [] });
    expect(made.token).not.toHaveProperty("header");
  });

  test("a bare secret Authorization is sent as a bearer token; any other secret header names itself", () => {
    expect(draft(remote([{ name: "Authorization", isSecret: true }])).token).toEqual({ name: "Authorization", required: true });
    expect(draft(remote([{ name: "X-API-Key", isSecret: true, isRequired: false }])).token).toEqual({ name: "X-API-Key", required: false, header: "X-API-Key" });
    expect(draft(remote([{ name: "x-key", value: "{key}", variables: { key: { isSecret: true } } }])).token).toMatchObject({ header: "x-key" });
  });

  test("a literal header is kept as one, and a second credential is left to the person, said", () => {
    const made = draft(remote([{ name: "X-Client", value: "nouride" }, { name: "Authorization", isSecret: true }, { name: "X-Other", isSecret: true }]));
    expect(made.headers).toEqual({ "X-Client": "nouride" });
    expect(made.notes).toEqual(["It also asks for the header X-Other: set it by hand after adding."]);
  });

  test("a {slug} in the URL is something to fill in, named with what the entry says it is", () => {
    const made = draft({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp/{memory}", variables: { memory: { description: "a public memory's slug" } } }] });
    expect(made.notes).toEqual(["Replace {memory} in the URL: a public memory's slug."]);
  });

  test("streamable-http is chosen over sse, and a remote over a package", () => {
    const made = draft({
      remotes: [{ type: "sse", url: "https://x/sse" }, { type: "streamable-http", url: "https://x/mcp" }],
      packages: [{ registryType: "npm", identifier: "x", version: "1" }],
    });
    expect([made.transport, made.url]).toEqual(["streamable-http", "https://x/mcp"]);
  });
});

describe("a package run here", () => {
  test("npm through npx, the version pinned, -y once, arguments in order", () => {
    const made = draft({
      packages: [{
        registryType: "npm",
        identifier: "@acme/weather-mcp",
        version: "1.2.3",
        runtimeArguments: [{ type: "named", name: "--yes" }],
        packageArguments: [{ type: "positional", value: "stdio" }, { type: "named", name: "--units", default: "metric" }, { type: "named", name: "--port", isRequired: true, valueHint: "port" }],
        environmentVariables: [
          { name: "ACME_TOKEN", isSecret: true, isRequired: true, description: "From acme.dev." },
          { name: "LOG_LEVEL", default: "info" },
          { name: "REGION", isRequired: true },
          { name: "OPTIONAL_THING" },
        ],
      }],
    });
    expect(made).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.2.3", "stdio", "--units", "metric", "--port", "<port>"],
      env: { LOG_LEVEL: "info" },
      envInputs: [{ name: "REGION", required: true }],
      secretEnv: [{ name: "ACME_TOKEN", required: true, description: "From acme.dev." }],
      runsVia: "npm",
      notes: ["Fill in <port> after --port in the arguments."],
    });
  });

  test("PyPI through uvx; an image through docker, every variable passed in by name", () => {
    expect(draft({ packages: [{ registryType: "pypi", identifier: "mcp-weather", version: "0.4.0" }] })).toMatchObject({ command: "uvx", args: ["mcp-weather==0.4.0"], runsVia: "pypi" });
    expect(
      draft({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/weather", version: "2.0.0", environmentVariables: [{ name: "TOKEN", isSecret: true }, { name: "MODE", default: "x" }] }] }),
    ).toMatchObject({ command: "docker", args: ["run", "-i", "--rm", "-e", "MODE", "-e", "TOKEN", "ghcr.io/acme/weather:2.0.0"], runsVia: "docker" });
    expect(draft({ packages: [{ registryType: "oci", identifier: "ghcr.io/acme/weather:2.0.0" }] }).args?.at(-1)).toBe("ghcr.io/acme/weather:2.0.0");
  });

  test("what this machine lacks is said, with how to get it — and what Nouride cannot run is said differently", () => {
    expect(draftFor(entry({ packages: [{ registryType: "npm", identifier: "x", version: "1" }] }), () => false)).toEqual({
      unsupported: "It needs Node.js, which this machine does not have. Node.js: `nouride pkg install nodejs npm`.",
      blocked: { needs: ["npx"] },
    });
    expect(draftFor(entry({ packages: [{ registryType: "mcpb", identifier: "https://x/b.mcpb" }] }), everything)).toEqual({
      unsupported: "Nouride cannot run it yet: it comes as mcpb.",
      blocked: { needs: [], forms: ["mcpb"] },
    });
  });

  test("of an entry's packages, the one whose program is easiest to have is used — as the card says", () => {
    const both = entry({ packages: [{ registryType: "oci", identifier: "acme/w", version: "1" }, { registryType: "npm", identifier: "@acme/w", version: "1" }] });
    expect(draftFor(both, everything)).toMatchObject({ draft: { command: "npx" } });
    expect(draftFor(both, (command) => command === "docker")).toMatchObject({ draft: { command: "docker" } });
  });
});

describe("its name in the pack", () => {
  test("the entry's own, short — the publisher's where the entry is called only mcp", () => {
    expect(serverNameFor({ name: "com.notion/mcp" })).toBe("notion");
    expect(serverNameFor({ name: "io.github.github/github-mcp-server" })).toBe("github");
    expect(serverNameFor({ name: "com.example/Weather Tools!" })).toBe("weather-tools");
    expect(serverNameFor({ name: "ai.smithery/smithery-ai-slack" })).toBe("smithery-ai-slack");
  });
});

describe("what the catalog keeps of it", () => {
  test("the ways it can run, best first, and what the first asks for — not the whole entry", () => {
    const both = entry({
      websiteUrl: "https://example.com",
      ...remote([{ name: "Authorization", value: "Bearer {key}", variables: { key: { isSecret: true, isRequired: true } } }]),
      packages: [
        { registryType: "oci", identifier: "example/weather" },
        { registryType: "npm", identifier: "@example/weather", environmentVariables: [{ name: "WEATHER_KEY", isSecret: true }] },
        { registryType: "mcpb", identifier: "https://x/weather.mcpb" },
        { registryType: "npm", identifier: "@example/weather-http", transport: { type: "streamable-http" } },
      ],
    });
    expect(summaryOf(both)).toEqual({
      name: "com.example/weather",
      version: "1.2.3",
      description: "Weather.",
      link: "https://example.com",
      runs: ["remote", "oci", "npm"],
      needs: ["Authorization"],
      other: ["mcpb", "npm over streamable-http"],
    });
    expect(summaryOf(entry({ packages: [{ registryType: "mcpb", identifier: "https://x/w.mcpb" }] })).runs).toEqual([]);
  });

  test("a row says how it would run here as the form would: the first way this machine has, or what it lacks", () => {
    expect(routeOf({ runs: ["remote", "npm"], other: [] }, () => false)).toEqual({ runsVia: "remote" });
    // No Node here, but Docker: the image, not a refusal over the package listed first.
    expect(routeOf({ runs: ["npm", "oci"], other: [] }, (command) => command === "docker")).toEqual({ runsVia: "docker" });
    // Easiest first, whatever order the entry lists them in.
    expect(routeOf({ runs: ["oci", "pypi"], other: [] }, () => false)).toEqual({
      unsupported:
        "It needs uv or Docker, which this machine does not have. uv: `nouride pkg install pipx`, then `pipx install uv` as the service user. " +
        "Docker: `nouride pkg install docker.io`, and give the service user its socket (the docker group, which is root in effect).",
      blocked: { needs: ["uvx", "docker"] },
    });
    expect(routeOf({ runs: [], other: ["nuget"] }, everything)).toEqual({
      unsupported: "Nouride cannot run it yet: it comes as nuget.",
      blocked: { needs: [], forms: ["nuget"] },
    });
  });

  test("Docker installed but not usable is said as that, not as Docker missing", () => {
    const route = routeOf({ runs: ["oci"], other: [] }, (command) => (command === "docker" ? { unusable: "the service user cannot reach /var/run/docker.sock" } : false));
    expect(route).toEqual({
      unsupported: "Docker is installed but cannot be used: the service user cannot reach /var/run/docker.sock.",
      blocked: { needs: ["docker"], unusable: { docker: "the service user cannot reach /var/run/docker.sock" } },
    });
  });
});
