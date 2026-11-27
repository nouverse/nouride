/**
 * A coding-CLI account signed in once on the Models page, for a CLI whose sign-in is files (every built-in but Claude
 * Code): what its sign-in wrote in the account's own HOME is written into each agent's folder as its CLI starts, and
 * what the CLI changed there (a refreshed token) is copied back after its turn. Run for real, with `sh` as this user,
 * which is how a command "as the agent" runs where agents are not their own users.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_CLIS } from "@nouride/acp";
import { AccountSignIns, signInFiles, signInRoot } from "@/modules/external-agents/account-sign-in.ts";

const of = (id: string) => BUILT_IN_CLIS.find((row) => row.id === id)!;
const CODEX = of("codex");
const ANTIGRAVITY = of("antigravity");
/** One whose sign-in's files are not known (Grok Build's): what its sign-in wrote, but what it keeps of its work. */
const GROK = of("grok");

let dir: string;
let signIns: AccountSignIns;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nr-account-sign-in-"));
  signIns = new AccountSignIns({ dir: () => join(dir, "accounts") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A file the account's sign-in wrote, under its HOME. */
function signed(row: typeof CODEX, account: string, path: string, text: string): void {
  const to = join(signInRoot(row, signIns.home(row.id, account)), path);
  mkdirSync(join(to, ".."), { recursive: true });
  writeFileSync(to, text);
}

describe("what an account's sign-in is", () => {
  test("the files its row names, under its profile folder where it has one, else its HOME: not what it wrote beside them", () => {
    // What Antigravity's sign-in wrote on the live box: the token and which sign-in it is, its log (naming the Google
    // account), and its conversations' database, which handed to every agent on the account would mix theirs.
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/antigravity-oauth-token", "g");
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/cache/acp-auth-state.json", "{}");
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/cache/onboarding.json", "{}");
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/conversation_summaries.db", "db");
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/log/acp-login.log", "someone@example.test");
    expect(signIns.files(ANTIGRAVITY, "gading").map((file) => file.path)).toEqual([".gemini/antigravity-cli/antigravity-oauth-token", ".gemini/antigravity-cli/cache/acp-auth-state.json"]);
    signed(CODEX, "work", "auth.json", '{"tokens":"a"}');
    signed(CODEX, "work", "installation_id", "i");
    expect(signIns.files(CODEX, "work").map((file) => file.path)).toEqual(["auth.json"]);
    expect([signIns.signedIn(CODEX, "work"), signIns.signedIn(CODEX, "home")]).toEqual([true, false]);
  });

  test("where its row names none: every file but its work, a starting file the agent keeps its own of, or one too large", () => {
    signed(GROK, "x", "auth.json", "a");
    signed(GROK, "x", "settings/account.json", "b");
    signed(GROK, "x", "sessions/one.json", "a conversation");
    signed(GROK, "x", "history.jsonl", "what was said");
    signed(GROK, "x", "state.db", "db");
    signed(GROK, "x", "logs/grok.log", "log");
    signed(GROK, "x", "big.json", "x".repeat(70 * 1024));
    expect(signInFiles(GROK, signInRoot(GROK, signIns.home("grok", "x"))).map((file) => file.path)).toEqual(["auth.json", "settings/account.json"]);
    signed(CODEX, "work", "config.toml", "check_for_update_on_startup = true");
    expect(signInFiles({ ...CODEX, signInFiles: undefined }, signInRoot(CODEX, signIns.home("codex", "work"))).map((file) => file.path)).toEqual([]);
  });

  test("its stamp changes with what it holds, and is empty where it holds nothing", () => {
    expect(signIns.stamp(CODEX, "work")).toBe("");
    signed(CODEX, "work", "auth.json", "a");
    const first = signIns.stamp(CODEX, "work");
    signed(CODEX, "work", "auth.json", "b");
    expect(signIns.stamp(CODEX, "work")).not.toBe(first);
    expect(first).not.toBe("");
  });
});

describe("into an agent's folder and back", () => {
  test("written into the agent's folder, over what was there, each file private to it", async () => {
    signed(ANTIGRAVITY, "gading", ".gemini/antigravity-cli/antigravity-oauth-token", "from the account");
    const agentHome = join(dir, "agent");
    mkdirSync(join(agentHome, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(agentHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "its own, older");
    expect(await signIns.copyIn(ANTIGRAVITY, "gading", "ag", agentHome)).toEqual([".gemini/antigravity-cli/antigravity-oauth-token"]);
    const written = join(agentHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    expect(readFileSync(written, "utf8")).toBe("from the account");
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(existsSync(`${written}.nouride-in`)).toBe(false);
  });

  test("an account not signed in here writes nothing: the agent's own sign-in stays", async () => {
    const agentHome = join(dir, "agent");
    expect(await signIns.copyIn(CODEX, "work", "kuro", agentHome)).toEqual([]);
    expect(existsSync(agentHome)).toBe(false);
  });

  test("what the agent's CLI changed comes back to the account; what it did not, and what it removed, do not", async () => {
    signed(GROK, "x", "auth.json", "token one");
    signed(GROK, "x", "installation_id", "same");
    const profile = join(dir, "kuro-profile");
    const paths = await signIns.copyIn(GROK, "x", "kuro", profile);
    expect(paths).toEqual(["auth.json", "installation_id"]);
    expect(await signIns.copyBack(GROK, "x", "kuro", profile, paths)).toEqual([]);

    // The CLI refreshed its token, and something removed the other file.
    writeFileSync(join(profile, "auth.json"), "token two, refreshed");
    rmSync(join(profile, "installation_id"));
    expect(await signIns.copyBack(GROK, "x", "kuro", profile, paths)).toEqual(["auth.json"]);
    const account = signInRoot(GROK, signIns.home("grok", "x"));
    expect(readFileSync(join(account, "auth.json"), "utf8")).toBe("token two, refreshed");
    expect(readFileSync(join(account, "installation_id"), "utf8")).toBe("same");

    // And the next agent to start on it takes the newest.
    const nox = join(dir, "nox-profile");
    await signIns.copyIn(GROK, "x", "nox", nox);
    expect(readFileSync(join(nox, "auth.json"), "utf8")).toBe("token two, refreshed");
  });

  test("only the files it copied in are read back: another file of the agent's never reaches the account", async () => {
    signed(CODEX, "work", "auth.json", "a");
    const profile = join(dir, "kuro-profile");
    await signIns.copyIn(CODEX, "work", "kuro", profile);
    writeFileSync(join(profile, "history.jsonl"), "the agent's own");
    expect(await signIns.copyBack(CODEX, "work", "kuro", profile, ["auth.json"])).toEqual([]);
    expect(existsSync(join(signInRoot(CODEX, signIns.home("codex", "work")), "history.jsonl"))).toBe(false);
  });

  test("forgotten with the account", () => {
    signed(CODEX, "work", "auth.json", "a");
    signIns.forget("codex", "work");
    expect(signIns.signedIn(CODEX, "work")).toBe(false);
  });
});
