/**
 * The `validate()` pass, exercised through the real loader.
 *
 * It is not reachable from `parseConfig` — `loadGlobalConfig` calls it after the env overrides — so
 * every check in it was untested until now, including the numeric range guards added for the audit.
 * A guard nobody tests is a guard that quietly stops matching the field it names.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_ITERATIONS_ADVISED, addLogSink } from "@nouride/shared";
import { chmodSync } from "node:fs";
import { ensureDir, removePath, writeTextFile } from "@nouride/runtime";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";
import { lintConfig } from "@/modules/config/schema.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

let dir: string;
const warnings: string[] = [];

addLogSink((entry) => {
  if (entry.level === "warn") warnings.push(entry.message);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-validate-"));
  warnings.length = 0;
});

afterEach(() => {
  removePath(dir);
});

/** Write a config into a temp install root and load it the way the daemon does. */
async function load(toml: string) {
  // Beside an install, which is where a bare config.toml in the working directory is read (`loadGlobalConfig`).
  ensureDir(join(dir, ".nouride"));
  await writeTextFile(join(dir, "config.toml"), toml);
  return await loadGlobalConfig(dir);
}

describe("queue concurrency", () => {
  test("refuses more than one concurrent turn per chat", async () => {
    // Not a preference. Each turn saves the conversation it loaded with its own messages after: two at
    // once both read it, and the slower one's save drops the other exchange with nothing logged.
    await expect(load("[queue]\nmax_concurrent_per_agent = 2\n")).rejects.toThrow(
      /must be 1.*the conversation it loaded/s,
    );
  });

  test("accepts 1, and still refuses 0", async () => {
    const { config } = await load("[queue]\nmax_concurrent_per_agent = 1\n");
    expect(config.queue.maxConcurrentPerAgent).toBe(1);
    await expect(load("[queue]\nmax_concurrent_per_agent = 0\n")).rejects.toThrow(/at least 1/);
  });
});

/**
 * The rule still holds; it moved.
 *
 * It was a bespoke `log.warn` in the loader, and once `lintConfig` grew the same check every
 * `nouride config check` reported the finding twice — once as a loader line, once as a lint. Two
 * voices saying one thing reads as two problems, so the loader's copy went and the lint is the
 * single home. It is surfaced at boot, in `nouride doctor`, and in `config check`.
 */
describe("queue timeout against the turn deadline", () => {
  const lintsFor = async (toml: string) => lintConfig((await load(toml)).config).map((l) => l.message);

  test("reports when a queued message cannot outlive one full-length turn", async () => {
    // The combination is survivable — the sender is told when a message is dropped — but it means one
    // slow turn costs the next message for no reason anyone chose.
    const lints = await lintsFor("[queue]\nqueue_timeout_ms = 30000\n\n[llm.limits]\nmax_turn_duration_ms = 300000\n");
    expect(lints.some((m) => m.includes("queue_timeout_ms"))).toBe(true);
  });

  test("stays quiet when the queue outlives the turn", async () => {
    const lints = await lintsFor("[queue]\nqueue_timeout_ms = 300000\n\n[llm.limits]\nmax_turn_duration_ms = 120000\n");
    expect(lints.some((m) => m.includes("queue_timeout_ms"))).toBe(false);
  });

  test("the shipped defaults do not trip it", async () => {
    // The defaults used to: 120s of queue against a 300s turn. Anyone running unmodified config hit it.
    const lints = await lintsFor("[daemon]\nname = \"nouride\"\n");
    expect(lints.some((m) => m.includes("queue_timeout_ms"))).toBe(false);
  });

  test("it is not also reported by the loader, because it used to be reported twice", async () => {
    await load("[queue]\nqueue_timeout_ms = 30000\n\n[llm.limits]\nmax_turn_duration_ms = 300000\n");
    expect(warnings.some((w) => w.includes("queue_timeout_ms is shorter than"))).toBe(false);
  });
});

