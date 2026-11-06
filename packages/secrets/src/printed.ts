/**
 * The output of a command that prints a credential file or an environment, with every value in it swapped out.
 *
 * Found live (2026-10-21): `ssh proxmox "pct exec 106 -- cat /root/nougate/.env"` printed a database URL with its
 * password into the conversation and the stored session. The daemon masks the values it knows — the store, the handles,
 * a local file a command names — and a file on another host is none of those. Its *name* is in the command line all the
 * same, so the engine reads such a command's output as that file (`tools/credential-output.ts`) and hands it through
 * here, where each value goes to `swap`: a `$TMP_SECRET_…` handle the agent can still use in a command, or a mask
 * where there is no conversation to hold one in.
 *
 * What a line gives up depends on what printed it (`PrintedKind`):
 * - a credential file or an environment dump: the value of every `KEY=value`, `export KEY=…`, `KEY: value`,
 *   `key = value` and JSON `"key": "value"` line — whatever it looks like, because `PASSWORD=hunter2` has no shape a
 *   pattern could know. Only a value that is plainly not a secret stays (`plainValue`), so debugging still works;
 * - `docker inspect`: each `"KEY=value"` of an `Env` list;
 * - `kubectl get secret -o yaml|json`: the values under `data:` and `stringData:`, inline ones in an annotation too;
 * - a template (`.env.example`): nothing by its key — those are placeholders — only what the shapes find.
 * Every kind: a private key block whole, then `findSecrets` over the rest — a password in a URL, a token by its prefix.
 *
 * Keys, comments and layout stay: which variables are set, the host, the port is what nearly every task needs.
 */

import { findSecrets } from "./scan.ts";

export type PrintedKind = "file" | "env" | "docker-inspect" | "kube-secret" | "template";

/** What a value is replaced with. `key` names it: the variable, or `private key`. */
export type Swap = (value: string, key: string) => string;

/**
 * A value that is plainly not a secret, left as printed so a person debugging can still read it: empty, a reference
 * to another variable, a whole number, a yes or a no, a handful of environment words — and what is already a handle or
 * a mask. Everything else goes: a password under an innocent key name must not leak.
 */
export function plainValue(value: string): boolean {
  return (
    value === "" ||
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value) ||
    /^-?\d+$/.test(value) ||
    // Base64 padding: a certificate's line `MIIB…AB==` is not a key `MIIB…AB` set to `=`.
    /^=+$/.test(value) ||
    /^(true|false|yes|no|on|off|production|development|staging|test|local|debug|info|warn|warning|error)$/i.test(value) ||
    // Already swapped — a key inside a JSON string goes first, and the string around its handle or mask is no secret.
    /\$TMP_SECRET_[0-9A-F]{12}|\[REDACTED:[^\]]*\]/.test(value)
  );
}

/**
 * Variables every shell sets for itself, whose values say where things are — never a credential. Kept as printed so an
 * `env` stays readable, and not held: a handle for `HOME` would mask every later path under it.
 */
const SYSTEM_KEYS = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "HOSTNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHLVL", "TMPDIR", "EDITOR", "PAGER", "_"]);

