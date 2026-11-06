/**
 * The pieces of the LLM Gateway page and the wizard's sign-in step that decide something.
 *
 * What is pasted back from an OAuth tab, which providers get a sign-in button, and what may end up in
 * the frame's address. The components around them only draw.
 */

import { describe, expect, test } from "bun:test";
import { parsePastedCode, signInHref, type GatewayProvider } from "@/modules/setup/gateway-api";
import { accountProviders, offerSentence, providerCopy } from "@/modules/setup/gateway-providers";
import { frameSource, parseGatewaySearch } from "@/modules/llm-gateway/search";

describe("parsePastedCode", () => {
  test("the address a failed localhost tab ends on gives its code and state", () => {
    expect(parsePastedCode("http://localhost:1455/auth/callback?code=abc123&state=xyz")).toEqual({ code: "abc123", state: "xyz" });
  });

  test("a code on its own is taken as it is", () => {
    // Some issuers show the code on a page instead of redirecting.
    expect(parsePastedCode("  abc123#state-part  ")).toEqual({ code: "abc123#state-part" });
  });

  test("a query string without a scheme still works", () => {
    expect(parsePastedCode("/callback?code=c&state=s")).toEqual({ code: "c", state: "s" });
  });

  test("an address with no code is passed on whole rather than guessed at", () => {
    expect(parsePastedCode("http://localhost:3000/oauth-callback?error=access_denied")).toEqual({
      code: "http://localhost:3000/oauth-callback?error=access_denied",
    });
  });

  test("nothing pasted is nothing", () => {
    expect(parsePastedCode("   ")).toBeNull();
  });
});

describe("signInHref", () => {
  test("a path of the gateway's opens under the mount, not at this origin's root", () => {
    // Antigravity answers `/oauth/start`; at the root it was a 404 from the daemon.
    expect(signInHref("/llm-gateway", "/oauth/start")).toBe("/llm-gateway/oauth/start");
  });

  test("an issuer's own address is left alone", () => {
    expect(signInHref("/llm-gateway", "https://auth.openai.com/oauth/authorize?x=1")).toBe("https://auth.openai.com/oauth/authorize?x=1");
    expect(signInHref("/llm-gateway", "//cdn.example/x")).toBe("//cdn.example/x");
  });
});

describe("the sign-in list, from what the gateway says", () => {
  const provider = (
    id: string,
    accountFlow: GatewayProvider["accountFlow"],
    accountCopy?: GatewayProvider["accountCopy"],
  ): GatewayProvider => ({ id, displayName: id.toUpperCase(), accountCount: 0, accountLimit: null, isCustom: false, accountFlow, ...(accountCopy !== undefined ? { accountCopy } : {}) });

  test("every provider a person signs in to — OAuth, device code or a pasted token — and no key form", () => {
    const rows = accountProviders([
      provider("a", "oauth-redirect"),
      provider("b", "device-code"),
      provider("c", "oauth-token"),
      provider("d", "api-key"),
      provider("e", null),
    ]);
    expect(rows.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("in the order the providers give, names breaking ties; a provider that gives none goes last", () => {
    const rows = accountProviders([
      provider("z", "device-code"),
      provider("y", "oauth-redirect", { label: "Second", hint: "h", order: 2 }),
      provider("x", "oauth-redirect", { label: "First", hint: "h", order: 1 }),
      provider("w", "device-code", { label: "Also second", hint: "h", order: 2 }),
    ]);
    expect(rows.map((p) => p.id)).toEqual(["x", "w", "y", "z"]);
  });

  test("named and described in the provider's words, or its own name and neutral ones", () => {
    expect(providerCopy(provider("p", "oauth-redirect", { label: "Its Label", hint: "Its hint", order: 1 }))).toEqual({ name: "Its Label", hint: "Its hint" });
    expect(providerCopy(provider("q", "device-code"))).toEqual({ name: "Q", hint: "Sign in with your account" });
    expect(providerCopy(provider("r", "device-code", null)).name).toBe("R");
  });

  test("a gateway older than `accountFlow` offers no buttons rather than wrong ones", () => {
    expect(accountProviders([{ id: "x", displayName: "X", accountCount: 0, accountLimit: null, isCustom: false }])).toEqual([]);
  });

  test("the card's sentence names what is offered, in order, and stays neutral when nothing is", () => {
    const offered = [
      provider("b", "device-code", { label: "Bee", hint: "h", order: 2 }),
      provider("a", "oauth-redirect", { label: "Ay", hint: "h", order: 1 }),
      provider("k", "api-key", { label: "Key", hint: "h", order: 0 }),
    ];
    expect(offerSentence(offered)).toBe("Sign in with Ay or Bee, no API key.");
    expect(offerSentence([offered[1]!])).toBe("Sign in with Ay, no API key.");
    expect(offerSentence(undefined)).toBe("Sign in with an AI subscription you already have, no API key.");
  });
});

describe("the frame's address", () => {
  test("a gateway path is kept", () => {
    expect(parseGatewaySearch({ page: "/providers/codex" })).toEqual({ page: "/providers/codex" });
  });

  test("anything that could climb out of the gateway's dashboard is dropped", () => {
    for (const page of ["//evil.example", "/../dashboard", "/a/../../x", "http://x", "/a?b", "/a#b", "providers"]) {
      expect(parseGatewaySearch({ page })).toEqual({});
    }
  });

  test("the overview is the default, not a parameter", () => {
    expect(parseGatewaySearch({ page: "/" })).toEqual({});
    expect(parseGatewaySearch({})).toEqual({});
  });

  test("the frame carries the mount, the page and the theme", () => {
    expect(frameSource("/llm-gateway", "/api-keys", "light")).toBe("/llm-gateway/frontend/api-keys?theme=light");
    expect(frameSource("/llm-gateway", undefined, "dark")).toBe("/llm-gateway/frontend/?theme=dark");
  });
});
