/**
 * A follower sent to the background is refused unless the call says it is a service.
 *
 * In the background a `tail -f` never ends: it holds a job slot, its log never goes quiet for the watchdog, and an update
 * waits on it for as long as it runs. Through the tool, with the job store's spawn faked, because what matters is that
 * nothing is started — and that a build whose `-f` names a file still is.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@nouride/shared";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { followerIn } from "@/modules/tools/builtins/exec-follow.ts";

describe("what follows for ever", () => {
  test("a log followed, by program — and through a wrapper or inside a script", () => {
    expect(followerIn(["tail", "-f", "/var/log/syslog"])).toBe("`tail -f`");
    expect(followerIn(["tail", "-fn", "100", "app.log"])).toBe("`tail -f`");
    expect(followerIn(["tail", "--follow=name", "app.log"])).toBe("`tail -f`");
    expect(followerIn(["sudo", "journalctl", "-fu", "nginx"])).toBe("`journalctl -f`");
    expect(followerIn(["bash", "-lc", "docker compose logs -f api | grep ERROR"])).toBe("`docker logs -f`");
    expect(followerIn(["kubectl", "logs", "--follow", "pod/web"])).toBe("`kubectl logs -f`");
    expect(followerIn(["/opt/nouride/nouride", "logs", "-f"])).toBe("`nouride logs -f`");
    expect(followerIn(["bash", "-lc", "cd /srv && watch -n 5 df -h"])).toBe("`watch`");
  });

  test("a flag that only looks like following, a snapshot, and a bounded follow are not", () => {
    expect(followerIn(["docker", "build", "-f", "Dockerfile", "."])).toBeNull();
    expect(followerIn(["make", "-f", "Makefile", "all"])).toBeNull();
    expect(followerIn(["tar", "-xzf", "a.tgz"])).toBeNull();
    expect(followerIn(["tail", "-n", "100", "app.log"])).toBeNull();
    expect(followerIn(["docker", "logs", "--tail", "100", "api"])).toBeNull();
    expect(followerIn(["kubectl", "logs", "--follow=false", "pod/web"])).toBeNull();
    expect(followerIn(["bash", "-lc", "npm run watch"])).toBeNull();
    expect(followerIn(["timeout", "60", "tail", "-f", "app.log"])).toBeNull();
  });
});

describe("in the background", () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-follow-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ctx: ToolContext = {
    agentId: "nouva",
    sessionId: "ses_1",
    chatId: "chat-1",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "dev",
    chatType: "dm",
    workspaceDir: dir,
    agentDir: dir,
    workspaceRoots: [dir],
    signal: new AbortController().signal,
  };

  function tool() {
    const started: string[][] = [];
    const turns: (string | undefined)[] = [];
    const exec = createExecTool({
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024,
      blocked: [],
      policy: { mode: "full", ask: "off", askFallback: "deny", sensitivePaths: "ask", allowlist: [], blocked: [] },
      startJob: (job: { argv: string[]; ctx: { turnId?: string } }) => {
        started.push(job.argv);
        turns.push(job.ctx.turnId);
        return { id: "job_1", logPath: "/dev/null" };
      },
    } as Parameters<typeof createExecTool>[0]);
    return { exec, started, turns };
  }

  test("asked for, it is refused with what to run instead — and nothing is started", async () => {
    const t = tool();
    const result = await t.exec.execute({ command: "tail -f /var/log/syslog", background: true }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("`tail -f` follows and never exits on its own");
    expect(result.content).toContain("`tail -n 100`");
    expect(result.content).toContain("`service: true`");
    expect(t.started).toEqual([]);
  });

  test("sent there by a long timeout, the same", async () => {
    const t = tool();
    const result = await t.exec.execute({ command: ["journalctl", "-u", "nouride", "-f"], timeout_ms: 600_000 }, ctx);
    expect(result.isError).toBe(true);
    expect(t.started).toEqual([]);
  });

  test("a job keeps the turn that started it — an asked agent's, the asking turn (nouride-releases#10)", async () => {
    const t = tool();
    await t.exec.execute({ command: ["docker", "build", "."], background: true }, { ...ctx, agentId: "nox", turnId: "turn_nouva" });
    expect(t.turns).toEqual(["turn_nouva"]);
  });

  test("a service it may be, when the call says so", async () => {
    const t = tool();
    const result = await t.exec.execute({ command: "tail -F /var/log/app.log", background: true, service: true }, ctx);
    expect(result.isError).toBeFalsy();
    expect(t.started).toHaveLength(1);
  });

  test("a build whose `-f` names its file still goes to the background", async () => {
    const t = tool();
    const result = await t.exec.execute({ command: ["docker", "build", "-f", "Dockerfile", "."], background: true }, ctx);
    expect(result.isError).toBeFalsy();
    expect(t.started).toHaveLength(1);
  });
});
