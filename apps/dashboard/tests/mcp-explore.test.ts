/**
 * The MCP page's Explore tab (0.7.19): how a result says it runs, what the catalog line says, and what stops a catalog
 * server's form from saving while it still holds something to fill in.
 */

import { describe, expect, test } from "bun:test";
import { catalogLine, runsLabel } from "@/commons/components/mcp/McpExplore";
import { asksNoKey, draftBlocker } from "@/commons/components/mcp/McpServerForm";

describe("a result", () => {
  test("says how it runs here, or that it cannot", () => {
    expect(runsLabel({ runsVia: "remote" })).toBe("remote");
    expect(runsLabel({ runsVia: "npm" })).toBe("via npm");
    expect(runsLabel({ unsupported: "It needs uv, which this machine does not have.", blocked: { needs: ["uvx"], label: "needs uv" } })).toBe("needs uv");
    expect(runsLabel({ unsupported: "Docker is installed but cannot be used.", blocked: { needs: ["docker"], unusable: { docker: "no daemon" }, label: "Docker not usable" } })).toBe("Docker not usable");
    // An older daemon sent only the sentence.
    expect(runsLabel({ unsupported: "needs npx" })).toBe("cannot run here");
  });
});

describe("the catalog line", () => {
  const at = Date.parse("2026-10-19T02:00:00Z");
  test("says what the list is — Nouverse's picks, or how many match — and how fresh Nouverse's copy is", () => {
    expect(catalogLine(undefined, false)).toBe("");
    expect(catalogLine({ total: 45000, syncedAt: "2026-10-19T02:00:00Z" }, false, at + 3 * 3_600_000)).toBe("Nouverse's picks first, from the public catalog of connectors, updated 3 h ago.");
    expect(catalogLine({ total: 1302, syncedAt: "2026-10-19T02:00:00Z" }, true, at + 3 * 3_600_000)).toBe("1,302 matches in the public catalog of connectors, updated 3 h ago.");
    expect(catalogLine({ total: 1, syncedAt: null }, true)).toBe("1 match in the public catalog of connectors.");
  });
});

describe("a catalog server's form", () => {
  test("cannot be saved while its URL holds a {slug} or its arguments a <value>", () => {
    expect(draftBlocker({ url: "https://x/{slug}", local: false })).toBe("Replace the {…} in the URL first.");
    expect(draftBlocker({ args: "-y\n--port\n<port>", local: true })).toBe("Fill in the <…> in the arguments first.");
    expect(draftBlocker({ url: "https://x/mcp", local: false })).toBeNull();
    expect(draftBlocker({ args: "-y\npkg@1.0.0", local: true })).toBeNull();
  });
});

describe("a catalog server that asks for no key", () => {
  test("a remote one listing no token or header is said to need none — Notion signs in instead", () => {
    expect(asksNoKey({ runsVia: "remote" })).toBe(true);
    expect(asksNoKey({ runsVia: "remote", token: { name: "Authorization", required: true } as never })).toBe(false);
    expect(asksNoKey({ runsVia: "remote", headers: { "X-Org": "acme" } })).toBe(false);
    // A package runs here and takes its secrets in variables: no sign-in to speak of.
    expect(asksNoKey({ runsVia: "npm" })).toBe(false);
    expect(asksNoKey(undefined)).toBe(false);
  });
});
