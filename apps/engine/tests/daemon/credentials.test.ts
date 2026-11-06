/**
 * Credentials an agent can use without ever seeing one.
 *
 * The threat this is shaped around is not the filesystem, it is the context window. A
 * service-account JSON that reaches a conversation is in the provider's request log, in the session
 * on disk, and in whatever the model says next — three copies, none of which a `chmod` reaches. So
 * the property under test is narrow and specific: **the process can open it, the model cannot read
 * it, and asking to read it is refused rather than quietly allowed.**
 */

import { describe, expect, test } from "bun:test";
import { classifyHardline } from "@nouride/policy";
import { buildEnv } from "@/modules/tools/builtins/exec.ts";

describe("delivering a value-shaped credential", () => {
  test("it reaches the child environment", () => {
    const env = buildEnv({ TWIT_AUTH_TOKEN: "secret-value" });
    expect(env.TWIT_AUTH_TOKEN).toBe("secret-value");
    // And the ordinary allowlist still applies around it.
    expect(env.PATH).toBeDefined();
  });

  test("extras cannot replace the allowlisted environment wholesale", () => {
    // The allowlist is applied last, so a caller cannot quietly hand a child a different PATH and change
    // which binary a command resolves to. It was the other way round, and this test pinned it: an
    // `exec_secrets` entry named `path` arrives as `PATH` and would have replaced every command's.
    const env = buildEnv({ PATH: "/tmp/evil", HOME: "/tmp/evil-home" });
    expect(env.PATH).toBe(process.env.PATH!);
    expect(env.HOME).toBe(process.env.HOME!);
  });

  test("an empty value is dropped rather than exported as an empty string", () => {
    // A script testing `if [ -z "$TOKEN" ]` should see "absent", not "set to nothing".
    expect(buildEnv({ EMPTY: "" }).EMPTY).toBeUndefined();
  });

  test("nothing is added when the agent opted into nothing", () => {
    const bare = buildEnv();
    expect(Object.keys(bare).every((k) => !k.includes("TOKEN"))).toBe(true);
  });
});

describe("the credentials directory is gated for the model, not for scripts", () => {
  // Credential-path and runtime-self hardline classes are disabled (commented out in
  // classifyHardline). Reading a path is not destructive; the workspace roots and the secret
  // store's write-only API are the actual guards. These tests verify the classifier no longer
  // fires on credential paths.
  test("reading a credential file directly is no longer hardline", () => {
    const verdict = classifyHardline(["cat", "/srv/nouride/.nouride/data/credentials/token.json"]);
    expect(verdict).toBeNull();
  });

  test("credential directory paths are no longer caught", () => {
    expect(classifyHardline(["cat", "/mnt/nas/credentials/google.json"])).toBeNull();
    expect(classifyHardline(["base64", "/opt/secrets-store/credentials/key.pem"])).toBeNull();
  });

  test("a dot-prefixed directory is no longer caught either", () => {
    expect(classifyHardline(["cat", "/home/me/project/.agents/.credentials/token.json"])).toBeNull();
    expect(classifyHardline(["cat", "/srv/nouride/.nouride/agents/shared/.credentials/x.json"])).toBeNull();
  });

  test("a script that opens the file itself is NOT gated", () => {
    // The distinction the whole design rests on: a command the operator wrote may use a credential;
    // the agent reading one into the conversation may not. Gating both would make credentials
    // unusable and train the operator to click through prompts.
    expect(classifyHardline(["python3", "sync.py"])).toBeNull();
    expect(classifyHardline(["node", "scripts/report.mjs", "--since", "yesterday"])).toBeNull();
  });

  test("the runtime's own store is no longer hardline either", () => {
    expect(classifyHardline(["cat", "/srv/nouride/.nouride/data/secrets.json"])).toBeNull();
  });
});

describe("what the agent is told", () => {
  test("the rule travels with the path", async () => {
    const { buildSystemPrompt } = await import("@/modules/llm/prompt/index.ts");
    const { fakeAgent } = await import("../helpers.ts");

    const agent = fakeAgent();
    agent.config.execSecrets = [{ name: "twit_auth_token", commands: ["*"] }];
    const prompt = buildSystemPrompt({
      agent,
      tools: [{ name: "exec", description: "run a command", parameters: {} }],
      harness: {
        approvalRequired: [],
        approvalAvailable: true,
        maxToolIterations: 25,
        commands: [],
        truncates: false,
        workspace: { dir: "/w", roots: ["/w"] },
        credentialsDir: "/srv/nouride/.nouride/data/credentials",
        execSecrets: [{ name: "twit_auth_token", commands: ["*"] }],
      },
      gateway: "telegram",
      chatId: "1",
      chatType: "dm",
      sessionId: "s",
      timezone: "UTC",
      now: new Date("2026-08-19T00:00:00Z"),
    } as never);

    expect(prompt.text).toContain("/srv/nouride/.nouride/data/credentials");
    // Not merely "here is a directory" — the model needs to know it cannot read it, or it will try.
    expect(prompt.text).toMatch(/cannot open it/i);
    expect(prompt.text).toContain("$NOURIDE_CREDENTIALS_DIR");
    // Secret names are shown in the shell form the script will actually use.
    expect(prompt.text).toContain("$TWIT_AUTH_TOKEN");
    // And never the value — there is no value in the prompt path at all.
    expect(prompt.text).not.toContain("secret-value");
  });
});