describe("numeric ranges", () => {
  test("a zero timeout is refused rather than silently meaning 'never'", async () => {
    await expect(load("[security]\ntool_timeout_ms = 0\n")).rejects.toThrow(
      /tool_timeout_ms must be a positive integer/,
    );
  });

  test("an iteration cap below the floor is refused, and says why the floor exists", async () => {
    /**
     * `positive` used to be the whole rule, so `1` was accepted — a turn capped before it can
     * finish a read, run, check, answer loop. That is not a tighter budget, it is a broken agent,
     * and the refusal has to say so or somebody will set it to 1 again.
     */
    for (const bad of ["-1", "0", "4"]) {
      await expect(load(`[llm.limits]\nmax_tool_iterations = ${bad}\n`)).rejects.toThrow(
        /max_tool_iterations must be at least 5/,
      );
    }
  });

  test("and one above the ceiling is refused as the typo it usually is", async () => {
    /**
     * Every iteration re-sends the whole conversation, so the spend of a runaway turn grows faster
     * than this number does. Somebody who means 100 and types 10000 gets a turn that can cost a
     * hundred times more, with nobody watching.
     */
    await expect(load("[llm.limits]\nmax_tool_iterations = 10000\n")).rejects.toThrow(
      /must be at most 9999[\s\S]*50 to 250 is the/,
    );
  });

  test("the default an install ships with is inside the range every surface advises", () => {
    // 250 became the default and the refusal, `nouride tool-budget` and the dashboard went on advising 25 to 100,
    // so a fresh install's own setting drew "Above 100, prefer a background job". The shared test that was to hold
    // this passed 25 in and read 25 back.
    const shipped = DEFAULT_CONFIG.llm.limits.maxToolIterations;
    expect(shipped).toBeGreaterThanOrEqual(TOOL_ITERATIONS_ADVISED.from);
    expect(shipped).toBeLessThanOrEqual(TOOL_ITERATIONS_ADVISED.to);
  });

  test("the range that works is accepted at both ends", async () => {
    for (const good of ["5", "25", "250", "9999"]) {
      const loaded = await load(`[llm.limits]\nmax_tool_iterations = ${good}\n`);
      expect(loaded.config.llm.limits.maxToolIterations).toBe(Number(good));
    }
  });

  test("job_max_ms: 0 is off, and a timer's ceiling is the limit — past it a timer fires at once and stops every job", async () => {
    for (const bad of ["-1", "1.5", '"2h"', "2147483648", "3000000000"]) {
      await expect(load(`[security]\njob_max_ms = ${bad}\n`)).rejects.toThrow(/job_max_ms must be 0 \(never stop a job\) or a whole number of milliseconds up to 2147483647/);
    }
    for (const good of [0, 7_200_000, 2_147_483_647]) {
      expect((await load(`[security]\njob_max_ms = ${good}\n`)).config.security.jobMaxMs).toBe(good);
    }
    expect((await load("")).config.security.jobMaxMs).toBe(0);
  });

  test("retention accepts 0 as 'keep everything' but refuses negatives", async () => {
    const { config } = await load("[retention]\nsession_days = 0\naudit_days = 0\n");
    expect(config.retention.sessionDays).toBe(0);

    await expect(load("[retention]\nsession_days = -1\n")).rejects.toThrow(
      /session_days must be a whole number of days/,
    );
  });
});

