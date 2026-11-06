/**
 * What an OAuth failure says: the server's own `error` and `error_description`, capped, with anything that was sent to
 * it cut out — so quoting a server that echoes a code or a refresh token back never repeats it.
 */

import { describe, expect, test } from "bun:test";
import { refusal, withoutSecrets } from "../src/oauth/errors.ts";

describe("withoutSecrets", () => {
  test("cuts every occurrence of each secret, and leaves text that holds none", () => {
    expect(withoutSecrets("code abcdefgh1 then abcdefgh1 and rt-12345678", ["abcdefgh1", "rt-12345678", undefined])).toBe("code [redacted] then [redacted] and [redacted]");
    expect(withoutSecrets("nothing to see", ["abcdefgh1"])).toBe("nothing to see");
  });

  test("leaves a value too short to be a credential, which would cut every word it is part of", () => {
    expect(withoutSecrets("the client c was refused", ["c", ""])).toBe("the client c was refused");
  });
});

describe("refusal", () => {
  test("says the step, the server's error and its description — scrubbed and capped", () => {
    const said = refusal("renewing the login", 400, { error: "invalid_grant", error_description: `refresh token rt-secret-123 is spent ${"x".repeat(400)}` }, ["rt-secret-123"]);
    expect(said.code).toBe("invalid_grant");
    expect(said.message.startsWith("renewing the login was refused (invalid_grant: refresh token [redacted] is spent x")).toBe(true);
    expect(said.message.length).toBeLessThan(400);
  });

  test("falls back to the status when the server gave no error, and quotes no body", () => {
    expect(refusal("registering with https://auth.example/register", 500, {}, [])).toEqual({ message: "registering with https://auth.example/register was refused (HTTP 500)" });
  });
});
