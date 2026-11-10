/**
 * `nouride setup` refuses to run against an install that already exists.
 *
 * It writes a provider profile and scaffolds an agent pack. Run a second time it would look like a
 * no-op — the output is the same either way — while having replaced the default agent and pointed the
 * provider profile somewhere else. The failure is not that it errors; it is that it does not.
 *
 * The happy path is exercised end-to-end elsewhere: a real run against a local endpoint produced
 * `.nouride/` with the secret's *name* in `config.toml` and the value in a `0600` `secrets.json`, and
 * the daemon then booted from it. What is worth pinning here is the guard, because it is the one
 * behaviour whose absence destroys something.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFile, readTextFileIfExists, serveHttp, writeTextFileAtomic } from "@nouride/runtime";
import { MuteableOutput } from "@nouride/runtime";
import { setup } from "@/cli/setup.ts";
import { restartHint } from "@/service/hints.ts";

let root: string;
let cwd: string;

beforeEach(() => {
  root = join(tmpdir(), `nouride-clisetup-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(root, { recursive: true });
  cwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("nouride setup", () => {
  test("refuses when the install already has a config, and changes nothing", async () => {
    const configPath = join(root, ".nouride", "config.toml");
    const original = '[providers.mine]\nkind = "anthropic"\n';
    await writeTextFileAtomic(configPath, original);

    await setup(["--yes", "--provider", "openai"]);

    expect(process.exitCode).toBe(1);
    // The file is the assertion, not the exit code alone: a guard that reports failure after writing
    // is not a guard.
    expect(await readTextFile(configPath)).toBe(original);
  });

  test("an unattended run with no key fails instead of prompting", async () => {
    // Piped into a provisioning script there is no terminal to answer, and the previous shape of this
    // — prompt anyway — hangs until the job times out, which reads as a network problem.
    await setup(["--yes", "--provider", "openai", "--base-url", "http://127.0.0.1:1"]);

    expect(process.exitCode).toBe(1);
  });

  test("it rejects a provider it does not speak", async () => {
    await setup(["--yes", "--provider", "gemini"]);

    expect(process.exitCode).toBe(1);
  });

  test("it produces the same pack the dashboard wizard would", async () => {
    /**
     * Both paths call one `SetupService`, so the *artifacts* cannot drift — what can is which fields
     * each one collects. The CLI shipped without asking for the persona or the operator's name, so an
     * install made from a terminal got a generic `SOUL.md` and no `USER.md`: the same code, a
     * different agent. This asserts every wizard field actually reaches the pack.
     *
     * A real endpoint rather than a stubbed fetch, because the CLI builds its own `SetupService` and
     * the probe is the step most worth exercising end to end.
     */
    // Through the runtime adapter, not `Bun.serve` — invariant 1 covers tests too, and `lint:arch`
    // globs them. Port 0 lets the OS pick, so a parallel run cannot collide.
    const server = serveHttp({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname.endsWith("/models")
          ? Response.json({ data: [{ id: "model-one" }] })
          : new Response("no", { status: 404 }),
    });

    try {
      process.env.NOURIDE_TEST_KEY = "sk-not-a-real-key";
      await setup([
        "--yes",
        "--provider", "openai",
        "--base-url", `http://127.0.0.1:${server.port}`,
        "--api-key-from-env", "NOURIDE_TEST_KEY",
        "--agent", "nouva",
        "--name", "Nouva",
        "--prompt", "Answer in two sentences, casually.",
        "--headline", "Everyday help, said casually",
      ]);

      expect(process.exitCode).toBeFalsy();

      const pack = join(root, ".nouride", "agents", "nouva");
      expect(await readTextFile(join(pack, "SOUL.md"))).toContain("Answer in two sentences");
      // No USER.md since 0.7.0: who somebody is lives in People.
      expect(await readTextFileIfExists(join(pack, "USER.md"))).toBeNull();
      expect(await readTextFile(join(pack, "IDENTITY.md"))).toContain("Nouva");
      // What the other agents read about it (0.7.18), not the persona.
      expect(await readTextFile(join(pack, "IDENTITY.md"))).toContain("- **Headline:** Everyday help, said casually");

      // The credential split, checked on the artifacts rather than trusted: the name in the config,
      // the value only in the store.
      const config = await readTextFile(join(root, ".nouride", "config.toml"));
      // Named as the Models page names a profile's key: one writer for both.
      expect(config).toContain('api_key = "default_api_key"');
      expect(config).not.toContain("sk-not-a-real-key");
      // In the store, encrypted (0.8.19): the value is in no file as text, and opens with the store's key.
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(root, ".nouride", "data", "secrets.enc")).toString("latin1")).not.toContain("sk-not-a-real-key");
      const { SecretStore } = await import("@nouride/secrets");
      const { commandKeyLayout } = await import("@/boot/secret-store.ts");
      const layout = commandKeyLayout({ dataDir: join(root, ".nouride", "data"), configPath: join(root, ".nouride", "config.toml") });
      expect((await SecretStore.open(join(root, ".nouride", "data"), {}, { layout })).resolve("default_api_key")).toBe("sk-not-a-real-key");
    } finally {
      delete process.env.NOURIDE_TEST_KEY;
      await server.stop(true);
    }
  });

  // The owner, 2026-11-06: the first agent is a Nourider named Nourider, with the Nourider's headline and SOUL.md, made
  // from a terminal as on the dashboard's wizard. A terminal's default was `nouva`, "You are a helpful assistant.".
  test("asked nothing about the agent, it makes the wizard's: a Nourider named Nourider, with its headline and personality", async () => {
    const server = serveHttp({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "model-one" }] }) : new Response("no", { status: 404 })),
    });
    try {
      process.env.NOURIDE_TEST_KEY = "sk-not-a-real-key";
      await setup(["--yes", "--provider", "openai", "--base-url", `http://127.0.0.1:${server.port}`, "--api-key-from-env", "NOURIDE_TEST_KEY"]);
      expect(process.exitCode).toBeFalsy();
      const { presetOf } = await import("@/modules/setup/presets.ts");
      const pilot = presetOf("nourider");
      const pack = join(root, ".nouride", "agents", "nourider");
      const identity = await readTextFile(join(pack, "IDENTITY.md"));
      expect(identity).toContain("- **Name:** Nourider");
      expect(identity).toContain(`- **Headline:** ${pilot.headline}`);
      expect(await readTextFile(join(pack, "SOUL.md"))).toContain(pilot.soul);
      expect(await readTextFile(join(pack, "AGENTS.md"))).toContain(pilot.guidance);
    } finally {
      delete process.env.NOURIDE_TEST_KEY;
      await server.stop(true);
    }
  });

  test("beside a running daemon — as Docker's docs run it — the next step is its restart, not a second start", async () => {
    // 0.8.14 said `nouride start` and `nouride chat` after a `docker compose exec … nouride setup` (2026-11-02): a
    // second daemon the lock refuses, while the one running had not read what setup wrote.
    const server = serveHttp({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "model-one" }] }) : new Response("no", { status: 404 })),
    });
    const flags = ["--yes", "--provider", "openai", "--base-url", `http://127.0.0.1:${server.port}`, "--api-key-from-env", "NOURIDE_TEST_KEY", "--agent", "nouva", "--prompt", "Be brief.", "--headline", "Brief help"];
    const run = async (): Promise<string> => {
      let out = "";
      const original = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => ((out += String(chunk)), true);
      try {
        await setup(flags);
      } finally {
        (process.stdout as unknown as { write: unknown }).write = original;
      }
      return out.replace(/\u001b\[[0-9;]*m/g, "");
    };
    // A live process that calls itself a Nouride, holding the lock — as `users reset` and `db restore` are tested.
    const holder: ChildProcess = spawn("sh", ["-c", "sleep 30; :", "nouride-lock-holder"]);
    try {
      process.env.NOURIDE_TEST_KEY = "sk-not-a-real-key";
      mkdirSync(join(root, ".nouride", "data"), { recursive: true });
      writeFileSync(join(root, ".nouride", "data", "nouride.lock"), `${holder.pid}\n`);

      const beside = await run();
      expect(process.exitCode).toBeFalsy();
      expect(beside).toContain(restartHint());
      expect(beside).not.toContain("# then talk to it");

      // Without one, the steps are what they were.
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
      rmSync(join(root, ".nouride"), { recursive: true, force: true });
      const alone = await run();
      expect(alone).toContain("nouride start        # then talk to it");
      expect(alone).not.toContain(restartHint());
    } finally {
      holder.kill();
      delete process.env.NOURIDE_TEST_KEY;
      await server.stop(true);
    }
  });

  test("the muted output swallows what readline echoes", () => {
    /**
     * The whole hidden-key mechanism. Its first version instead put stdin into raw mode and read it
     * with a second async iterator, which on a real run echoed an operator's provider key in full,
     * threw `AbortError` from the destroyed stream, and hung every prompt after it.
     *
     * The screen behaviour itself needs a pty and was verified in a Linux container; what this pins is
     * the switch, so a later "simplification" back to `process.stdout` fails here rather than in
     * someone's scrollback. The class moved to `@nouride/runtime` with the rest of the prompt; this
     * test stays with the wizard, which is the only thing that asks for a hidden answer.
     */
    const written: string[] = [];
    const out = new MuteableOutput();
    // Intercept at the sink, since the real one forwards to the process's own stdout.
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };

    try {
      out.write("prompt: ");
      out.muted = true;
      out.write("sk-secret-value");
      out.muted = false;
      out.write("after");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = original;
    }

    expect(written.join("")).toBe("prompt: after");
    expect(written.join("")).not.toContain("sk-secret-value");
  });
});
