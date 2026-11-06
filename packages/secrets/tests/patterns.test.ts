/**
 * The registry, held to its own rows: each rule takes its examples — that rule and not another, the value exact —
 * and nothing takes a near-miss or ordinary chat. What redaction masks is checked against the same rows.
 */

import { describe, expect, test } from "bun:test";
import { plausibleSecret, SECRET_PATTERNS, sample } from "../src/patterns.ts";
import { redact } from "../src/redact.ts";
import { findSecrets } from "../src/scan.ts";

describe("the registry", () => {
  test("ids are unique and kebab-case, and every rule is global with an example", () => {
    const ids = SECRET_PATTERNS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SECRET_PATTERNS) {
      expect(rule.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(rule.pattern.flags).toContain("g");
      expect(rule.examples.length).toBeGreaterThan(0);
    }
  });

  for (const rule of SECRET_PATTERNS) {
    test(`${rule.id} takes its examples, value exact — in its own reader and in redaction's`, () => {
      const modes = rule.tier === "eager" ? (["eager"] as const) : (["ingress", "eager"] as const);
      for (const example of rule.examples) {
        for (const mode of modes) {
          const found = findSecrets(example.text, mode);
          expect({ mode, found: found.map((match) => [match.pattern.id, match.value]) }).toEqual({ mode, found: [[rule.id, example.value]] });
        }
      }
    });
  }

  test("nothing takes a near-miss from a message", () => {
    const misses = SECRET_PATTERNS.flatMap((rule) => (rule.nearMisses ?? []).map((text) => ({ rule: rule.id, text })));
    expect(misses.length).toBeGreaterThan(30);
    for (const miss of misses) {
      expect({ ...miss, found: findSecrets(miss.text, "ingress").map((match) => match.pattern.id) }).toEqual({ ...miss, found: [] });
    }
  });
});

/** Messages people send an agent, none of which holds a credential — and each of which a careless rule would cut. */
const ORDINARY = [
  "Run `kubectl rollout restart deployment/api` and wait for the pods.",
  "tolong cek kenapa deploy kemarin gagal, log nya ada di /var/log/nouride",
  "token budget per turn sekarang 128000, naikin ke 200000 ya",
  "the access token expired yesterday, can you refresh it?",
  "lupa password wifi kantor, minta tolong reset dong",
  "Password policy: at least 12 characters, one digit, one symbol.",
  'api_key = "nougate"',
  'exec_secrets = ["github_token", "openai_main"]',
  "[providers.main]\napi_key = \"openai_main\"\nmodel = \"gpt-5\"",
  "const token = process.env.GITHUB_TOKEN ?? '';",
  "export OPENAI_API_KEY=$OPENAI_API_KEY",
  "password: z.string().min(12).max(128)",
  "def login(username: str, password: str) -> Token:",
  "curl -H \"Authorization: Bearer $TOKEN\" https://api.github.com/user",
  "git checkout 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345 -- src/index.ts",
  "id event 123e4567-e89b-12d3-a456-426614174000 gagal diproses",
  "kirim ke budi@example.com sama https://example.com/docs?page=2",
  "jalankan `nouride secrets set nougate` lalu restart",
  "pip install scikit-learn sk-video && python train.py",
  "branch sk-hynix-memory-prices-2025 udah di-merge belum?",
  "versi sekarang v0.7.16, token sudah dirotasi minggu lalu",
  "SECRET_KEY=change-me-in-production",
  "the bearer of this letter is my colleague",
  "Basic authentication is disabled on this endpoint.",
  "meeting jam 10:30:45 tanggal 2026-10-18 di ruang 4B",
  "token listrik 1234 5678 9012 3456 7890 sudah masuk",
];

describe("ordinary chat", () => {
  test("loses nothing on the way in", () => {
    for (const text of ORDINARY) {
      expect({ text, found: findSecrets(text, "ingress").map((match) => `${match.pattern.id}: ${match.value}`) }).toEqual({ text, found: [] });
    }
  });
});

