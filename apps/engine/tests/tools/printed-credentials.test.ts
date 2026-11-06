/**
 * A command that prints credentials (`tools/credential-output.ts`), end to end through the real `exec`: every value a
 * `$TMP_SECRET_…` handle held for the conversation, usable by the next command and never seen.
 *
 * The live case (2026-10-21): `ssh proxmox "pct exec 106 -- cat /root/nougate/.env"` put a database password into the
 * conversation. Here `ssh` is a shell function that prints a fake copy of that file — the command line is the one that
 * ran, and nothing leaves the machine.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransientSecrets } from "@nouride/secrets";
import type { ToolContext } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { OutputCapture } from "@/modules/tools/builtins/exec-output.ts";
import { printedOutput, printedSource } from "@/modules/tools/credential-output.ts";
import { secretScope } from "@/modules/tools/held-secrets.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-printed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = "HarborLight2404";
const DB_URL = `postgres://postgres:${PASSWORD}@192.0.2.10:5432/nougate`;
const KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "-----END OPENSSH PRIVATE KEY-----"];
const STORE_VALUE = "stored-Value-9xW2vB7nM4";
const REMOTE_ENV = [
  "# nougate",
  `DB_URL="${DB_URL}"`,
  "PASSWORD=hunter2",
  "PORT=5432",
  "NODE_ENV=production",
  "export API_TOKEN='abc def'",
  `SAME_AS_STORE=${STORE_VALUE}`,
  ...KEY,
  "",
].join("\n");
/** What the fake `ssh` prints: a file whose own name says nothing, so only the command line can tell what it is. */
const remote = join(dir, "remote-output.txt");
writeFileSync(remote, REMOTE_ENV);
const LIVE = `ssh() { cat '${remote}'; }; ssh proxmox "pct exec 106 -- cat /root/nougate/.env"`;

const where = { gatewayId: "telegram:nouva", chatId: "chat-1" };
const scope = secretScope(where);
const held = new TransientSecrets();
const sentInChat = held.hold("chat-Sent-Zq9xW2vB7", { scope, label: "a password or key", from: "u1" });

const security = { ...DEFAULT_CONFIG.security, exec: { ...DEFAULT_CONFIG.security.exec, mode: "full" as const, ask: "off" as const } };
const base = { security, web: {} as never, sessionStatus: (() => undefined) as never, memory: {} as never };
const tools = createBuiltinTools({ ...base, heldSecrets: held, ownSecrets: () => ({ store_token: STORE_VALUE }) });
const exec = tools.get("exec")!;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "s",
    ...where,
    gateway: "telegram",
    senderId: "u1",
    chatType: "dm",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    turnId: "turn-1",
    signal: new AbortController().signal,
    ...over,
  };
}

const HANDLE = /\$TMP_SECRET_[0-9A-F]{12}/g;
const handleOf = (content: string, key: string): string => new RegExp(`${key}=["']?(\\$TMP_SECRET_[0-9A-F]{12})`).exec(content)?.[1] ?? "";

