/**
 * Nouride's own secrets and an agent's commands (0.7.17). A command that names the secret store, a copy of it, or the
 * control token is refused at every approval level, and so is a line typed into a session (`credential-files.ts`). What
 * the store, the control token and the files of the credentials directory hold is masked out of every tool's result —
 * whole, and as those files are now (`tools/secret-mask.ts`). Real files and real processes: the guard reads paths the
 * way a shell does, and the masking has to hold for what a command actually prints.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalLevel, Tool, ToolCall, ToolContext } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { maskCredentials, ownSecretNamed, ownSecretValues, setCredentialsDir, setDataDir } from "@/modules/tools/credential-files.ts";
import { createBuiltinTools, resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";

// The default layout: `<install>/.nouride/{data,workspace,home}`, so the store is found by its name as well as its path.
const root = mkdtempSync(join(tmpdir(), "nouride-own-secrets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const install = join(root, ".nouride");
const dataDir = join(install, "data");
const workspace = join(install, "workspace");
const home = join(install, "home");
const credentials = join(install, "agents", "shared", ".credentials");
for (const dir of [dataDir, workspace, home, credentials, join(dataDir, "jobs")]) mkdirSync(dir, { recursive: true });

const STORED = "ghp_Zk3Qp9Lm2Rt8Vx1Wc4Yb7Nd5Hf6Js0Ga2Ke";
const CONTROL = "9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d0f";
const ACCESS = "ya29.a0AfB_byFakeAccessTok3n-0123456789";
const REFRESH = "1//0gFakeRefreshTok3n-abcdefghijklmn";
const CLIENT_SECRET = "GOCSPX-FakeClientSecret0123";
const X_SECRET = "Xs3cr3tFakeValue-0123456789";
const KEY_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "123-fake.apps.googleusercontent.com";

writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ version: 1, secrets: { github_token: STORED } }));
writeFileSync(join(dataDir, "secrets.json.bak-1788704461"), JSON.stringify({ version: 1, secrets: { github_token: STORED } }));
writeFileSync(join(dataDir, ".control-token"), `${CONTROL}\n`);
writeFileSync(join(dataDir, "nouride.db"), "");
writeFileSync(join(dataDir, "jobs", "j1.log"), "built\n");
// What Google's libraries keep: one minified line, its sign-in addresses beside its tokens.
const oauthCache = (access: string) =>
  JSON.stringify({ token: access, refresh_token: REFRESH, token_uri: TOKEN_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
writeFileSync(join(credentials, "tokens.json"), oauthCache(ACCESS));
// A service account's key is one JSON string with its line breaks written `\n`.
writeFileSync(
  join(credentials, "google_service_account.json"),
  `{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n${KEY_LINE}\\n-----END PRIVATE KEY-----\\n",\n  "token_uri": "${TOKEN_URI}"\n}\n`,
);
writeFileSync(join(credentials, "x-twitter.env"), `X_API_SECRET=${X_SECRET}\nX_USERNAME=nouva_bot\n`);
setDataDir(dataDir);
setCredentialsDir(credentials);

const security = { ...DEFAULT_CONFIG.security, exec: { ...DEFAULT_CONFIG.security.exec, mode: "full" as const, ask: "off" as const } };
const tools = createBuiltinTools({ security, web: {} as never, sessionStatus: (() => undefined) as never, memory: {} as never });
const exec = tools.get("exec")!;
const ctx = (): ToolContext => ({ agentId: "nouva", sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:nouva", senderId: "u", chatType: "dm", workspaceDir: workspace, agentDir: workspace, workspaceRoots: [workspace], turnId: "t", signal: new AbortController().signal });

describe("a command that names the store or the control token", () => {
  const named = [
    `cat ${dataDir}/secrets.json`,
    `cd ${dataDir} && cat secrets.json`,
    "cat ../data/secrets.json",
    `python3 -c "print(open('${dataDir}/secrets.json').read())"`,
    `cp ${dataDir}/secrets.json.bak-1788704461 /tmp/copy.json`,
    // A copy found only by where it leads, and one only by its name — another install's, in the default layout.
    "cp ../data/secrets.json.bak-1788704461 /tmp/copy.json",
    "cat /var/tmp/other/.nouride/data/secrets.json.bak-1",
    "cat /srv/other/data/.control-token",
    `cat ${dataDir}/.control-token`,
    "curl -H \"Authorization: Bearer $(cat ../data/.control-token)\" http://127.0.0.1:18254/api/agents",
    // The store encrypted (0.8.19), and its key where the daemon or install.sh keeps one.
    `cat ${dataDir}/secrets.enc`,
    "cp ../data/secrets.enc /tmp/copy.enc",
    `cat ${dataDir}/../encryption.key`,
    "cat /srv/other/.nouride/encryption.key",
    "cat /etc/nouride/nouride.env",
  ];

  test("is refused at the gate and when run — and does not run", async () => {
    for (const command of named) {
      const marked = `${command} ; touch ${join(workspace, "ran")}`;
      expect({ command, gate: exec.gate!({ command: marked }, ctx()) }).toEqual({ command, gate: { action: "refuse", reason: expect.stringContaining("one of Nouride's own secrets") } });
      const result = await exec.execute({ command: marked }, ctx());
      expect({ command, result: result.content.slice(0, 9), leaked: result.content.includes(STORED) || result.content.includes(CONTROL) }).toEqual({ command, result: "Refused: ", leaked: false });
    }
    expect(existsSync(join(workspace, "ran"))).toBe(false);
  });

  test("by `~` and `$HOME` too, as the service's own HOME sits beside the data", () => {
    // The store's name alone is no match outside the default layout's path: these are found by where they lead.
    for (const word of ["~/../data/secrets.json", "$HOME/../data/secrets.json", "${HOME}/../data/secrets.json"]) {
      expect({ word, named: ownSecretNamed(["bash", "-lc", `cat ${word}`], workspace, home) }).toEqual({ word, named: "~/../data/secrets.json" });
    }
  });

  test("is refused at every approval level, `trusted` too: nobody is asked and nothing runs", async () => {
    for (const level of ["careful", "balanced", "trusted"] as const) {
      expect({ level, ...(await underLevel(level, `cat ${dataDir}/secrets.json`)) }).toEqual({ level, asked: false, ran: false });
    }
    // The same harness lets an ordinary command through at `trusted`: the refusal is the guard's, not the harness's.
    expect(await underLevel("trusted", "echo hello")).toEqual({ asked: false, ran: true });
  });

  test("typed into a session — started with one, or sent one — is refused the same way", () => {
    const session = tools.get("session")!;
    expect(session.gate!({ action: "send", id: "s1", input: `cat ${dataDir}/secrets.json` }, ctx())).toMatchObject({ action: "refuse" });
    expect(session.gate!({ action: "start", command: `less ${dataDir}/.control-token` }, ctx())).toMatchObject({ action: "refuse" });
    expect(session.gate!({ action: "send", id: "s1", input: "ls -la" }, ctx())).toMatchObject({ action: "ask" });
  });
});

describe("what is beside them is not refused", () => {
  test("the database, the logs, the data directory itself, and a project's own secrets.json", () => {
    writeFileSync(join(workspace, "secrets.json"), '{"api":"x"}');
    for (const command of [`sqlite3 ${dataDir}/nouride.db .tables`, `tail ${dataDir}/jobs/j1.log`, `ls -la ${dataDir}`, "cat secrets.json", `ls ${credentials}`]) {
      const gate = exec.gate!({ command }, ctx());
      expect({ command, refused: gate.action === "refuse" && gate.reason.includes("Nouride's own secrets") }).toEqual({ command, refused: false });
    }
  });
});

describe("every tool's result is masked of what the daemon holds itself", () => {
  // `secrets.knownValues()` in the daemon; a stored value too plain to tell from a word is left alone.
  const store = () => ({ github_token: STORED, db_name: "postgres" });
  const agent = fakeAgent({ config: { ...fakeAgent().config, tools: { enabled: ["exec"], approvalRequired: [], blocked: [] } } });
  const toolset = resolveToolset(agent, tools, security, { ownSecrets: () => ({ ...store(), ...ownSecretValues() }) });
  const run = async (text: string) => {
    writeFileSync(join(workspace, "printed.txt"), text);
    return (await toolset.get("exec")!.execute({ command: "cat printed.txt" }, ctx())).content;
  };

  test("the store's values, the control token, and every credential in the credentials directory's files", async () => {
    const out = await run([STORED, CONTROL, ACCESS, REFRESH, CLIENT_SECRET, X_SECRET, `key line: ${KEY_LINE}`].join("\n"));
    for (const value of [STORED, CONTROL, ACCESS, REFRESH, CLIENT_SECRET, X_SECRET, KEY_LINE]) {
      expect({ value: value.slice(0, 8), leaked: out.includes(value) }).toEqual({ value: value.slice(0, 8), leaked: false });
    }
    expect(out).toContain("[REDACTED:github_token]");
    expect(out).toContain("[REDACTED:tokens.json#");
  });

  test("and nothing that only looks like one: Google's sign-in address, a client id, a username, a plain word", async () => {
    const out = await run(`POST ${TOKEN_URI} as ${CLIENT_ID} for nouva_bot on postgres, prefix ${STORED.slice(0, 10)}`);
    expect(out).toBe(`POST ${TOKEN_URI} as ${CLIENT_ID} for nouva_bot on postgres, prefix ${STORED.slice(0, 10)}`);
  });

  test("a file rewritten — an OAuth cache refreshed — is masked as it is now", async () => {
    const fresh = "ya29.a0AfB_byRefreshedTok3n-9876543210";
    writeFileSync(join(credentials, "tokens.json"), oauthCache(fresh));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(credentials, "tokens.json"), later, later);
    expect(await run(`now ${fresh}`)).not.toContain(fresh);
  });
});

test("a plain address under a name for one is not a secret in any credential file — one with a password is", () => {
  const env = join(workspace, ".env");
  const { text } = maskCredentials(env, "AUTH_URL=https://auth.example.com/login\nAUTH_TOKEN_URL=https://u:Pw0rd-123456@auth.example.com/\nAUTH_URL_Q=https://auth.example.com/?token=abc123def456\n");
  expect(text).toContain("AUTH_URL=https://auth.example.com/login");
  expect(text).not.toContain("Pw0rd-123456");
  expect(text).not.toContain("abc123def456");
});

/** The real gate through the real executor, a recorder where the person would be. */
async function underLevel(level: ApprovalLevel, command: string): Promise<{ asked: boolean; ran: boolean }> {
  let asked = false;
  let ran = false;
  const standIn: Tool = { ...exec, execute: async () => ((ran = true), { content: "ran", isError: false }) };
  const toolset = {
    definitions: [exec.definition],
    get: (name: string) => (name === "exec" ? standIn : undefined),
    requiresApproval: () => true,
    parallelSafe: () => false,
    gate: (_name: string, args: Record<string, unknown>, callCtx: ToolContext) => exec.gate!(args, callCtx),
    blockedPatterns: [],
  };
  const approvals = { request: async () => ((asked = true), { status: "approved" as const }) };
  const caller = new ToolCaller({ approvalLevel: () => level, approvals } as unknown as ExecutorDeps);
  const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:nouva", senderId: "u", chatType: "dm", workspaceDir: workspace, workspaceRoots: [workspace], turnId: `turn-${level}-${command.length}` } as unknown as TurnRequest;
  const call: ToolCall = { id: "c1", name: "exec", arguments: { command } };
  await caller.run(req, call, 4_000);
  return { asked, ran };
}