describe("forms 0.7.x rewrote on disk, refused in 0.8.0 with what replaced each", () => {
  // Refused, not ignored: each dropped would change who may talk, when a conversation resets, which agent answers
  // first or how skills are learned, without a word.
  test.each([
    ['[security]\nsender_allowlist = ["telegram:1"]\n', "config.toml [security] sender_allowlist is gone: list those ids in [security.access] allowlist"],
    ['[session_memory]\nactive_dir = "/tmp/x"\n', "config.toml [session_memory] is gone: its reset is [rollover]"],
    ['[daemon]\ndefault_agent = "nouva"\n', 'config.toml [daemon] default_agent is gone: write orchestrator = "<agent id>" in [daemon]'],
    ['[[people]]\nid = "telegram:1"\nname = "Gading"\n', 'config.toml [[people]] id is gone: write ids = ["platform:account", …] in that entry instead'],
    ['[rsi]\nmode = "always_allow"\n', 'config.toml [rsi] is gone: write [skills.learning], with mode = "off", "ask" or "auto"'],
  ])("%p", async (toml, refusal) => {
    await expect(load(toml)).rejects.toThrow(refusal);
  });

  test("every one found is named at once, not one per restart", async () => {
    await expect(load('[daemon]\ndefault_agent = "nouva"\n\n[rsi]\nmode = "off"\n')).rejects.toThrow(/default_agent is gone[^]*\n.*\[rsi\] is gone/);
  });

  test("a preset's old name is refused like any other word, the levels listed", async () => {
    await expect(load('[security]\napprovals = "risky"\n')).rejects.toThrow(/\[security\] approvals/);
  });

  test("an account in an old spelling is refused, naming today's", async () => {
    await expect(load('[[people]]\nids = ["telegram:nouva:814"]\nname = "Gading"\n')).rejects.toThrow(
      '[[people]] #1 id "telegram:nouva:814" names the connection it came in on. Write it as "telegram:814"',
    );
    await expect(load('[[people]]\nids = ["local:dev:usr_1"]\nname = "Gading"\n')).rejects.toThrow('write it as "web:usr_1"');
    await expect(load('[[people]]\nids = ["web:dev"]\nname = "Gading"\n')).rejects.toThrow('write it as "web:terminal"');
  });
});

describe("the memory vault", () => {
  test("accepts a dir that does not exist yet — boot creates it", async () => {
    // The default lives inside the install, so "not there" is the normal state of a fresh install.
    const path = join(dir, "not-there");
    const { config } = await load(`[memory]\ndir = "${path}"\n`);
    expect(config.memory.dir).toBe(path);
  });

  test("refuses a dir that exists as a file", async () => {
    const path = join(dir, "notadir");
    await writeTextFile(path, "x");
    await expect(load(`[memory]\ndir = "${path}"\n`)).rejects.toThrow(/not a writable directory/);
  });

  test("refuses a dir this process cannot write to", async () => {
    // The live shape of this mistake: another service's user owns it, so it stats fine and rejects every write.
    const path = join(dir, "readonly");
    ensureDir(path);
    chmodSync(path, 0o500);
    try {
      await expect(load(`[memory]\ndir = "${path}"\n`)).rejects.toThrow(/exists but is not a writable directory/);
    } finally {
      chmodSync(path, 0o700);
    }
  });

  test("on by default, inside the install", async () => {
    const { config } = await load("");
    expect(config.memory.dir.endsWith("/.nouride/memory")).toBe(true);
    expect(config.memory).toMatchObject({ pass: false, passAt: "01:00", facts: "off", proposeShared: false, promptRecent: 3, transcriptDays: 180, archive: true });
  });
});

describe("rollover", () => {
  test("idle mode with no window is refused", async () => {
    await expect(load('[rollover]\nmode = "idle"\nidle_minutes = 0\n')).rejects.toThrow(/idle_minutes must be greater than 0/);
  });

  test("an hour outside the day is refused", async () => {
    await expect(load('[rollover]\nmode = "daily"\nat_hour = 24\n')).rejects.toThrow(/at_hour must be an hour 0-23/);
  });

  test("an unknown mode is refused", async () => {
    await expect(load('[rollover]\nmode = "hourly"\n')).rejects.toThrow(/mode must be one of/);
  });

});

describe("nudge_after_minutes (0.7.25)", () => {
  test("five by default, 0 is off, and anything but a whole number from 0 is refused at load", async () => {
    expect((await load("")).config.agents.nudgeAfterMinutes).toBe(5);
    expect((await load("[agents]\nnudge_after_minutes = 0\n")).config.agents.nudgeAfterMinutes).toBe(0);
    expect((await load("[agents]\nnudge_after_minutes = 15\n")).config.agents.nudgeAfterMinutes).toBe(15);
    for (const bad of ["-1", "2.5", '"five"']) {
      await expect(load(`[agents]\nnudge_after_minutes = ${bad}\n`)).rejects.toThrow(/nudge_after_minutes = .* is not a whole number from 0 up/);
    }
  });
});