describe("the live case: a .env printed over ssh", () => {
  let first = "";

  test("every value is a handle, every key and every harmless value stays, and the result says how to use them", async () => {
    const result = await exec.execute({ command: LIVE }, ctx());
    first = result.content;
    expect(first).not.toContain(PASSWORD);
    expect(first).not.toContain("hunter2");
    expect(first).not.toContain("abc def");
    expect(first).not.toContain("BEGIN OPENSSH");
    expect(first).toMatch(/DB_URL="\$TMP_SECRET_[0-9A-F]{12}"/);
    expect(first).toMatch(/PASSWORD=\$TMP_SECRET_[0-9A-F]{12}/);
    expect(first).toMatch(/export API_TOKEN='\$TMP_SECRET_[0-9A-F]{12}'/);
    expect(first).toContain("PORT=5432\nNODE_ENV=production\n");
    expect(first).toContain("# nougate");
    // A value the daemon already holds by name keeps that name, and gains no handle.
    expect(first).toContain("SAME_AS_STORE=[REDACTED:store_token]");
    expect(first).toContain(
      "[4 values from proxmox:/root/nougate/.env are held as $TMP_SECRET_… handles in this conversation for an hour: use them in a command, never print them; ask the person to keep one for good with secret_save. Only this output is masked: nothing the command read, wrote or committed was changed]",
    );
  });

  test("each handle is its own value, labelled with its key and the file it came from", () => {
    const db = handleOf(first, "DB_URL");
    expect(held.get(db, scope)).toMatchObject({ value: DB_URL, label: "DB_URL in proxmox:/root/nougate/.env" });
    expect(held.get(handleOf(first, "PASSWORD"), scope)?.value).toBe("hunter2");
    expect(held.get(handleOf(first, "API_TOKEN"), scope)?.value).toBe("abc def");
    const key = held.heldIn(scope).find((secret) => secret.label === "private key in proxmox:/root/nougate/.env");
    expect(key && held.get(key.handle, scope)?.value).toBe(KEY.join("\n"));
  });

  test("the next command uses one: handed the real value in its environment, and what it prints is masked", async () => {
    const db = handleOf(first, "DB_URL");
    const counted = await exec.execute({ command: `printf '%s' "${db}" | wc -c` }, ctx());
    expect(counted.content.trim()).toBe(String(DB_URL.length));
    const echoed = await exec.execute({ command: `echo "${db}"` }, ctx());
    expect(echoed.content).not.toContain(PASSWORD);
  });

  test("a piece of the URL that carries its password is masked too — the password is held on its own", async () => {
    // A URL is matched only whole, so `${DB_URL%%@*}` — scheme, user and password — matched nothing before.
    const db = handleOf(first, "DB_URL").slice(1);
    const piece = await exec.execute({ command: `v="$${db}"; echo "\${v%%@*}"; echo "only:\${v#*postgres:}"` }, ctx());
    expect(piece.content).toContain("postgres://postgres:");
    expect(piece.content).not.toContain(PASSWORD);
    // Not a second line in the note: it is the same credential.
    expect(held.heldIn(scope).some((secret) => secret.label.endsWith("(its password)"))).toBe(true);
  });

  test("printed again, the same values are the same handles — nothing new is held", async () => {
    const before = held.heldIn(scope).length;
    const again = await exec.execute({ command: LIVE }, ctx());
    expect(again.content.match(HANDLE)?.sort()).toEqual(first.match(HANDLE)?.sort());
    expect(held.heldIn(scope)).toHaveLength(before);
    // The credential sent in chat earlier is still held.
    expect(held.get(sentInChat, scope)).toBeDefined();
  });
});

describe("a file with many variables", () => {
  test("forty-five values are forty-five handles, all kept — none pushes another out", async () => {
    const big = join(dir, "big-output.txt");
    writeFileSync(big, Array.from({ length: 45 }, (_, i) => `VAR_${i}=value-${i}-x9Q`).join("\n") + "\n");
    const many = new TransientSecrets();
    const tool = createBuiltinTools({ ...base, heldSecrets: many }).get("exec")!;
    const result = await tool.execute({ command: `cat '${big}' # what /srv/app/.env.production holds` }, ctx());
    const handles = result.content.match(HANDLE) ?? [];
    expect(new Set(handles).size).toBe(45);
    expect(many.heldIn(scope)).toHaveLength(45);
    expect(handles.map((handle) => many.get(handle, scope)?.value)).toEqual(Array.from({ length: 45 }, (_, i) => `value-${i}-x9Q`));
    expect(many.heldIn(scope)[0]?.label).toBe("VAR_0 in /srv/app/.env.production");
  });
});

