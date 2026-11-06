/**
 * Credential files: what `read` and `grep` show of them, and what `send_file` will not send.
 *
 * The file tools reach every project an agent works in, and projects carry `.env` files; HOME carries
 * `.npmrc`, `.netrc`, cloud CLI logins and ssh keys. A value read into the conversation is in the
 * transcript, the provider's request log and every later turn — and `send_file` put a file's raw bytes
 * on a chat platform, where nothing masks anything.
 *
 * So a credential file is read with its secret values hidden and everything else intact: which keys are
 * set, how the config is laid out, the URL without its password. That is what nearly every task needs,
 * and a command that needs a value uses it without printing it (`set -a; . ./.env; set +a; …`). Hidden
 * rather than refused, deliberately: a refusal is what sent agents to `exec cat` in the first place, and
 * a guard that only moves the read somewhere less careful has made things worse.
 *
 * Nothing here asks. `read`, `glob` and `grep` run in parallel because they never reach approval
 * (`executor/tool-batching.ts`), so a guard on them can only hide or refuse — and it holds at every
 * approval level, `trusted` included, because it gives nothing up that a task needs.
 *
 * Nouride's own trust anchors are the one refusal: the secret store, the control token and the
 * credentials directory hold nothing but secrets, and no task needs them read.
 *
 * A command is a wider door than a file tool, and it is held in two ways (0.7.17). One that names the store or the
 * control token is refused at every approval level (`ownSecretNamed`). The credentials directory is not refused —
 * commands use its files by path, which is what it is for — but what those files hold is masked out of every tool's
 * result and everything that leaves the daemon, as the store's values are (`ownSecretValues`).
 */

import { commandSegments, looseSegments } from "@nouride/policy";
import { basename, isAbsolute, join, listDir, normalize, readTextFileSync, relative, statFile } from "@nouride/runtime";

export type CredentialKind = "own" | "env" | "credential";

/** This daemon's own: refused outright by `read` and `send_file`. */
const OWN = [/(^|\/)\.nouride\/data\/secrets\.json$/, /(^|\/)\.control-token$/, /(^|\/)\.?credentials\/./];

const CONFIG_FORMAT = /\.(json|ya?ml|toml|ini|conf|cfg)$/i;
const ENV = /(^|\/)([^/]*\.env(\.[^/]+)?|\.envrc)$/;
/** Committed on purpose, with placeholders in them: what a project tells you to fill in. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/;

const CREDENTIAL = [
  /(^|\/)[._]netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.(npmrc|pypirc|vault-token)$/,
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)gh\/hosts\.yml$/,
  /(^|\/)rclone\.conf$/,
  // libpq's password file: `host:port:db:user:password`, one per line.
  /(^|\/)\.pgpass$/,
  // A cloud service account's key, as the consoles name the download.
  /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i,
  // `credentials` on its own — AWS's, and the many tools that copied it — and `secrets.env`, `secrets.txt`.
  /(^|\/)credentials$/,
  /(^|\/)secrets?\.(env|txt|properties)$/i,
  // A key and its certificate in one archive: PKCS#12.
  /\.(p12|pfx)$/i,
  /**
   * A config file named for what it holds: `auth.json`, `.credentials.json` (Claude Code),
   * `oauth_creds.json` (Gemini CLI), `application_default_credentials.json` (gcloud), `client_secret.json`.
   * The coding CLIs keep their logins like this in HOME, and HOME is readable by path. Masking goes by
   * key, so a near miss such as `author.json` loses nothing it should show.
   */
  /(^|\/)[^/]*(auth|creds?|credentials?|tokens?|secrets?)[^/]*\.(json|ya?ml|toml|ini|conf|cfg)$/i,
  /\.tfvars(\.json)?$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
  /\.(pem|key)$/,
];

/**
 * `[security] credentials_dir`, wherever the operator put it — set once at boot (`childEnvFor`).
 *
 * The name patterns above catch the default and the usual `.credentials`; this catches a directory
 * called anything at all, which matters now that HOME is readable by path and is where one might live.
 */
let credentialsDir: string | null = null;

export function setCredentialsDir(dir: string): void {
  credentialsDir = dir.replace(/\/+$/, "");
}

/** `[daemon] data_dir`, set once at boot: where the store and the control token are, wherever the operator put them. */
let dataDir: string | null = null;

export function setDataDir(dir: string): void {
  dataDir = dir.replace(/\/+$/, "");
}

export function credentialKind(path: string): CredentialKind | null {
  if (OWN.some((pattern) => pattern.test(path))) return "own";
  if (credentialsDir && path.startsWith(`${credentialsDir}/`)) return "own";
  if (ENV.test(path) && !ENV_TEMPLATE.test(path)) return "env";
  return CREDENTIAL.some((pattern) => pattern.test(path)) ? "credential" : null;
}

