/**
 * Reading a 401's `WWW-Authenticate`: where its resource metadata is, the scope it wants, and why it refused — out of
 * the header shapes servers actually send, not only the tidy one.
 */

import { describe, expect, test } from "bun:test";
import { parseBearerChallenge } from "../src/oauth/challenge.ts";

describe("a Bearer challenge", () => {
  test("gives its resource metadata, scope and error, quoted or not", () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write"')).toEqual({
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "files:read files:write",
    });
    // Unquoted, as a server that should have quoted a URL often has not; a token value is read to the separator.
    expect(parseBearerChallenge("Bearer error=invalid_token, resource_metadata=https://mcp.example.com/meta?x=1")).toEqual({
      error: "invalid_token",
      resourceMetadata: "https://mcp.example.com/meta?x=1",
    });
  });

  test("reads names and the scheme in any case, and a quoted value's escapes", () => {
    expect(parseBearerChallenge('bearer Resource_Metadata="https://a.example/m", ERROR="insufficient_scope", error_description="say \\"please\\""')).toEqual({
      resourceMetadata: "https://a.example/m",
      error: "insufficient_scope",
    });
    // A comma inside quotes is part of the value, not the end of the parameter.
    expect(parseBearerChallenge('Bearer scope="a,b c"')?.scope).toBe("a,b c");
    // An escaped quote does not end the value: what reads like a parameter inside it is text, and the real one after it counts.
    expect(parseBearerChallenge('Bearer error_description="say \\"hi\\", scope=\\"x\\"", scope="real"')?.scope).toBe("real");
  });

  test("takes only the Bearer challenge's parameters when the header carries several", () => {
    // Another scheme's parameter of the same name, before and after, is not Bearer's.
    const header = 'Basic realm="files", scope="basic-scope", Bearer realm="mcp", scope="mcp:tools", DPoP algs="ES256", scope="dpop-scope"';
    expect(parseBearerChallenge(header)).toEqual({ scope: "mcp:tools" });
    // And one Bearer itself never named: a later scheme's `error` and `resource_metadata` are that scheme's.
    expect(parseBearerChallenge('Bearer realm="mcp", DPoP error="use_dpop_nonce", resource_metadata="https://other.example/m"')).toEqual({});
  });

  test("is null with no header, or no Bearer challenge in it, and a bare Bearer has no parameters", () => {
    expect(parseBearerChallenge(null)).toBeNull();
    expect(parseBearerChallenge("")).toBeNull();
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge("Bearer")).toEqual({});
  });

  test("survives a malformed header without hanging or throwing", () => {
    for (const header of ['Bearer scope="never closed', "Bearer ===, ,,", "Bearer realm=", '"Bearer" scope="x"', "Bearer @@@ scope=x"]) {
      expect(() => parseBearerChallenge(header), header).not.toThrow();
    }
    expect(parseBearerChallenge('Bearer scope="never closed')?.scope).toBe("never closed");
  });
});
