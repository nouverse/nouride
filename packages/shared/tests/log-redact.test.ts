/**
 * A credential never reaches the journal: the line is scrubbed at the one place every line passes through, so
 * the stdout a journal keeps, the log table the dashboard reads and the audit row of an error all get the same,
 * scrubbed entry. And an ordinary field comes through untouched — a scrubber that eats ids and counts is one somebody
 * turns off.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { addLogSink, configureLogger, createLogger, type LogEntry } from "../src/logger.ts";
import { redactLogText } from "../src/log-redact.ts";

const KEY = "sk-live-4f9a2b7c1d8e3f6a0b5c9d2e7f1a4b8c";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnYWRpbmcifQ.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg";

let written: string[] = [];
let entries: LogEntry[] = [];
let out: ReturnType<typeof spyOn>;

beforeEach(() => {
  written = [];
  entries = [];
  configureLogger({ stream: "stdout", pretty: false, level: "debug" });
  out = spyOn(console, "log").mockImplementation((line: unknown) => void written.push(String(line)));
  addLogSink((entry) => void (entry.component === "redact.test" && entries.push(entry)));
});

afterEach(() => {
  out.mockRestore();
  configureLogger({ level: "info" });
});

const log = createLogger("redact.test");

describe("a value under a key named like a credential", () => {
  test("never reaches the line or a sink, at any depth, whatever the key's spelling", () => {
    log.warn("provider call failed", {
      token: KEY,
      api_key: KEY,
      apiKey: KEY,
      "x-api-key": KEY,
      Authorization: `Bearer ${KEY}`,
      cookie: `session=${KEY}`,
      request: { headers: { authorization: `Bearer ${JWT}`, "content-type": "application/json" } },
      accounts: [{ refresh_token: KEY, email: "gading@example.com" }],
      client_secret: KEY,
      password: KEY,
    });

    const line = written.join("\n");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(JWT);
    // Each sink gets the scrubbed entry, not the caller's object: the log table and the audit log are sinks.
    expect(JSON.stringify(entries)).not.toContain(KEY);
    expect(entries[0]!.data).toMatchObject({
      token: "[redacted]",
      apiKey: "[redacted]",
      "x-api-key": "[redacted]",
      request: { headers: { authorization: "[redacted]", "content-type": "application/json" } },
      accounts: [{ refresh_token: "[redacted]", email: "gading@example.com" }],
    });
  });

  test("a structure under one goes whole — a header table is not read for which of its values is the secret", () => {
    log.info("cookies", { cookies: { session: KEY, theme: "dark" } });
    expect(entries[0]!.data).toEqual({ cookies: "[redacted]" });
  });

  test("an Error's own fields are read as JSON.stringify writes them — the provider body it was given included", () => {
    const err = Object.assign(new Error("401 from upstream"), { status: 401, body: `{"error":"bad key","api_key":"${KEY}"}` });
    log.error("turn failed", { error: err });
    expect(written.join("\n")).not.toContain(KEY);
    expect(entries[0]!.data).toEqual({ error: { status: 401, body: '{"error":"bad key","api_key":"[redacted]"}' } });
  });

  test("a line that refers to itself is written, not a crash", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    log.info("cycle", { loop });
    expect(entries[0]!.data).toEqual({ loop: { name: "loop", self: "[circular]" } });
  });
});

describe("a credential inside a string", () => {
  test("the message and every string field are read for the shapes that are one", () => {
    log.warn(`upstream answered 401 for Authorization: Bearer ${KEY}`, {
      error: `fetch https://bot:${KEY}@api.example.com/v1?limit=5&access_token=${KEY}&page=2 failed`,
      command: `GITHUB_TOKEN=${KEY} git push`,
      body: `{"model":"m","api_key": "${KEY}","messages":[]}`,
      basic: "Authorization: Basic Z2FkaW5nOmh1bnRlcjI=",
    });

    const line = written.join("\n");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("Z2FkaW5nOmh1bnRlcjI=");
    expect(entries[0]!.message).toBe("upstream answered 401 for Authorization: Bearer [redacted]");
    expect(entries[0]!.data).toEqual({
      // The user and the host stay — usually the point of the line — and the ordinary parameters with them.
      error: "fetch https://bot:[redacted]@api.example.com/v1?limit=5&access_token=[redacted]&page=2 failed",
      command: "GITHUB_TOKEN=[redacted] git push",
      body: '{"model":"m","api_key": "[redacted]","messages":[]}',
      basic: "Authorization: Basic [redacted]",
    });
  });

  test("and the pretty line a terminal gets (`[daemon] log_pretty`) is the scrubbed one too", () => {
    configureLogger({ pretty: true });
    try {
      log.warn(`upstream answered 401 for Authorization: Bearer ${KEY}`, { error: `access_token=${KEY}` });
    } finally {
      configureLogger({ pretty: false });
    }
    const line = written.join("\n");
    expect(line).toContain("upstream answered 401 for Authorization: Bearer [redacted]");
    expect(line).not.toContain(KEY);
  });

  test("a Google-style key= and a presigned URL's signature are credentials too", () => {
    expect(redactLogText(`https://x.googleapis.com/v1/models?key=AIzaSyA${"b".repeat(32)}`)).toBe("https://x.googleapis.com/v1/models?key=[redacted]");
    expect(redactLogText("https://bucket.s3.amazonaws.com/a.png?X-Amz-Credential=AKIA%2F&X-Amz-Signature=deadbeefcafe")).toBe(
      "https://bucket.s3.amazonaws.com/a.png?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]",
    );
  });
});

describe("an ordinary line comes through as it was written", () => {
  test("counts, ids, names of secrets, flags and hashes are not credentials", () => {
    const data = {
      session_id: "telegram:main:42:1",
      tokens: 1834,
      input_tokens: 1200,
      max_tokens: 8192,
      token_id: "a1b2c3",
      token_prefix: "deadbeef",
      secret_name: "nougate",
      exec_secrets: ["twit_auth_token"],
      has_credential: true,
      mustChangePassword: false,
      password_login: "set",
      grant_key: `g1:${"f".repeat(64)}`,
      sha: "0123456789abcdef0123456789abcdef01234567",
      url: "https://api.example.com/v1/chat?model=gemini-3.8-flash&stream=true",
      error: "Basic authentication failed for nouva",
      text: "The bearer of this message is a token of goodwill",
      empty_token: "",
      nothing: null,
    };
    log.info("turn complete", data);
    expect(entries[0]!.data).toEqual(data);
    expect(entries[0]!.message).toBe("turn complete");
  });

  test("a URL or a Date is written as JSON.stringify writes it, and read like any string", () => {
    const at = new Date("2026-10-17T00:00:00.000Z");
    log.info("fetched", { at, url: new URL(`https://example.com/cb?state=abc&token=${KEY}`) });
    expect(entries[0]!.data).toEqual({ at: "2026-10-17T00:00:00.000Z", url: "https://example.com/cb?state=abc&token=[redacted]" });
  });
});