export function ownSecretRefusal(raw: string): string {
  return (
    `\`${raw}\` is one of Nouride's own secrets (the secret store, the control token or the credentials directory). ` +
    "No task needs it read: a command gets a credential through the agent's `exec_secrets`, or by path from `$NOURIDE_CREDENTIALS_DIR`."
  );
}

/** Why `send_file` will not send one: bytes on a chat platform cannot be masked. */
export function credentialSendRefusal(raw: string): string {
  return (
    `\`${raw}\` holds credentials, and a file sent to a chat goes as it is: nothing can mask it there. ` +
    "If the person needs it, tell them where it is on this machine. If they need what is in it, send a copy" +
    " without the values (`sed -E 's/=.+/=<set>/' .env > \"$TMPDIR/env-names.txt\"`)."
  );
}

/**
 * Words that make a key's value a secret — matched on the words of the name, so `AUTHOR` and
 * `SESSION_TIMEOUT` stay readable while `authToken`, `DB_PASSWORD` and kube's `client-key-data` do not.
 */
const SECRET_WORDS = new Set(["pass", "password", "passwd", "passphrase", "pwd", "secret", "token", "apikey", "key", "auth", "credential", "credentials", "cookie", "signature", "salt", "bearer", "dsn", "private", "jwt"]);

function keyWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
}

