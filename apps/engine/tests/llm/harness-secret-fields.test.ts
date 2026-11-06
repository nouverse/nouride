/**
 * The line that names an agent's credentials says what is said about each (0.8.19, its fields): which site, which
 * account, so the agent knows which `$VARIABLE` is which without seeing a value. A credential with none reads as it
 * did; a long field is cut, and at most six are shown, so no field fills the prompt.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderFiles } from "@/modules/llm/prompt/harness-files.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";
import { setSecretFields } from "@/modules/tools/exec-secrets.ts";

function lines(execSecrets: { name: string; commands: string[] }[]): string {
  const harness = { approvalAvailable: true, approvalRequired: [], approvals: "balanced", workspace: { dir: "/w", privateDir: "/w/p", roots: ["/w"] }, execSecrets };
  return renderFiles({ ctx: { harness, tools: [{ name: "exec" }] }, toolNames: ["exec"], gated: [], free: ["exec"] } as unknown as HarnessView).join("\n");
}

afterEach(() => setSecretFields(() => undefined));

describe("the credentials line", () => {
  test("names each credential's fields beside its variable, with the commands it is bound to", () => {
    const said: Record<string, Record<string, string>> = { github_token: { domain: "github.com", username: "nouva-bot" }, pypi_token: { what: "the release upload" } };
    setSecretFields((name) => said[name]);
    const text = lines([
      { name: "github_token", commands: ["*"] },
      { name: "pypi_token", commands: ["twine upload"] },
      { name: "plain_one", commands: ["*"] },
    ]);
    expect(text).toContain(
      "These credentials reach your commands as environment variables: $GITHUB_TOKEN (domain: github.com, username: nouva-bot), $PYPI_TOKEN (only `twine upload`; what: the release upload), $PLAIN_ONE.",
    );
  });

  test("a long field is cut to a line, and no more than six are shown", () => {
    setSecretFields(() => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, i === 0 ? "x".repeat(300) : "y"])));
    const text = lines([{ name: "many", commands: ["*"] }]);
    expect(text).toContain(`$MANY (f0: ${"x".repeat(119)}…, f1: y, f2: y, f3: y, f4: y, f5: y)`);
    expect(text).not.toContain("f6:");
  });
});