describe("other things that print credentials", () => {
  const run = async (command: string, file: string, over: Partial<ToolContext> = {}) => {
    const path = join(dir, `${file}.txt`);
    return { path, run: (text: string) => (writeFileSync(path, text), exec.execute({ command: command.replaceAll("FILE", path) }, ctx(over))) };
  };

  test("`printenv` on another host", async () => {
    const { run: go } = await run(`ssh() { cat 'FILE'; }; ssh box printenv`, "printenv");
    const result = await go("HOME=/root\nSHLVL=1\nAPI_KEY=k-123456\n");
    expect(result.content).toMatch(/^HOME=\/root\nSHLVL=1\nAPI_KEY=\$TMP_SECRET_[0-9A-F]{12}\n/);
    expect(held.get(handleOf(result.content, "API_KEY"), scope)?.label).toBe("API_KEY from printenv on box");
  });

  test("`kubectl get secret -o yaml`: what the Secret holds, and nothing else", async () => {
    const { run: go } = await run(`kubectl() { cat 'FILE'; }; kubectl get secret db -o yaml`, "kube");
    const result = await go("apiVersion: v1\ndata:\n  password: aHVudGVyMg==\nkind: Secret\nmetadata:\n  name: db\n");
    expect(result.content).toMatch(/ {2}password: \$TMP_SECRET_[0-9A-F]{12}\nkind: Secret\nmetadata:\n {2}name: db/);
    expect(result.content).not.toContain("aHVudGVyMg==");
  });

  test("`.env.example` keeps its placeholders — only a secret's shape goes", async () => {
    const { run: go } = await run(`cat 'FILE' # .env.example`, "example");
    const result = await go("API_KEY=your-key-here\nDB_URL=postgres://app:pass2024x@db:5432/app\n");
    expect(result.content).toContain("API_KEY=your-key-here\n");
    expect(result.content).toMatch(/DB_URL=postgres:\/\/app:\$TMP_SECRET_[0-9A-F]{12}@db:5432\/app/);
  });

  test("a pattern that names a credential file is not one: a commit message stays as it was written", async () => {
    // Live (2026-10-23): a check before a commit, `grep -iE 'credential|\.env|\.key|token'`, was split at its `|` and
    // `\.key` taken for a private key, so every `key: value` line it printed was masked — `git log`'s "feat: …" became
    // "feat: $TMP_SECRET_…", and the agent rewrote and force-pushed a commit that was never wrong.
    const result = await exec.execute({ command: "printf 'feat: friendly tone for nouva\n' | grep -iE 'credential|\\.env|\\.key|feat'" }, ctx());
    expect(result.content).toBe("feat: friendly tone for nouva");
  });

  test("a command that names no such thing is left exactly as it printed", async () => {
    const result = await exec.execute({ command: "printf 'PASSWORD=swordfish-42\\nPORT=5432\\n'" }, ctx());
    expect(result.content).toBe("PASSWORD=swordfish-42\nPORT=5432");
  });

  test("no conversation to hold a handle in: masked by key instead — never left", async () => {
    const masked = createBuiltinTools(base).get("exec")!;
    const result = await masked.execute({ command: LIVE }, ctx());
    expect(result.content).toContain('DB_URL="[REDACTED:DB_URL]"');
    expect(result.content).toContain("PASSWORD=[REDACTED:PASSWORD]");
    expect(result.content).not.toContain(PASSWORD);
    expect(result.content).toContain("[5 values from proxmox:/root/nougate/.env were masked: this run has no conversation to hold them in. Only this output is masked: nothing the command read, wrote or committed was changed]");
  });

  test("a background one: its log goes through the same swap before the exact masking", async () => {
    let filter: (() => { push(text: string): string; end(): string }) | undefined;
    const background = createBuiltinTools({ ...base, heldSecrets: held, startJob: (job) => ((filter = job.filter), { id: "job_1", logPath: "/dev/null" }) }).get("exec")!;
    await background.execute({ command: `sleep 1; ${LIVE}`, background: true }, ctx());
    const stream = filter!();
    const logged = stream.push(REMOTE_ENV) + stream.end();
    expect(logged).not.toContain(PASSWORD);
    expect(logged).toMatch(/DB_URL="\$TMP_SECRET_[0-9A-F]{12}"/);
  });
});

describe("the interactive session", () => {
  test("given a line that prints a credential file, what it prints from then on is handles", async () => {
    const session = tools.get("session")!;
    const started = await session.execute({ action: "start", command: "sh" }, ctx());
    const id = /Session (\S+) started/.exec(started.content)![1]!;
    const secret = join(dir, ".env");
    writeFileSync(secret, `TOKEN=tok-Zq9xW2vB7nM4\n`);
    const shown = await session.execute({ action: "send", id, input: `cat '${secret}'` }, ctx());
    await session.execute({ action: "close", id }, ctx());
    expect(shown.content).not.toContain("tok-Zq9xW2vB7nM4");
    expect(shown.content).toMatch(/TOKEN=\$TMP_SECRET_[0-9A-F]{12}/);
    expect(shown.content).toContain("held as $TMP_SECRET_… handles");
  });
});

describe("the spill file", () => {
  test("output too big to hold goes to disk with the handles in it, never the values", () => {
    const spoolPath = join(dir, "spool.log");
    const printed = printedOutput({ kind: "file", name: ".env" }, { held, ctx: ctx(), known: {} });
    const capture = new OutputCapture({ spoolPath, env: {}, diskCapChars: 1_000_000, memoryChars: 16, excerptChars: 64, printed: printed.filter });
    for (const line of REMOTE_ENV.split("\n")) capture.push("stdout", `${line}\n`);
    capture.push("stdout", "x".repeat(2000));
    const captured = capture.finish();
    expect(captured.spooled).toBe(true);
    const onDisk = readFileSync(spoolPath, "utf8");
    expect(onDisk).not.toContain(PASSWORD);
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).toMatch(/DB_URL="\$TMP_SECRET_[0-9A-F]{12}"/);
  });
});

