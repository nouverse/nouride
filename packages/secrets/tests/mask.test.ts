import { describe, expect, test } from "bun:test";
import { maskSecrets, SecretMasker } from "../src/mask.ts";

const env = { GITHUB_TOKEN: "ghp_abc123:xyz", NOURIDE_CREDENTIALS_DIR: "/data/credentials", PIN: "1234" };

describe("maskSecrets", () => {
  test("replaces the raw, base64 and URL-encoded forms of an injected value", () => {
    const b64 = Buffer.from("ghp_abc123:xyz").toString("base64");
    const out = maskSecrets(`token=ghp_abc123:xyz\nAuthorization: Basic ${b64}\n?t=ghp_abc123%3Axyz`, env);
    expect(out).not.toContain("ghp_abc123");
    expect(out).not.toContain(b64);
    expect(out.match(/\[REDACTED:GITHUB_TOKEN\]/g)?.length).toBe(3);
  });

  test("leaves paths and values too short to be credentials alone", () => {
    expect(maskSecrets("see /data/credentials, pin 1234", env)).toBe("see /data/credentials, pin 1234");
  });

  test("the start of a value is masked as the value — a print that stops short still printed the secret", () => {
    // `echo "${KEY:0:10}..."` on a live box: the whole value never appeared, so exact matching let the
    // part that is secret through.
    const key = { NOUGATE: "sk-nou-3A0b9F2kQ7xL1mZ8" };
    expect(maskSecrets(`NOUGATE env: ${key.NOUGATE.slice(0, 10)}...`, key)).toBe("NOUGATE env: [REDACTED:NOUGATE]...");
    expect(maskSecrets(`cut at ${key.NOUGATE.slice(0, 15)}`, key)).toBe("cut at [REDACTED:NOUGATE]");
  });

  test("but not a fixed prefix: seven characters are what every key of that kind starts with", () => {
    const key = { NOUGATE: "sk-nou-3A0b9F2kQ7xL1mZ8" };
    expect(maskSecrets("keys look like sk-nou-…", key)).toBe("keys look like sk-nou-…");
  });
});

describe("masking a stream", () => {
  const env = { API_TOKEN: "ghp_abcdefghijklmnop", SHORT: "abc" };
  const text = `start ${env.API_TOKEN} middle ${Buffer.from(env.API_TOKEN).toString("base64")} cut ${env.API_TOKEN.slice(0, 10)}, end ghp_abc`;

  /** Feed `text` in pieces cut at `cuts` and join what comes out. */
  const streamed = (cuts: number[]) => {
    const masker = new SecretMasker(env);
    let out = "";
    let from = 0;
    for (const cut of [...cuts, text.length]) {
      out += masker.push(text.slice(from, cut));
      from = cut;
    }
    return out + masker.end();
  };

  test("a value split across two chunks is still masked, wherever the split falls", () => {
    // The whole reason the masker holds text back. Every cut position is tried, because the one that
    // matters is whichever lands inside the value.
    const whole = maskSecrets(text, env);
    expect(whole).not.toContain(env.API_TOKEN);
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(streamed([cut])).toBe(whole);
    }
  });

  test("one character at a time gives the same answer as the whole text", () => {
    expect(streamed(Array.from({ length: text.length }, (_, i) => i))).toBe(maskSecrets(text, env));
  });

  test("a prefix of a value that never completes is released untouched at the end", () => {
    // `ghp_abc` at the tail looks like the start of the token until the stream ends. Holding it forever
    // would lose output; masking it would redact text that is not a secret.
    expect(streamed([text.length - 3])).toEndWith("end ghp_abc");
  });

  test("the start of a value at the very end of the stream is masked when the stream ends", () => {
    const masker = new SecretMasker(env);
    const out = masker.push(`last ${env.API_TOKEN.slice(0, 12)}`);
    expect(out).toBe("last ");
    expect(masker.end()).toBe("[REDACTED:API_TOKEN]");
  });

  test("with nothing to mask, text passes straight through with nothing held", () => {
    const masker = new SecretMasker({});
    expect(masker.push("abc")).toBe("abc");
    expect(masker.end()).toBe("");
  });
});

describe("a value that starts as every URL or path does", () => {
  test("is masked whole only: its start is no secret, and every later URL or path shares it", () => {
    const env = { TMP_SECRET_DB: "postgres://postgres:Hunter2024x@10.0.0.3:5432/app", TMP_SECRET_HOME: "/home/gading/projects" };
    expect(maskSecrets("see postgres://app:other@db:5432/x and /home/gading/notes", env)).toBe("see postgres://app:other@db:5432/x and /home/gading/notes");
    expect(maskSecrets("DB is postgres://postgres:Hunter2024x@10.0.0.3:5432/app", env)).toBe("DB is [REDACTED:TMP_SECRET_DB]");
  });

  test("anything else still loses its start — a slice of a token is a leak", () => {
    expect(maskSecrets("first ten: ghp_abcdef12", { TOKEN: "ghp_abcdef1234567890abcdef" })).toBe("first ten: [REDACTED:TOKEN]");
  });
});
