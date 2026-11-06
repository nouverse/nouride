/**
 * The MCP form's credential variables (0.7.19): what the rows send, and what stops a save before it is sent.
 */

import { describe, expect, test } from "bun:test";
import { secretEnvPayload, secretEnvProblem, secretEnvRows } from "@/commons/components/mcp/McpSecretEnv";

describe("a stdio server's secret variables in the form", () => {
  test("a stored one starts set and blank; blank keeps it, a value replaces it", () => {
    const rows = secretEnvRows({ envSecrets: [{ name: "GITHUB_TOKEN", set: true }] });
    expect(rows).toEqual([{ name: "GITHUB_TOKEN", value: "", set: true }]);
    expect(secretEnvPayload(rows)).toEqual({ GITHUB_TOKEN: {} });
    expect(secretEnvPayload([{ ...rows[0]!, value: " new " }])).toEqual({ GITHUB_TOKEN: { value: "new" } });
  });

  test("a new one needs a value and a variable's name, once", () => {
    expect(secretEnvProblem([{ name: "TOKEN", value: "", set: false }])).toBe("TOKEN has no value");
    expect(secretEnvProblem([{ name: "BAD-NAME", value: "v", set: false }])).toBe('"BAD-NAME" is not an environment variable\'s name');
    expect(secretEnvProblem([{ name: "", value: "v", set: false }])).toBe("A secret variable has no name");
    expect(secretEnvProblem([{ name: "A", value: "v", set: false }, { name: "A", value: "w", set: false }])).toBe("A is listed twice");
    expect(secretEnvProblem([{ name: "A", value: "v", set: false }])).toBeNull();
  });
});