describe("printedSource: what a command line prints, by its words", () => {
  test("a credential file — here, over ssh, in a container, behind sudo or a shell", () => {
    for (const [command, name] of [
      [`ssh proxmox "pct exec 106 -- cat /root/nougate/.env"`, "/root/nougate/.env"],
      ["docker exec api cat /app/.env.production", "/app/.env.production"],
      ["kubectl exec deploy/api -- cat /etc/app/credentials", "/etc/app/credentials"],
      ["bash -c 'cat ~/.npmrc'", "~/.npmrc"],
      ["sudo cat /root/.pgpass", "/root/.pgpass"],
      ["cat secrets.env", "secrets.env"],
      ["cat ~/.ssh/id_ed25519", "~/.ssh/id_ed25519"],
      ["openssl pkcs12 -in cert.p12", "cert.p12"],
      ["cat ~/.netrc", "~/.netrc"],
    ] as const) {
      expect(printedSource(["sh", "-c", command])).toMatchObject({ kind: "file", name });
    }
    expect(printedSource(["sh", "-c", `ssh -p 2222 -i key admin@proxmox "cat /root/.env"`])).toEqual({ kind: "file", name: "/root/.env", host: "proxmox" });
  });

  test("an environment, a container's, a Secret", () => {
    expect(printedSource(["sh", "-c", "printenv"])?.kind).toBe("env");
    expect(printedSource(["sh", "-c", "docker exec api env"])?.kind).toBe("env");
    expect(printedSource(["sh", "-c", "printenv DB_URL | head"])?.kind).toBe("env");
    expect(printedSource(["sh", "-c", "docker inspect api"])?.kind).toBe("docker-inspect");
    expect(printedSource(["sh", "-c", "kubectl get secret db -o yaml"])?.kind).toBe("kube-secret");
    expect(printedSource(["sh", "-c", "kubectl -n prod get secrets --output=json"])?.kind).toBe("kube-secret");
    expect(printedSource(["sh", "-c", "cat .env.example"])).toEqual({ kind: "template", name: ".env.example" });
  });

  test("a heredoc written to a file is the file's text, not a path — one run as a script keeps its words", () => {
    // Live (0.8.12, document-authoring): Nouva wrote a flyer's LaTeX with `cat << 'EOF' > flyer.tex`, its text said
    // "memory, credentials, transcripts", and `credentials` was taken for a credential file — every `note: …` and
    // `warning: …` line tectonic printed came back a `$TMP_SECRET_…` handle, and the build log could not be read.
    const flyer = "cat << 'EOF' > /tmp/flyer.tex\n\\section{Private} Durable memory, credentials, transcripts stay here.\nEOF\ntectonic -X compile /tmp/flyer.tex";
    expect(printedSource(["sh", "-lc", flyer])).toBeNull();
    expect(printedSource(["sh", "-lc", "cat <<EOF >notes.md\nrotate the credentials and the .env\nEOF\ncat notes.md | wc -l"])).toBeNull();
    expect(printedSource(["sh", "-lc", "tee -a log.txt <<'X'\nprintenv was here\nX"])).toBeNull();
    // A file a heredoc writes is still named by the command; a heredoc a shell runs is still a script that reads one.
    expect(printedSource(["sh", "-lc", "cat > ~/.aws/credentials <<EOF\n[default]\nEOF\ncat ~/.aws/credentials"])).toMatchObject({ kind: "file", name: "~/.aws/credentials" });
    expect(printedSource(["sh", "-lc", "bash <<'EOF'\ncat /root/.env\nEOF"])).toMatchObject({ kind: "file", name: "/root/.env" });
    expect(printedSource(["sh", "-lc", "cat <<'EOF' | sh\nprintenv\nEOF"])?.kind).toBe("env");
  });

  test("and not what only looks like one", () => {
    for (const command of ["cat README.md", "node -e 'console.log(process.env.HOME)'", "env FOO=1 node app.js", "cat ~/.ssh/id_rsa.pub", "kubectl get secret db -o jsonpath='{.data}'", "kubectl get pods -o yaml", "git status",
      // A pattern, not a path: a regex escape names no file (2026-10-23).
      "git status --short | grep -iE 'credential|\\.env|\\.key|token'", "grep -rE '\\.pem$' .", "rg '\\.env\\.example' docs"]) {
      expect(printedSource(["sh", "-c", command])).toBeNull();
    }
  });
});