describe("findSecrets", () => {
  test("where two rules claim one value, the surer and more specific one wins", () => {
    const github = sample("ghp_", 36);
    const [header] = findSecrets(`curl -H "Authorization: Bearer ${github}"`, "ingress");
    expect(header?.pattern.id).toBe("github-token");
    const [inUrl] = findSecrets(`git clone https://x-access-token:${github}@github.com/org/repo.git`, "ingress");
    expect(inUrl?.pattern.id).toBe("github-token");
    const [assigned] = findSecrets(`GITHUB_TOKEN=${github}`, "ingress");
    expect([assigned?.pattern.id, assigned?.value]).toEqual(["github-token", github]);
  });

  test("every credential in a message, in order", () => {
    const openai = sample("sk-proj-", 100, "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    const telegram = `${sample("", 10, "0123456789")}:AA${sample("", 33)}`;
    const text = `ini key openai ${openai}\ndan bot token ${telegram}\npassword: Hunter2024!`;
    expect(findSecrets(text, "ingress").map((match) => match.value)).toEqual([openai, telegram, "Hunter2024!"]);
  });

  test("a vendor's format wins over a rule that would take more — the value held is the token, not the sentence's full stop", () => {
    const github = sample("ghp_", 36);
    const found = findSecrets(`token: ${github}.`, "ingress");
    expect(found.map((match) => [match.pattern.id, match.value])).toEqual([["github-token", github]]);
  });

  test("a value turned down is looked into: a token in a URL that is itself no secret", () => {
    // The URL is what `WEBHOOK_TOKEN_URL` holds, and a URL is not a credential; the token in its query string is — and
    // short enough that only `token=` assigning it says so.
    const found = findSecrets("WEBHOOK_TOKEN_URL=https://hooks.example.com/in?token=k3y9x2m7", "ingress");
    expect(found.map((match) => [match.pattern.id, match.value])).toEqual([["assigned-secret", "k3y9x2m7"]]);
  });

  test("a git SHA stays in a message and goes from a draft", () => {
    const sha = sample("", 40, "0123456789abcdef");
    expect(findSecrets(`revert ${sha}`, "ingress")).toEqual([]);
    expect(findSecrets(`revert ${sha}`, "eager").map((match) => match.pattern.id)).toEqual(["long-hex"]);
  });

  test("a private key is one secret, not a key and a run of hex inside it", () => {
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${sample("", 64, "0123456789abcdef")}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(findSecrets(key, "eager").map((match) => match.pattern.id)).toEqual(["private-key"]);
  });
});

describe("what a value named as a secret has to look like", () => {
  test("a credential", () => {
    for (const value of ["Hunter2024!", "a8f5f167f44f4964e6c998dee827110c", "Rumah#2024", "p4ss-w0rd", "123e4567-e89b-12d3-a456-426614174000", "Zq9xW2vB_nM4kL8p"]) {
      expect({ value, plausible: plausibleSecret(value) }).toEqual({ value, plausible: true });
    }
  });

  test("not a word, a name, a reference, a path, a number or code", () => {
    for (const value of ["expired", "openai_main", "your-secret-key", "TokenType", "e2e_saved_token", "AWS_S3_BUCKET", "openai-v2", "${API_KEY}", "$TOKEN", "%TOKEN%", "<your-key>", "{{ secrets.KEY }}", "xxxxxxxx", "********", "./secrets/token", "/run/secrets/db", "https://example.com/x", "budi@example.com", "12345678", "2026-10-18", "192.0.2.10:3000", "v1.2.3-beta", "process.env.TOKEN", "getenv(KEY", "z.string().min(8"]) {
      expect({ value, plausible: plausibleSecret(value) }).toEqual({ value, plausible: false });
    }
  });
});

describe("redact", () => {
  test("keeps what names a secret and where it lives; only the value goes", () => {
    const out = redact(`DB_PASSWORD="hunter2hunter2"\ngit clone https://gading:s3cr3tpw@git.example.com/repo.git\nAuthorization: Bearer ${sample("", 32)}`);
    expect(out.text).toBe(
      'DB_PASSWORD="[redacted:assigned-secret]"\ngit clone https://gading:[redacted:url-credentials]@git.example.com/repo.git\nAuthorization: Bearer [redacted:bearer-token]',
    );
    expect(out.hits).toEqual(["assigned-secret", "url-credentials", "bearer-token"]);
  });

  test("takes what a message keeps: a weak password assigned, a loose sk- name, long hex", () => {
    const out = redact(`password=hunter\nsk-this-is-a-kebab-name-2025\n${sample("", 40, "0123456789abcdef")}`);
    expect(out.text).toBe("password=[redacted:assigned-secret]\n[redacted:api-key]\n[redacted:long-hex]");
  });

  test("a bare key is masked: `password=`, `token:` and `api_key` name a secret on their own", () => {
    // The rule used to need something before the word — `DB_PASSWORD` was masked and `password` was not.
    expect(redact("password=s3cr3t-value").text).toBe("password=[redacted:assigned-secret]");
    expect(redact("token: abc123def456").text).toBe("token: [redacted:assigned-secret]");
    expect(redact('api_key = "Zq9xW2vB7nM4"').text).toBe('api_key = "[redacted:assigned-secret]"');
  });

  test("text with nothing in it comes back as it was", () => {
    const text = "Run `kubectl rollout restart deployment/api` and wait for the pods.";
    expect(redact(text)).toEqual({ text, hits: [] });
  });
});