describe("[missions] max_running (0.8.0)", () => {
  test("unset by default — the slots follow the agents — any whole number from 1 when set, and nothing else", async () => {
    expect((await load("")).config.missions.maxRunning).toBeUndefined();
    expect((await load("[missions]\nmax_running = 3\n")).config.missions.maxRunning).toBe(3);
    // No fixed most: thirty agents may run thirty, and a value past the agents loaded is no more than can run.
    expect((await load("[missions]\nmax_running = 40\n")).config.missions.maxRunning).toBe(40);
    // With no default to take a type from, a value of another type is still refused at load, not read as a string.
    for (const bad of ["0", "2.5", '"three"', "-1"]) {
      await expect(load(`[missions]\nmax_running = ${bad}\n`)).rejects.toThrow(/max_running = .* is not a whole number from 1 up/);
    }
  });
});

describe("group context window", () => {
  test("refuses a value outside the range it documents", async () => {
    // Not clamped: an operator who typed 500 and silently got 100 has nothing to read that explains
    // the difference, and the block rides on every turn in the room.
    await expect(load("[agents]\ngroup_context_messages = 500\n")).rejects.toThrow(
      /between 0 \(off\) and 100/,
    );
    await expect(load("[agents]\ngroup_context_messages = -1\n")).rejects.toThrow(/between 0/);
  });

  test("refuses a value that is not a whole number", async () => {
    // `[agents]` is deep merged with no per-field typing, so a string lands in the config as a string
    // and `resolveGroupContextLimit` reads it as 0 — the off position. The operator would see a
    // feature they configured doing nothing, with nothing anywhere saying why.
    await expect(load('[agents]\ngroup_context_messages = "twenty"\n')).rejects.toThrow(
      /whole number/,
    );
    await expect(load("[agents]\ngroup_context_messages = 2.5\n")).rejects.toThrow(/whole number/);
  });

  test("accepts the ends of the range", async () => {
    expect((await load("[agents]\ngroup_context_messages = 0\n")).config.agents.groupContextMessages).toBe(0);
    expect((await load("[agents]\ngroup_context_messages = 100\n")).config.agents.groupContextMessages).toBe(100);
  });

  test("refuses an out-of-range override on one connection", async () => {
    // The per-connection value takes a different path — field-by-field parsing of an open-shaped
    // table — so the range has to be enforced there too, naming the table it came from.
    await expect(
      load(
        '[gateways.telegram.main]\ntoken = "telegram-main"\ngroup_context_messages = 500\n',
      ),
    ).rejects.toThrow(/\[gateways\.telegram\.main\] group_context_messages/);
  });

  test("accepts an override of 0 on one connection", async () => {
    // Distinct from absent. `0` is "this room is not overheard"; absent is "use the daemon's setting".
    const { config } = await load(
      '[gateways.telegram.main]\ntoken = "telegram-main"\ngroup_context_messages = 0\n',
    );
    expect(config.gateways[0]?.groupContextMessages).toBe(0);
  });
});

/**
 * External sign-in, refused rather than half-applied.
 *
 * Every case here is a file that would boot happily and then fail at a moment when nothing can be
 * retried: two of them show no button and no reason, one shows a button that authenticates the user
 * and is then refused for a redirect URI mismatch, and one carries the identity in plaintext. None
 * of them is visible in a log line at boot, which is why they are refusals.
 */
