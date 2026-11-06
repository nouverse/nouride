/**
 * What a command printing credentials gives up (`printed.ts`), line by line: every value by its key, a private key
 * whole, then the shapes — and what stays so a person can still debug. `swap` here records each value and says a
 * numbered stand-in, so a test reads which value went and under which key.
 */

import { describe, expect, test } from "bun:test";
import { PrintedCredentials, plainValue, type PrintedKind } from "../src/printed.ts";

/** The `n`th handle `run` hands out — real handles, since a value that holds one is already swapped. */
const h = (n: number) => `$TMP_SECRET_${n.toString(16).toUpperCase().padStart(12, "0")}`;

/** The output through a fresh filter, fed in pieces of `step` characters, and what it swapped. */
function run(kind: PrintedKind, text: string, step = text.length || 1): { out: string; swapped: Array<[string, string]> } {
  const swapped: Array<[string, string]> = [];
  const filter = new PrintedCredentials(kind, (value, key) => {
    swapped.push([key, value]);
    return h(swapped.length);
  });
  let out = "";
  for (let at = 0; at < text.length; at += step) out += filter.push(text.slice(at, at + step));
  return { out: out + filter.end(), swapped };
}

const KEY_LINES = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "-----END OPENSSH PRIVATE KEY-----"];
const DOTENV = [
  "# nougate",
  'DB_URL="postgres://postgres:HarborLight2404@192.0.2.10:5432/nougate"',
  "PASSWORD=hunter2",
  "export API_TOKEN='abc def'",
  "PORT=5432",
  "NODE_ENV=production",
  "DEBUG=true",
  "EMPTY=",
  'QUOTED_EMPTY=""',
  "OTHER=${PASSWORD}",
  "  db_password = s3cret  ",
  ...KEY_LINES,
  "",
].join("\n");

describe("a credential file", () => {
  const { out, swapped } = run("file", DOTENV);

  test("every value that is not plainly harmless goes, its key stays", () => {
    expect(out).toContain(`DB_URL="${h(1)}"`);
    expect(out).toContain(`PASSWORD=${h(2)}`);
    expect(out).toContain(`export API_TOKEN='${h(3)}'`);
    expect(out).toContain(`  db_password = ${h(4)}  `);
    expect(swapped.slice(0, 4)).toEqual([
      ["DB_URL", "postgres://postgres:HarborLight2404@192.0.2.10:5432/nougate"],
      ["PASSWORD", "hunter2"],
      ["API_TOKEN", "abc def"],
      ["db_password", "s3cret"],
    ]);
    for (const value of ["HarborLight2404", "hunter2", "abc def", "s3cret"]) expect(out).not.toContain(value);
  });

  test("a number, a yes, an environment word, an empty value and a reference stay, so debugging works", () => {
    for (const line of ["PORT=5432", "NODE_ENV=production", "DEBUG=true", "EMPTY=", 'QUOTED_EMPTY=""', "OTHER=${PASSWORD}", "# nougate"]) {
      expect(out).toContain(`${line}\n`);
    }
  });

  test("a private key goes whole, as one value, with its own lines", () => {
    expect(swapped.at(-1)).toEqual(["private key", KEY_LINES.join("\n")]);
    expect(out).toContain(`${h(5)}\n`);
    expect(out).not.toContain("BEGIN OPENSSH");
    expect(out.endsWith(`${h(5)}\n`)).toBe(true);
  });

  test("streamed a few characters at a time — a line and a key block split across pieces — it comes out the same", () => {
    for (const step of [1, 7, 64]) expect(run("file", DOTENV, step)).toEqual({ out, swapped });
  });

  test("a JSON login file: each string value by its key; numbers and nesting stay", () => {
    const json = '{\n  "type": "service_account",\n  "port": 5432,\n  "client_secret": "GOCSPX-abc",\n  "nested": {\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n"\n  }\n}\n';
    const { out: shown, swapped: taken } = run("file", json);
    expect(shown).toContain(`"type": "${h(1)}"`);
    expect(shown).toContain('"port": 5432');
    expect(shown).toContain(`"client_secret": "${h(2)}"`);
    expect(shown).toContain('"nested": {');
    // The key inside a JSON string goes as one value, its `\n`s read as the newlines they are — and once, not twice.
    expect(taken[2]).toEqual(["private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----"]);
    expect(taken).toHaveLength(3);
  });

  test(".npmrc, .netrc and .pgpass, by their own shapes", () => {
    expect(run("file", "//registry.npmjs.org/:_authToken=npm_abcdef\n").out).toBe(`//registry.npmjs.org/:_authToken=${h(1)}\n`);
    expect(run("file", "machine api.github.com login gading password ghp_secret123\n").out).toBe(`machine api.github.com login gading password ${h(1)}\n`);
    const pg = run("file", "192.0.2.10:5432:nougate:postgres:Harbor:With:Colon\n");
    expect(pg.out).toBe(`192.0.2.10:5432:nougate:postgres:${h(1)}\n`);
    expect(pg.swapped[0]![1]).toBe("Harbor:With:Colon");
  });

  test("a YAML file: `key: value`, not a URL's scheme or a block opener", () => {
    const { out: yaml } = run("file", "database:\n  password: hunter2\n  url: https://example.com\nlist: |\n");
    expect(yaml).toBe(`database:\n  password: ${h(1)}\n  url: ${h(2)}\nlist: |\n`);
    expect(run("file", "see https://example.com/docs\n").out).toBe("see https://example.com/docs\n");
  });

  test("a certificate's base64 padding is not a key set to `=`", () => {
    expect(run("file", "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA==\n").swapped).toEqual([]);
  });
});