function isSecretKey(name: string): boolean {
  return keyWords(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * A plain address under a name for one — `token_uri`, `AUTH_URL` — is where a credential is sent, not the credential:
 * Google's login files carry three, the same for every account, and taken for secrets they were masked out of every
 * mention of Google's sign-in. One with a password, a query or a fragment in it is not plain.
 */
function isAddress(key: string, value: string): boolean {
  return ["uri", "url", "uris", "urls", "endpoint"].includes(keyWords(key).at(-1) ?? "") && /^[a-z][a-z0-9+.-]*:\/\/[^\s@?#]+$/i.test(value);
}
/** A value that is plainly not a secret yet: empty, a reference to another variable, a placeholder. */
const PLACEHOLDER = /^(|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|x{3,}|\*+|changeme|your[-_].*|null|none|true|false)$/i;
/** `KEY=value` (the key may hold a colon, as `.npmrc`'s `//host/:_authToken` does), then `key: value`. */
const ASSIGNMENTS = [/^(\s*(?:export\s+)?["']?([^\s"'=#]+?)["']?\s*=\s*)(.*)$/, /^(\s*["']?([^\s"'=:#]+)["']?\s*:\s*)(.*)$/];

/**
 * The file with its secret values hidden, and a line saying how many — or the text unchanged when it is
 * not a credential file. Line count is kept, so an `offset` the agent computes still lands where it meant.
 */
export function maskCredentials(path: string, text: string): { text: string; note: string } {
  return hideValues(path, text);
}

/**
 * The secret values a credential file holds, read the way `maskCredentials` hides them — what a command that names the
 * file is masked of (`valuesForCommand`), so `cat .env` through `exec` shows what `read` shows.
 */
export function credentialValues(path: string, text: string): string[] {
  const values: string[] = [];
  hideValues(path, text, (value) => values.push(value));
  return values;
}

/**
 * Every value of every credential file a command names, by a label that says where it came from (`.env#1`) — read
 * here, for the command's output to be masked of them (`exec`). The words of its command line are tried as paths, the
 * way the classifier finds one (`classifySensitivePath`): `cat .env`, `. ./.env`, `python3 -c "open('.env')"`. A file
 * that is not there, or too big to be one, gives nothing.
 */
export function valuesForCommand(argv: readonly string[], cwd: string, home?: string): Record<string, string> {
  const values: Record<string, string> = {};
  // Relative to where it runs, and to wherever it `cd`s first: `cd app && cat .env` reads app's.
  const bases = [cwd, ...workingDirs(argv, cwd, home)];
  for (const word of commandWords(argv)) {
    for (const path of new Set(bases.map((base) => pathFrom(base, word, home)))) {
      const kind = credentialKind(path);
      const size = kind === "env" || kind === "credential" ? statFile(path)?.size : undefined;
      if (size === undefined || size > 256 * 1024) continue;
      credentialValues(path, readTextFileSync(path)).forEach((value, index) => (values[`${basename(path)}#${index + 1}`] = value));
    }
  }
  return values;
}

/**
 * What a word of a command line names, by its name alone — no disk asked, since the file may be on another host
 * (`ssh box "cat /srv/app/.env"`, 2026-10-21). `file` for a credential file, `template` for an env file that only shows
 * what to fill in (`.env.example`), null for anything else. An env file only by its own name — `.env`, `.env.production`
 * — and not `process.env` in a script: `read` can ask the disk whether `prod.env` is a file; a name elsewhere cannot.
 */
export function namedCredential(word: string): "file" | "template" | null {
  if (ENV_FILE_NAME.test(word)) return ENV_TEMPLATE.test(word) ? "template" : "file";
  // Not `credentialKind` alone: it reads `secrets.env` as an env file first, and an env file goes by the rule above.
  return credentialKind(word) === "own" || CREDENTIAL.some((pattern) => pattern.test(word)) ? "file" : null;
}

const ENV_FILE_NAME = /(^|\/)(\.env(\.[^/]+)?|\.envrc)$/;

/** A path as a shell would read it from `base`. */
export function pathFrom(base: string, word: string, home?: string): string {
  return word.startsWith("~/") && home ? join(home, word.slice(2)) : isAbsolute(word) ? word : join(base, word);
}

/** Every directory a command moves into with `cd` or `pushd`, in order — what its later words are relative to. */
function workingDirs(argv: readonly string[], cwd: string, home?: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (const segment of commandSegments(argv) ?? looseSegments(argv)) {
    if ((segment[0] === "cd" || segment[0] === "pushd") && segment[1] && segment[1] !== "-") dirs.push((dir = pathFrom(dir, segment[1], home)));
  }
  return dirs;
}

/** The words of a command line that could be paths — inside a `-c` script too, split where a path cannot go on. */
export function commandWords(argv: readonly string[]): string[] {
  return [...new Set(argv.join(" ").split(/[\s"'`;&|<>(){}=,@]+/))].filter((word) => word && !word.startsWith("-"));
}

/**
 * The store (plain until 0.8.19, encrypted since), a copy of it beside it (`secrets.json.bak-…`), its key where the
 * daemon or `install.sh` keeps one, and the control token, by the default layout's names.
 */
const OWN_SECRET_NAMES = [
  /(^|\/)\.control-token$/,
  /(^|\/)\.nouride\/data\/secrets\.(json|enc)(\.[^/]*)?$/,
  /(^|\/)\.nouride\/encryption\.key$/,
  /^\/etc\/nouride\/nouride\.env$/,
];

/**
 * The word of a command that names one of this daemon's own secrets — the store, a copy of it, the control token — or
 * null (0.7.17). `exec` refuses such a command at every approval level, `trusted` included: the store holds every
 * credential the daemon has and the token is the key to its control API, so no task needs either read, and a prompt for
 * one would only teach a person to wave it through. Found as `valuesForCommand` finds a credential file — each word as a
 * path, from where the command runs and wherever it `cd`s, and `$HOME` read as `~` — and by name for the default
 * layout. A path a script builds as it runs gets past this, as it gets past every check on a command line; what the
 * store holds is masked out of every tool's result regardless (`ownSecretValues`, `tools/registry.ts`).
 */
export function ownSecretNamed(argv: readonly string[], cwd: string, home?: string): string | null {
  const bases = [cwd, ...workingDirs(argv, cwd, home)];
  for (const word of commandWords(argv.map((arg) => arg.replace(/\$\{HOME\}|\$HOME\b/g, "~")))) {
    if (OWN_SECRET_NAMES.some((pattern) => pattern.test(word))) return word;
    if (bases.some((base) => isOwnSecretFile(pathFrom(base, word, home)))) return word;
  }
  return null;
}

function isOwnSecretFile(path: string): boolean {
  if (!dataDir) return false;
  const name = relative(dataDir, normalize(path));
  return name === ".control-token" || /^secrets\.(json|enc)(\.[^/]*)?$/.test(name) || name === join("..", "encryption.key") || normalize(path) === "/etc/nouride/nouride.env";
}

export function ownSecretCommandRefusal(raw: string): string {
  return (
    `\`${raw}\` is one of Nouride's own secrets (the secret store, its key or the control token), which no command may read, at any approval level. ` +
    "A command uses a credential by name instead: the agent's `exec_secrets`, a `$TMP_SECRET_…` handle, or a file in `$NOURIDE_CREDENTIALS_DIR`"
  );
}

/**
 * Every secret value in the files this daemon keeps its own in — the control token, and each file in the credentials
 * directory — by a label that says where it came from (`tokens.json#2`): what every tool's result and everything that
 * leaves the daemon is masked of, with the store's values (0.7.17). A command may use these files by path; what it
 * prints of them comes back masked. A file is read again only when it changes — an OAuth cache is rewritten on every
 * refresh, and the new token is the one to mask.
 */
export function ownSecretValues(): Record<string, string> {
  const values: Record<string, string> = {};
  const files = [...(dataDir ? [join(dataDir, ".control-token")] : []), ...(credentialsDir ? filesUnder(credentialsDir, 3) : [])];
  for (const path of files) valuesOfFile(path).forEach((value, index) => (values[`${basename(path)}#${index + 1}`] = value));
  return values;
}

const fileValues = new Map<string, { stamp: string; values: string[] }>();

/** What one of those files holds, read as a credential file whatever it is called: the directory says it is one. */
function valuesOfFile(path: string): string[] {
  const stat = statFile(path);
  if (!stat || stat.isDirectory || stat.size > 256 * 1024) return [];
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = fileValues.get(path);
  if (cached?.stamp === stamp) return cached.values;
  const values: string[] = [];
  try {
    hideValues(path, readTextFileSync(path), (value) => values.push(value), ENV.test(path) ? "env" : "credential");
  } catch {
    // Unreadable to the daemon is unreadable to its commands too: nothing of it can come back.
  }
  fileValues.set(path, { stamp, values });
  return values;
}

/** The files under a directory, a few levels down and a few hundred at most: a credentials directory is small. */
function filesUnder(dir: string, depth: number): string[] {
  const files: string[] = [];
  for (const entry of listDir(dir)) {
    if (files.length >= 256) break;
    const path = join(dir, entry.name);
    if (!entry.isDirectory) files.push(path);
    else if (depth > 1) files.push(...filesUnder(path, depth - 1));
  }
  return files;
}

function hideValues(path: string, text: string, seen?: (value: string) => void, kind = credentialKind(path)): { text: string; note: string } {
  if (kind === null || kind === "own") return { text, note: "" };
  let hidden = 0;
  const hide = (value: string) => {
    hidden += 1;
    seen?.(value);
    return `<hidden, ${value.length} chars>`;
  };

  let out = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, (block) => {
    hidden += 1;
    // The block, and each line of it: a print of part of a key is as much a leak as the whole. In a JSON file the key is
    // one string with its line breaks written `\n`, and a program that loads the file prints the key itself.
    const key = block.replace(/\\n/g, "\n").replace(/\\\//g, "/");
    for (const form of new Set([block, key])) seen?.(form);
    for (const line of key.match(/^(?!-----).{16,}$/gm) ?? []) seen?.(line);
    return block.replace(/^(?!-----).+$/gm, "[private key hidden]");
  });
  // `scheme://user:password@host`: the password, wherever it sits — an `.env` DSN, `.git-credentials`.
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]+)(@)/gi, (_m, head: string, secret: string, at: string) => `${head}${hide(secret)}${at}`);
  // JSON pairs wherever they are — a login file is often one minified line, which the line pass below,
  // reading `key: value` from the start of a line, never sees into.
  out = out.replace(/"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (whole, key: string, colon: string, value: string) =>
    isSecretKey(key) && !PLACEHOLDER.test(value) && !isAddress(key, value) ? `"${key}"${colon}"${hide(value)}"` : whole,
  );
  // `.netrc`: `machine x login y password z`, on one line or several.
  out = out.replace(/\b(password|passwd)(\s+)(\S+)/g, (whole, word: string, space: string, secret: string) =>
    secret.startsWith("<hidden") ? whole : `${word}${space}${hide(secret)}`,
  );

  out = out
    .split("\n")
    .map((line) => {
      const match = ASSIGNMENTS.map((pattern) => pattern.exec(line)).find((found) => found !== null);
      if (!match || /^\s*[#;]/.test(line) || !isSecretKey(match[2] ?? "")) return line;
      const value = match[3] ?? "";
      const quoted = /^(["'])(.*)\1(,?)\s*$/.exec(value);
      const bare = quoted ? (quoted[2] ?? "") : value.replace(/,\s*$/, "").trim();
      if (PLACEHOLDER.test(bare) || bare.startsWith("<hidden") || isAddress(match[2] ?? "", bare)) return line;
      return quoted ? `${match[1]}${quoted[1]}${hide(bare)}${quoted[1]}${quoted[3]}` : `${match[1]}${hide(bare)}${value.trimEnd().endsWith(",") ? "," : ""}`;
    })
    .join("\n");

  // A file that is one bare token — `.vault-token`, a key file — has no key name to go by. Not a config
  // format: a minified JSON file is one long word too, and its keys were read above.
  if (kind === "credential" && hidden === 0 && !CONFIG_FORMAT.test(path) && /^\s*\S{16,}\s*$/.test(out)) out = hide(out.trim());
  if (hidden === 0) return { text: out, note: "" };
  return {
    text: out,
    note:
      kind === "env"
        ? `\n[${hidden} secret value${hidden === 1 ? "" : "s"} hidden, so they stay out of this conversation. A command uses them without printing them: \`set -a; . ${path}; set +a; <command>\`.]`
        : `\n[${hidden} secret value${hidden === 1 ? "" : "s"} hidden, so they stay out of this conversation. The program that needs them reads this file itself.]`,
  };
}