describe("dashboard.oauth", () => {
  const configured = [
    '[dashboard]',
    'public_url = "https://agent.example.com"',
    '[dashboard.oauth]',
    'issuer = "https://service.nouverse.tech/api/auth"',
    'client_id = "nvo_abc"',
    'secret_name = "nouverse_oauth"',
    '',
  ].join("\n");

  test("all three settings together is accepted", async () => {
    const { config } = await load(configured);
    expect(config.dashboard.oauth.clientId).toBe("nvo_abc");
    // The secret's NAME, and the value is never in the config at all.
    expect(config.dashboard.oauth.secretName).toBe("nouverse_oauth");
  });

  test("no oauth section at all is the normal case and stays silent", async () => {
    const { config } = await load('[dashboard]\nport = 18254\n');
    expect(config.dashboard.oauth.issuer).toBe("");
  });

  test("an issuer with no client id is refused, naming what is missing", async () => {
    await expect(
      load('[dashboard.oauth]\nissuer = "https://service.nouverse.tech/api/auth"\n'),
    ).rejects.toThrow(/half configured: client_id and secret_name are empty/);
  });

  test("a client id with no issuer is refused too, not silently ignored", async () => {
    // The direction that reads as harmless: an operator pastes the client id, forgets the issuer, and
    // the login page looks exactly as it did before.
    await expect(load('[dashboard.oauth]\nclient_id = "nvo_abc"\n')).rejects.toThrow(
      /half configured: issuer and secret_name are empty/,
    );
  });

  test("a plaintext issuer is refused, because nothing else signs the identity", async () => {
    await expect(
      load(configured.replace("https://service.nouverse.tech", "http://service.nouverse.tech")),
    ).rejects.toThrow(/issuer must be https/);
  });

  test("loopback over http is allowed, for a provider on the same machine", async () => {
    const { config } = await load(
      configured.replace("https://service.nouverse.tech/api/auth", "http://localhost:3000/api/auth"),
    );
    expect(config.dashboard.oauth.issuer).toBe("http://localhost:3000/api/auth");
  });

  test("a configured issuer with no public_url is refused", async () => {
    // The worst of the four: the button works, the user signs in at the provider, and the exchange
    // is refused for a redirect URI that was never registered because it could not be built.
    await expect(load(configured.replace('public_url = "https://agent.example.com"', ""))).rejects.toThrow(
      /public_url is empty/,
    );
  });

  test("an issuer that is not a URL is refused as one", async () => {
    await expect(load(configured.replace("https://service.nouverse.tech/api/auth", "service.nouverse.tech"))).rejects.toThrow(
      /issuer is not a URL/,
    );
  });
});

/**
 * The environment overrides a managed pod needs.
 *
 * A pod's hostname is chosen by the platform at provision time and its OAuth client is issued per
 * install, so neither can come from a file baked into an image. These five exist for that case and
 * are pointless anywhere else — which is also why they are tested here rather than trusted: the
 * failure of a missing override is not an error, it is a button that never appears.
 *
 * `process.env` is process-wide and bun runs every test file in one process, so each of these puts
 * its variables back. A leak here would configure OAuth for an unrelated test two hundred tests
 * later, which is a fault that reads as belonging to whatever ran last.
 */
describe("environment overrides", () => {
  const KEYS = [
    "NOURIDE_PUBLIC_URL",
    "NOURIDE_OAUTH_ISSUER",
    "NOURIDE_OAUTH_CLIENT_ID",
    "NOURIDE_OAUTH_SECRET_NAME",
    "NOURIDE_OAUTH_LABEL",
  ] as const;

  const withEnv = async <T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      return await body();
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };

  test("configure external sign-in with no config file at all", async () => {
    const { config } = await withEnv(
      {
        NOURIDE_PUBLIC_URL: "https://agent.example.com",
        NOURIDE_OAUTH_ISSUER: "https://service.nouverse.tech/api/auth",
        NOURIDE_OAUTH_CLIENT_ID: "nvo_from_the_provisioner",
        NOURIDE_OAUTH_SECRET_NAME: "nouverse_oauth",
        NOURIDE_OAUTH_LABEL: "Nouverse",
      },
      () => load("[dashboard]\nport = 18254\n"),
    );

    expect(config.dashboard.publicUrl).toBe("https://agent.example.com");
    expect(config.dashboard.oauth.clientId).toBe("nvo_from_the_provisioner");
    expect(config.dashboard.oauth.secretName).toBe("nouverse_oauth");
  });

  test("the file wins nothing: an override replaces what it names and leaves the rest", async () => {
    const { config } = await withEnv({ NOURIDE_OAUTH_CLIENT_ID: "nvo_from_env" }, () =>
      load(
        [
          "[dashboard]",
          'public_url = "https://from-the-file.example"',
          "[dashboard.oauth]",
          'issuer = "https://service.nouverse.tech/api/auth"',
          'client_id = "nvo_from_the_file"',
          'secret_name = "nouverse_oauth"',
          "",
        ].join("\n"),
      ),
    );

    expect(config.dashboard.oauth.clientId).toBe("nvo_from_env");
    expect(config.dashboard.oauth.issuer).toBe("https://service.nouverse.tech/api/auth");
    expect(config.dashboard.publicUrl).toBe("https://from-the-file.example");
  });

  test("validation runs after them, so a half-configured environment is refused too", async () => {
    // The reason the order matters. A provisioner that injects an issuer and forgets the client id
    // would otherwise boot a daemon that shows no button and logs nothing about why.
    await expect(
      withEnv({ NOURIDE_OAUTH_ISSUER: "https://service.nouverse.tech/api/auth" }, () =>
        load("[dashboard]\nport = 18254\n"),
      ),
    ).rejects.toThrow(/half configured/);
  });

  test("and a plaintext issuer from the environment is refused the same way", async () => {
    await expect(
      withEnv(
        {
          NOURIDE_PUBLIC_URL: "https://agent.example.com",
          NOURIDE_OAUTH_ISSUER: "http://service.nouverse.tech/api/auth",
          NOURIDE_OAUTH_CLIENT_ID: "nvo_abc",
          NOURIDE_OAUTH_SECRET_NAME: "nouverse_oauth",
        },
        () => load("[dashboard]\nport = 18254\n"),
      ),
    ).rejects.toThrow(/issuer must be https/);
  });
});