describe("an environment dump", () => {
  test("`env` / `printenv`: KEY=value lines, read as a file's", () => {
    const { out, swapped } = run("env", "HOME=/root\nPATH=/usr/bin:/bin\nSHLVL=1\nAPP_HOME=/srv/app\nAPI_KEY=k-123\n");
    // What the shell sets for itself stays — a handle for HOME would mask every path under it — and everything else goes.
    expect(out).toBe(`HOME=/root\nPATH=/usr/bin:/bin\nSHLVL=1\nAPP_HOME=${h(1)}\nAPI_KEY=${h(2)}\n`);
    expect(swapped.map(([key]) => key)).toEqual(["APP_HOME", "API_KEY"]);
  });

  test("`docker inspect`: each `KEY=value` of the Env list; ids and other strings stay", () => {
    const inspect = '[\n  {\n    "Id": "4f3a9c",\n    "Config": {\n      "Env": [\n        "DB_PASSWORD=hunter2",\n        "PORT=80"\n      ]\n    }\n  }\n]\n';
    const { out, swapped } = run("docker-inspect", inspect);
    expect(out).toContain(`"DB_PASSWORD=${h(1)}"`);
    expect(out).toContain('"PORT=80"');
    expect(out).toContain('"Id": "4f3a9c"');
    expect(swapped).toEqual([["DB_PASSWORD", "hunter2"]]);
  });
});

describe("a Kubernetes Secret", () => {
  test("YAML: the values under data and stringData, nothing else — and the copy in the annotation", () => {
    const yaml = [
      "apiVersion: v1",
      "data:",
      "  password: aHVudGVyMg==",
      "  username: YWRtaW4=",
      "kind: Secret",
      "metadata:",
      "  annotations:",
      '    kubectl.kubernetes.io/last-applied-configuration: |',
      '      {"apiVersion":"v1","data":{"password":"aHVudGVyMg=="},"kind":"Secret"}',
      "  name: db",
      "stringData:",
      "  token: plain-token",
      "type: Opaque",
      "",
    ].join("\n");
    const { out, swapped } = run("kube-secret", yaml);
    expect(out).toContain(`  password: ${h(1)}\n  username: ${h(2)}\nkind: Secret\n`);
    expect(out).toContain(`{"apiVersion":"v1","data":{"password":"${h(3)}"},"kind":"Secret"}`);
    expect(out).toContain("  name: db\n");
    expect(out).toContain(`  token: ${h(4)}\ntype: Opaque\n`);
    expect(swapped.map(([, value]) => value)).toEqual(["aHVudGVyMg==", "YWRtaW4=", "aHVudGVyMg==", "plain-token"]);
  });

  test("JSON: the values inside the data object", () => {
    const json = '{\n    "apiVersion": "v1",\n    "data": {\n        "password": "aHVudGVyMg=="\n    },\n    "kind": "Secret"\n}\n';
    const { out, swapped } = run("kube-secret", json);
    expect(out).toContain(`"password": "${h(1)}"`);
    expect(out).toContain('"kind": "Secret"');
    expect(swapped).toHaveLength(1);
  });
});

describe("a template, and the shapes", () => {
  test("`.env.example` keeps its placeholders; only what has a secret's shape goes", () => {
    const { out, swapped } = run("template", "API_KEY=your-key-here\nDB_URL=postgres://user:pass2024x@db:5432/app\n");
    expect(out).toContain("API_KEY=your-key-here\n");
    expect(out).toContain(`DB_URL=postgres://user:${h(1)}@db:5432/app\n`);
    expect(swapped).toEqual([["a password in a URL", "pass2024x"]]);
  });

  test("a URL's password goes whatever its shape, on a line that is no assignment", () => {
    const { out } = run("env", "connecting to postgres://postgres:HarborLight2404@192.0.2.10:5432/nougate\n");
    expect(out).toBe(`connecting to postgres://postgres:${h(1)}@192.0.2.10:5432/nougate\n`);
  });
});

describe("plainValue", () => {
  test("what stays, and what does not", () => {
    for (const value of ["", "5432", "-1", "true", "OFF", "production", "warning", "${HOME}", "$HOME", "[REDACTED:TOKEN]", "$TMP_SECRET_0123456789AB", "=="]) expect(plainValue(value)).toBe(true);
    for (const value of ["hunter2", "abc", "1.5", "prod", "postgres://u:p@h/db", "null"]) expect(plainValue(value)).toBe(false);
  });
});
