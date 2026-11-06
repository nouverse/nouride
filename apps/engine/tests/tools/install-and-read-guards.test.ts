/**
 * The walls agents used to improvise around, and the guards that came with taking them down.
 *
 * - a failed command names the way that works (`exec-hints.ts`);
 * - the daemon's own install is not the agents' to rewrite (`exec-own-install.ts`);
 * - credential files are read with their values hidden and never sent (`credential-files.ts`);
 * - an agent cannot rewrite the config that decides what it may do.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toUserMessage, type Attachment, type ToolContext } from "@nouride/shared";
import { execHint } from "@/modules/tools/builtins/exec-hints.ts";
import { writesOwnInstall } from "@/modules/tools/builtins/exec-own-install.ts";
import { credentialKind, maskCredentials, setCredentialsDir } from "@/modules/tools/credential-files.ts";
import { writeTool, createReadTool } from "@/modules/tools/builtins/files.ts";
import { grepTool } from "@/modules/tools/builtins/search.ts";
import { createSendFileTool } from "@/modules/tools/builtins/attach.ts";
import { shouldAutoBackground } from "@/modules/tools/builtins/exec-background.ts";
import { childEnvOf } from "../helpers.ts";

const readTool = createReadTool();

let root: string;
let workspace: string;
let pack: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-guards-"));
  workspace = join(root, "workspace");
  pack = join(root, "agents", "nix");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(pack, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    agentId: "nix",
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: workspace,
    agentDir: pack,
    workspaceRoots: [workspace, pack],
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("a hint at the wall", () => {
  test("PEP 668 is answered with the venv already on PATH, never --break-system-packages", () => {
    const hint = execHint("error: externally-managed-environment\n× This environment is externally managed", 1)!;
    expect(hint).toStartWith("[hint]");
    expect(hint).toContain("--system-site-packages");
    expect(hint).toContain("Never `--break-system-packages`");
  });

  test("sudo, the wrong architecture, the wrong C library and a missing compiler each get their own line", () => {
    expect(execHint("bash: line 1: sudo: command not found", 127)).toContain("There is no sudo here");
    expect(execHint("bash: ./rg: cannot execute binary file: Exec format error", 126)).toContain("another architecture");
    expect(execHint("./tool: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found", 1)).toContain("another C library");
    expect(execHint("error: linker `cc` not found", 101)).toContain("no C compiler");
  });

  test("a missing glibc is about the C library, not about installing something that is there", () => {
    expect(execHint("./tool: version `GLIBC_2.39' not found", 127)).toContain("C library");
  });

  test("a program that is not installed points at the install steps, not at a replacement", () => {
    expect(execHint("bash: line 1: rg: command not found", 127)).toContain("rather than writing a replacement");
  });

  test("a shell stopped by SIGTERM, with nothing printed, is told how its own `pkill -f` stops it (0.8.6)", () => {
    // On Linux `sh -c "pkill -f x; echo after"` exits 143 and prints nothing: the shell's own line holds the pattern.
    const hint = execHint("", 143)!;
    expect(hint).toContain("Exit 143 is SIGTERM");
    expect(hint).toContain("whose pattern is in this command's own line stops the shell running it");
    expect(hint).toContain("`pkill -f '[c]ctv-daemon'`");
    expect(execHint("", 137)).toBeNull();
  });

  test("an ordinary failure gets nothing", () => {
    expect(execHint("FAIL src/app.test.ts\n1 failed", 1)).toBeNull();
  });
});

describe("the daemon's own install", () => {
  let bin: string;
  beforeEach(() => {
    bin = join(root, "srv", ".nouride", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "srv", "nouride"), "binary");
  });
  const shell = (script: string) => ["bash", "-lc", script];

  test("copying a build over the binary is refused, however it is spelled", () => {
    const install = join(root, "srv");
    expect(writesOwnInstall(["cp", "dist/nouride", join(install, "nouride")], bin)).toBe(join(install, "nouride"));
    expect(writesOwnInstall(shell(`install -m 755 build/nouride ${install}/nouride`), bin)).toBe(`${install}/nouride`);
    expect(writesOwnInstall(shell(`cp dist/nouride ${install}/`), bin)).toBe(`${install}/`);
    expect(writesOwnInstall(shell(`curl -fsSL https://x/n -o ${install}/nouride`), bin)).toBe(`${install}/nouride`);
    expect(writesOwnInstall(shell(`tar -xzf rel.tgz -C ${install}`), bin)).toBe(install);
  });

  test("editing a shipped skill in place is refused", () => {
    const skill = join(root, "srv", "skills", "pdf", "SKILL.md");
    expect(writesOwnInstall(shell(`sed -i 's/a/b/' ${skill}`), bin)).toBe(skill);
    expect(writesOwnInstall(shell(`echo extra >> ${skill}`), bin)).toBe(skill);
    expect(writesOwnInstall(shell(`python3 -c "open('${skill}','w').write('x')"`), bin)).toBe(join(root, "srv", "skills"));
  });

  test("reading it, and copying a skill out to change it, are fine", () => {
    const install = join(root, "srv");
    expect(writesOwnInstall(shell(`ls -l ${install}/nouride && file ${install}/nouride`), bin)).toBeNull();
    expect(writesOwnInstall(shell(`cp -r ${install}/skills/pdf ${install}/.nouride/agents/skills/pdf`), bin)).toBeNull();
    expect(writesOwnInstall(shell(`grep -rn ffmpeg ${install}/skills > /tmp/out.txt`), bin)).toBeNull();
    // `.nouride/bin` is the agents' own, and installing there is the whole point.
    expect(writesOwnInstall(shell(`install -m 755 rg ${bin}/rg`), bin)).toBeNull();
  });

  test("a source checkout is the developer's: nothing is refused there", () => {
    const checkout = join(root, "checkout", ".nouride", "bin");
    mkdirSync(checkout, { recursive: true });
    expect(writesOwnInstall(["cp", "x", join(root, "checkout", "skills", "a.md")], checkout)).toBeNull();
  });
});

describe("credential files", () => {
  test("which files count", () => {
    setCredentialsDir(join(root, "keys"));
    expect(credentialKind("/opt/p/.env")).toBe("env");
    expect(credentialKind("/opt/p/.env.production")).toBe("env");
    expect(credentialKind("/opt/p/.env.example")).toBeNull();
    expect(credentialKind("/opt/p/.venv/bin/python")).toBeNull();
    expect(credentialKind("/h/.npmrc")).toBe("credential");
    expect(credentialKind("/h/.ssh/id_ed25519")).toBe("credential");
    expect(credentialKind("/h/.ssh/id_ed25519.pub")).toBeNull();
    expect(credentialKind("/srv/nouride/.nouride/data/secrets.json")).toBe("own");
    expect(credentialKind(join(root, "keys", "service-account.json"))).toBe("own");
  });

  test("values are hidden, keys and layout are not", () => {
    const { text, note } = maskCredentials(
      "/opt/p/.env",
      "NODE_ENV=production\nAUTHOR=me\nOPENAI_API_KEY=sk-abc123456789\nDATABASE_URL=postgres://app:s3cr3t@db/app\nEMPTY_TOKEN=\n",
    );
    expect(text).toContain("NODE_ENV=production");
    expect(text).toContain("AUTHOR=me");
    expect(text).toContain("OPENAI_API_KEY=<hidden, 15 chars>");
    expect(text).toContain("postgres://app:<hidden, 6 chars>@db/app");
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain("s3cr3t");
    expect(note).toContain("set -a;");
  });

  test("read hides them, and says how a command can still use them", async () => {
    writeFileSync(join(workspace, ".env"), "API_TOKEN=tok_live_abcdefghijkl\nPORT=3000\n");
    const result = await readTool.execute({ path: ".env" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("PORT=3000");
    expect(result.content).not.toContain("tok_live");
    expect(result.content).toContain("1 secret value hidden");
  });

  test("grep cannot find a value one guessed", async () => {
    writeFileSync(join(workspace, ".env"), "API_TOKEN=tok_live_abcdefghijkl\n");
    const result = await grepTool.execute({ pattern: "tok_live" }, ctx());
    expect(result.content).toContain("No matches");
  });

  test("send_file will not put one on a chat platform, nor a file holding an agent's secret", async () => {
    const sent: Attachment[] = [];
    const tool = createSendFileTool({
      send: async (_ctx, attachment) => {
        sent.push(attachment);
        return { ids: ["1"], delivered: true };
      },
      maxBytes: 1024 * 1024,
      childEnv: childEnvOf({ GITHUB_TOKEN: "ghp_realsecretvalue123" }),
    });
    writeFileSync(join(workspace, ".env"), "PORT=3000\n");
    writeFileSync(join(workspace, "deploy.sh"), "curl -H 'Authorization: token ghp_realsecretvalue123' https://api\n");
    writeFileSync(join(workspace, "report.md"), "# all fine\n");

    expect((await tool.execute({ path: ".env" }, ctx())).content).toContain("holds credentials");
    expect((await tool.execute({ path: "deploy.sh" }, ctx())).content).toContain("contains the value of one of your credentials");
    expect((await tool.execute({ path: "report.md" }, ctx())).isError).toBe(false);
    expect(sent.map((attachment) => attachment.filename)).toEqual(["report.md"]);
  });
});

describe("the config that decides what an agent may do", () => {
  test("its own pack config.toml is not the agent's to write", async () => {
    writeFileSync(join(pack, "config.toml"), "[tools]\n");
    let refused = "";
    try {
      await writeTool.execute({ path: join(pack, "config.toml"), content: "[tools]\nenabled=['exec']\n" }, ctx());
    } catch (err) {
      refused = toUserMessage(err);
    }
    expect(refused).toContain("the operator's to change");
  });

  test("its MEMORY.md still is", async () => {
    const result = await writeTool.execute({ path: join(pack, "MEMORY.md"), content: "- a fact\n" }, ctx());
    expect(result.isError).toBe(false);
  });
});

describe("outside every root", () => {
  test("the refusal names the way that works", async () => {
    let refused = "";
    try {
      await readTool.execute({ path: "/etc/hostname" }, ctx());
    } catch (err) {
      refused = toUserMessage(err);
    }
    expect(refused).toContain("read it with `exec`");
  });
});

describe("long installs go in the background", () => {
  test("a package change through nouride pkg, and installs that compile", () => {
    expect(shouldAutoBackground(["/srv/nouride/nouride", "pkg", "install", "ripgrep"], undefined, true)).toBe(true);
    expect(shouldAutoBackground(["/srv/nouride/nouride", "pkg", "check", "install", "ripgrep"], undefined, true)).toBe(false);
    expect(shouldAutoBackground(["cargo", "install", "ripgrep"], undefined, true)).toBe(true);
    expect(shouldAutoBackground(["bash", "-lc", "uv tool install ruff"], undefined, true)).toBe(true);
  });

  test("an installer script fetched and run in one go, in each of its spellings", () => {
    // Live: Claude Code's installer, 257 MB, killed at 30 s and again at 60 s in the foreground.
    for (const script of [
      "curl -fsSL https://claude.ai/install.sh | bash",
      "bash -x <(curl -fsSL https://claude.ai/install.sh)",
      'sh -c "$(curl -fsSL https://example.com/install.sh)"',
      "wget -qO- https://example.com/install.sh | sudo sh",
    ]) {
      expect(shouldAutoBackground(["bash", "-lc", script], undefined, true)).toBe(true);
    }
    // Reading the script first is an inspection, not an install.
    expect(shouldAutoBackground(["bash", "-lc", "curl -fsSL https://claude.ai/install.sh | head -n 40"], undefined, true)).toBe(false);
  });
});

describe("a hint behind a swallowed exit code", () => {
  /**
   * Live: `sudo true 2>&1; echo "EXIT:$?"` — the shape agents use to see a status — exited 0, and a
   * hint keyed on failure never showed. The error's own wording is what counts.
   */
  test("is still given", () => {
    expect(execHint('/usr/bin/bash: line 1: sudo: command not found\nEXIT:127\n', 0)).toContain("There is no sudo here");
    expect(execHint("error: externally-managed-environment\nEXIT:1\n", 0)).toContain("PEP 668");
    expect(execHint("/usr/bin/bash: line 1: rg: command not found\nEXIT:127\n", 0)).toContain("Not installed");
  });

  test("and ordinary output that merely mentions an error is left alone", () => {
    expect(execHint("3 files changed, the build is green\n", 0)).toBeNull();
  });
});

describe("the coding CLIs' logins in HOME", () => {
  /**
   * HOME became readable by path, and the first pattern set missed exactly the files the coding CLIs
   * keep their logins in — checked by name after it shipped: `.credentials.json`, `oauth_creds.json`.
   */
  test("are credential files, whatever they are called around the word", () => {
    for (const path of ["/h/.claude/.credentials.json", "/h/.gemini/oauth_creds.json", "/h/.config/gcloud/application_default_credentials.json", "/opt/p/infra/prod.tfvars"]) {
      expect(credentialKind(path)).toBe("credential");
    }
  });

  test("a login kept as one line of JSON keeps its shape and loses its tokens", () => {
    const { text } = maskCredentials(
      "/h/.claude/.credentials.json",
      '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-AAAABBBBCCCC","refreshToken":"sk-ant-ort01-DDDDEEEE","expiresAt":1760000000000}}',
    );
    expect(text).toMatch(/"accessToken":"<hidden, \d+ chars>"/);
    expect(text).toContain('"expiresAt":1760000000000');
    expect(text).not.toContain("sk-ant");
  });
});