/**
 * Turning password sign-in off, and the guard that stops it locking you out.
 *
 * `password_login = false` on an install with no identity provider is a login
 * page nobody can satisfy — and without this refusal the daemon would boot,
 * report healthy, and serve it. The check has to be at load rather than at the
 * login route, because by then the only person who could fix it cannot get in.
 */
describe("dashboard.password_login", () => {
  const withOauth = [
    '[dashboard]',
    'public_url = "https://agent.example.com"',
    'password_login = false',
    '[dashboard.oauth]',
    'issuer = "https://service.nouverse.tech/api/auth"',
    'client_id = "nvo_abc"',
    'secret_name = "nouverse_oauth"',
    '',
  ].join("\n");

  test("on is the default, so a fresh install has a way in", async () => {
    const { config } = await load("[dashboard]\nport = 18254\n");
    expect(config.dashboard.passwordLogin).toBe(true);
  });

  test("off is accepted when an identity provider is configured", async () => {
    const { config } = await load(withOauth);
    expect(config.dashboard.passwordLogin).toBe(false);
  });

  test("off with no provider is refused, naming the fix", async () => {
    await expect(load('[dashboard]\npassword_login = false\n')).rejects.toThrow(
      /needs \[dashboard\.oauth\] configured/,
    );
  });

  test("off with a HALF-configured provider is refused too", async () => {
    // The half-configured refusal fires first, which is the better message —
    // what matters is that this combination cannot boot.
    await expect(
      load('[dashboard]\npassword_login = false\n[dashboard.oauth]\nissuer = "https://service.nouverse.tech/api/auth"\n'),
    ).rejects.toThrow();
  });

  test("the environment can set it, and is still checked", async () => {
    const saved = process.env.NOURIDE_PASSWORD_LOGIN;
    try {
      process.env.NOURIDE_PASSWORD_LOGIN = "false";
      // A provisioner that turns it off without arranging a provider is refused
      // exactly as a hand-edited file would be.
      await expect(load("[dashboard]\nport = 18254\n")).rejects.toThrow(/needs \[dashboard\.oauth\]/);

      const { config } = await load(withOauth.replace("password_login = false\n", ""));
      expect(config.dashboard.passwordLogin).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NOURIDE_PASSWORD_LOGIN;
      else process.env.NOURIDE_PASSWORD_LOGIN = saved;
    }
  });
});