/** `KEY=value`, `export KEY=value`, `key = value` — a key with no space in it, then `=`. `.npmrc`'s `//host/:_authToken=` too. */
const EQUALS = /^(\s*(?:export\s+)?["']?([A-Za-z_][\w.-]*|\/\/[^\s="']+)["']?\s*=\s*)(.*?)(\s*)$/;
/** `KEY: value` — YAML's: a space after the colon, so `https://…` and `host:5432` are not one. */
const COLON = /^(\s*(?:-\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*:\s+)(.*?)(\s*)$/;
/** `"key": "value"`, wherever it sits — a login file is often one minified line. */
const JSON_PAIR = /"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/** libpq's `.pgpass`: `host:port:database:user:password`. */
const PGPASS = /^([^:\s]+:[^:\s]+:[^:\s]+:[^:\s]+:)(\S.*)$/;
/** `.netrc`: `machine x login y password z`. */
const NETRC = /\b(password|passwd)(\s+)(\S+)/g;
/** `docker inspect`'s `"Env": ["KEY=value", …]`. */
const ENV_STRING = /"([A-Za-z_][A-Za-z0-9_]*)=((?:[^"\\]|\\.)*)"/g;
/** `kubectl`'s `data:` / `"data": {` — the start of what a Secret holds. */
const KUBE_SECTION = /^(\s*)"?(?:data|stringData)"?\s*:\s*\{?\s*$/;
/** The same, written inline: the `last-applied-configuration` annotation carries the whole Secret as one line of JSON. */
const KUBE_INLINE = /("(?:data|stringData)"\s*:\s*\{)([^{}]*)(\})/g;
const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_INLINE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
/** A line this long with no newline is let go as it is, rather than held for a newline that may never come. */
const MAX_HELD = 64 * 1024;

const unquote = (value: string): { quote: string; inner: string } => {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? { quote: quoted[1]!, inner: quoted[2]! } : { quote: "", inner: value };
};

/** What JSON text means — a `\n` in a key file's string is a newline in the key. As written when it does not parse. */
function jsonText(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Streams output through, a line at a time: a value is decided once its line — or its key block — is whole. */
export class PrintedCredentials {
  private carry = "";
  /** The lines of a private key so far, while inside one. */
  private key: string[] | null = null;
  /** Inside a Secret's `data:`, the indent its header had. */
  private section: number | null = null;

  constructor(
    private readonly kind: PrintedKind,
    private readonly swap: Swap,
  ) {}

  push(text: string): string {
    const buffer = this.carry + text;
    const cut = buffer.lastIndexOf("\n") + 1;
    if (cut === 0 && buffer.length < MAX_HELD) {
      this.carry = buffer;
      return "";
    }
    const whole = cut === 0 ? buffer : buffer.slice(0, cut);
    this.carry = cut === 0 ? "" : buffer.slice(cut);
    return this.lines(whole);
  }

  /** What is left: a last line with no newline, and a key block the output stopped inside of. */
  end(): string {
    const rest = this.carry;
    this.carry = "";
    let out = rest ? this.lines(rest) : "";
    if (this.key) {
      out += this.swap(this.key.join("\n"), "private key");
      this.key = null;
    }
    return out;
  }

  /** Each line with its own newline, so the lines a key block takes go with theirs. */
  private lines(text: string): string {
    const segments = text.split("\n");
    let out = "";
    segments.forEach((line, index) => {
      const last = index === segments.length - 1;
      // What follows the last newline: nothing, or — from `end` — a line that never got one.
      if (last && line === "") return;
      const newline = last ? "" : "\n";
      if (this.key) {
        this.key.push(line);
        if (PEM_END.test(line)) {
          out += this.swap(this.key.join("\n"), "private key") + newline;
          this.key = null;
        }
        return;
      }
      const begins = line.search(PEM_BEGIN);
      if (begins !== -1 && !PEM_END.test(line)) {
        out += line.slice(0, begins);
        this.key = [line.slice(begins)];
        return;
      }
      out += this.line(line) + newline;
    });
    return out;
  }

  private line(line: string): string {
    let out = line.replace(PEM_INLINE, (block) => this.swap(block.replace(/\\n/g, "\n"), "private key"));
    if (this.kind === "file" || this.kind === "env") out = this.assignment(out);
    else if (this.kind === "docker-inspect") out = out.replace(ENV_STRING, (whole, key: string, raw: string) => (plainValue(jsonText(raw)) ? whole : `"${key}=${this.swap(jsonText(raw), key)}"`));
    else if (this.kind === "kube-secret") out = this.secret(out);
    return this.shapes(out);
  }

  /** One line of a credential file or an environment: its value, by its key. */
  private assignment(line: string): string {
    if (/^\s*[#;]/.test(line)) return line;
    const pgpass = PGPASS.exec(line);
    if (pgpass && !line.includes("=") && !line.includes('"')) return pgpass[1] + this.swap(pgpass[2]!, "password");
    let pairs = 0;
    const json = line.replace(JSON_PAIR, (whole, key: string, colon: string, raw: string) => {
      pairs += 1;
      return plainValue(jsonText(raw)) ? whole : `"${key}"${colon}"${this.swap(jsonText(raw), key)}"`;
    });
    if (pairs > 0) return json;
    const assigned = EQUALS.exec(line) ?? COLON.exec(line);
    if (assigned) {
      const [, head = "", key = "", written = "", spaces = ""] = assigned;
      // A pretty-printed JSON line, `"port": 5432,`: its comma is not part of the value.
      const comma = written.endsWith(",") && head.trimStart().startsWith('"') ? "," : "";
      const value = comma ? written.slice(0, -1) : written;
      const trailing = comma + spaces;
      const { quote, inner } = unquote(value);
      // A YAML `- item`, a `{` that opens a block: not a value.
      if (plainValue(inner) || /^[{[|>]$/.test(inner) || SYSTEM_KEYS.has(key)) return line;
      return `${head}${quote}${this.swap(inner, key.replace(/^.*[/:]/, "") || key)}${quote}${trailing}`;
    }
    return line.replace(NETRC, (whole, word: string, space: string, value: string) => (plainValue(value) ? whole : `${word}${space}${this.swap(value, "password")}`));
  }

  /** One line of `kubectl get secret`: the values under `data:` and `stringData:`. */
  private secret(line: string): string {
    if (this.section !== null && line.trim() !== "" && (/^\s*/.exec(line)?.[0].length ?? 0) <= this.section) this.section = null;
    const header = KUBE_SECTION.exec(line);
    if (header) {
      this.section = header[1]!.length;
      return line;
    }
    if (this.section !== null) return this.assignment(line);
    return line.replace(KUBE_INLINE, (_whole, open: string, body: string, close: string) =>
      open + body.replace(JSON_PAIR, (whole, key: string, colon: string, raw: string) => (plainValue(jsonText(raw)) ? whole : `"${key}"${colon}"${this.swap(jsonText(raw), key)}"`)) + close,
    );
  }

  /** What `findSecrets` knows by shape — a password in a URL, a token by its prefix — in what the rules above left. */
  private shapes(line: string): string {
    let out = "";
    let at = 0;
    for (const match of findSecrets(line, "ingress")) {
      if (match.value.startsWith("$TMP_SECRET_") || match.value.startsWith("[REDACTED:")) continue;
      out += line.slice(at, match.start) + this.swap(match.value, match.pattern.label);
      at = match.end;
    }
    return out + line.slice(at);
  }
}
