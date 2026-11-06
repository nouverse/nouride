import { describe, expect, test } from "bun:test";
import type { Tool } from "@nouride/shared";
import { withSecretMask } from "@/modules/tools/secret-mask.ts";

const env = { GITHUB_TOKEN: "ghp_abc123:xyz", NOURIDE_CREDENTIALS_DIR: "/data/credentials", PIN: "1234" };

describe("withSecretMask", () => {
  test("masks a tool's result against the calling agent's environment", async () => {
    const tool = {
      definition: { name: "exec", description: "", parameters: {} },
      execute: async () => ({ content: "ghp_abc123:xyz", isError: false }),
    } as unknown as Tool;
    const masked = withSecretMask(tool, (ctx) => (ctx.agentId === "a" ? env : {}));
    const ctx = { agentId: "a" } as Parameters<Tool["execute"]>[1];
    expect((await masked.execute({}, ctx)).content).toBe("[REDACTED:GITHUB_TOKEN]");
    expect((await masked.execute({}, { ...ctx, agentId: "b" })).content).toBe("ghp_abc123:xyz");
  });
});