/**
 * With the gate switched off, the warning is the only thing left standing where it was.
 *
 * Live, on an install running `sensitive_paths = "off"`: an agent asked who a platform id belonged
 * to, found `sqlite3` was not installed, and opened the daemon's own database through `python3 -c`
 * instead — seven calls, reading the audit log, the sessions table and the people table. Nothing was
 * broken: the classifier has covered `nouride.db` all along and the operator had turned the level
 * off, which the daemon says at every boot.
 *
 * What it did not say is what that reaches. The sentence listed ".ssh keys, .env files, secrets.json
 * and any agent's config.toml" — every category except the one that was read — so an operator
 * looking at the symptom had no reason to connect it to this line.
 */
describe("how long a thinking model thinks", () => {
  test("unset is the provider's own; a level is taken; anything else refuses to start", async () => {
    expect((await load("")).config.llm.defaults.effort).toBeUndefined();
    expect((await load('[llm.defaults]\neffort = "medium"\n')).config.llm.defaults.effort).toBe("medium");
    await expect(load('[llm.defaults]\neffort = "hgih"\n')).rejects.toThrow(/\[llm.defaults\] effort must be one of "low", "medium", "high", "xhigh", "max"/);
  });
});

describe("the level that decides whether anything asks at all", () => {
  /**
   * Every other setting in `[security]` was enumerated and this one was not, which is exactly
   * backwards: it is the one that decides whether the gate is anywhere. `approvals = "riksy"`
   * passed `config check` with "this configuration would start", exit 0, and then resolved to
   * `balanced` — the permissive branch — because that was `skipsApproval`'s fall-through.
   */
  test("a value that is not one of the three refuses to start, like its siblings", async () => {
    await expect(load('[security]\napprovals = "riksy"\n')).rejects.toThrow(
      /\[security\] approvals must be one of "careful", "balanced", "trusted"/,
    );
  });

  test("and the three themselves still start", async () => {
    // Otherwise the test above is satisfied by a check that refuses everything.
    for (const level of ["careful", "balanced", "trusted"]) {
      await load(`[security]\napprovals = "${level}"\n`);
    }
  });

  test("the second look takes off, a tier or a model id — a switch's word names none, and is refused at load (0.8.0)", async () => {
    await expect(load('[security]\nmodel_guard = "on"\n')).rejects.toThrow(/\[security\] model_guard = "on" is none of off, a tier/);
    await expect(load('[security]\nmodel_guard = "   "\n')).rejects.toThrow(/\[security\] model_guard is blank/);
    for (const value of ["", "off", "high", "small", "qwen3:8b", "anthropic/claude-sonnet-4"]) await load(`[security]\nmodel_guard = "${value}"\n`);
  });
});

/**
 * The exec knobs 0.8.0 took into the approval levels. A file that still writes one is refused where
 * leaving it out would let more run without asking, and otherwise starts with a warning naming it — never translated.
 */
describe("the exec knobs 0.8.0 took out", () => {
  test.each([
    ['mode = "deny"', /mode = "deny" is gone in 0\.8\.0: take exec out of \[tools\] enabled/],
    ['mode = "allowlist"', /mode = "allowlist" is gone in 0\.8\.0: choose approvals = "careful"/],
    ['ask = "always"', /ask = "always" is gone in 0\.8\.0: choose approvals = "careful"/],
    ['sensitive_paths = "hardline"', /sensitive_paths = "hardline" is gone in 0\.8\.0: choose approvals = "careful"/],
  ])("%s asked more than any level does without it: refused, naming the fix", async (line, refusal) => {
    await expect(load(`[security.exec]\n${line}\n`)).rejects.toThrow(refusal);
  });

  test("the rest start, each named in a warning, none called unknown", async () => {
    await load('[security.exec]\nmode = "full"\nask = "off"\nask_fallback = "allowlist"\nsensitive_paths = "off"\nallowlist = ["git"]\n');
    for (const key of ["mode", "ask", "ask_fallback", "sensitive_paths", "allowlist"]) {
      expect(warnings.some((w) => w.includes(`[security.exec] ${key} is gone in 0.8.0 and ignored`))).toBe(true);
    }
    expect(warnings.some((w) => w.includes("unknown config key"))).toBe(false);
  });
});

