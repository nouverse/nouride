/**
 * A command that prints credentials — a credential file, here or on another host, or an environment — and what its
 * output becomes: every value a `$TMP_SECRET_…` handle, held for its conversation the way a credential sent in chat is
 * (`tools/held-secrets.ts`). So the agent can still use one, `psql "$TMP_SECRET_…"`, and never sees it.
 *
 * Found live (2026-10-21): `ssh host "cat /srv/app/.env"` put a database password into the
 * conversation and the stored session. Never refused, by design: the agent needs to know which variables are
 * set and where things point, and a refusal sends it to a less careful way of reading the same file. Masked instead,
 * in the output as it streams, before anything keeps it: the spill file, the result, the session, the record.
 *
 * Where there is no conversation to hold a handle in, the value is masked as `[REDACTED:<key>]` — never left.
 */

import { PrintedCredentials, type PrintedKind, type TransientSecrets } from "@nouride/secrets";
import type { TextFilter } from "@nouride/runtime";
import { plural, type ToolContext } from "@nouride/shared";
import { commandWords, namedCredential } from "./credential-files.ts";
import { secretScope } from "./held-secrets.ts";

/** What printed it: its kind, the file or command by name, and the host it was on when an `ssh` says. */
export interface PrintedSource {
  kind: PrintedKind;
  name: string;
  host?: string;
}

/** A segment of a command line that ends by printing the environment: `env`, `printenv`, `printenv HOME PATH`. */
const ENV_DUMP = /(?:^|\s)(printenv(?:\s+[A-Za-z_]\w*)*|env(?:\s+-[0-9A-Za-z-]+)*)\s*$/;
const DOCKER_INSPECT = /\b(?:docker|podman)\s+(?:container\s+)?inspect\b/;
const KUBE_SECRET = /\bkubectl\b[^;&|]*\bget\s+secrets?\b[^;&|]*(?:-o\s*|--output[=\s]+)(?:yaml|json)\b/;
/** `ssh`'s options that take a value: the host is the first word after them. */
const SSH_VALUE_OPTIONS = new Set(["-p", "-i", "-l", "-o", "-J", "-F", "-E", "-c", "-m", "-b", "-L", "-R", "-D", "-S", "-W", "-w", "-Q", "-O", "-B", "-e", "-I"]);
/** The password in `scheme://user:password@host` — what a URL value holds that must be masked in any piece of it. */
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:([^\s@/]+)@/i;

/**
 * What a command prints that is credentials, or null. Read from its words — a `-c` script, an `ssh host "…"`, a
 * `pct exec … --`, a `docker exec`, a `kubectl exec … --` and a `sudo` included, since all of it is text in argv.
 * A credential file first; an environment dump; `docker inspect`; a Kubernetes Secret; a template last — what only shows
 * what to fill in gets the shapes and nothing by its key.
 */
export function printedSource(argv: readonly string[]): PrintedSource | null {
  argv = argv.map(withoutWrittenHeredocs);
  const text = argv.join(" ");
  const host = sshHost(text);
  const at = (kind: PrintedKind, name: string): PrintedSource => ({ kind, name, ...(host ? { host } : {}) });
  // A word with a backslash is a pattern, not a path: `grep -iE 'credential|\.env|\.key|token'`, split at its `|`, gave
  // `\.key`, and every `key: value` line the command printed was masked — `git log`'s "feat: …" among them (2026-10-23).
  const words = commandWords(argv).filter((word) => !word.includes("\\"));
  const file = words.find((word) => namedCredential(word) === "file");
  if (file) return at("file", file);
  const dump = text.split(/[;&|\n"'`()]+/).map((segment) => ENV_DUMP.exec(segment.trim())?.[1]).find(Boolean);
  if (dump) return at("env", dump.split(/\s+/)[0]!);
  if (DOCKER_INSPECT.test(text)) return at("docker-inspect", "docker inspect");
  if (KUBE_SECRET.test(text)) return at("kube-secret", "kubectl get secret");
  const template = words.find((word) => namedCredential(word) === "template");
  return template ? at("template", template) : null;
}

/** A heredoc `cat` or `tee` writes to a file: `cat > f <<X`, `cat <<'X' > f`, `tee [-a] f <<X` — the delimiter. */
const WRITES_HEREDOC = /(?:^|[;&|]\s*)(?:cat\b[^\n<]*<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n|]*$|tee\s+(?:-a\s+)?[^\s<-][^\n<]*<<-?\s*(['"]?)([A-Za-z_]\w*)\3[^\n|]*$)/;

/**
 * A command line without the bodies of the heredocs it writes to files. Such a body is the file's text, not a path the
 * command reads: a flyer's LaTeX saying "credentials", written with `cat << 'EOF' > flyer.tex`, made `credentials` a
 * credential file, and every `note: …` line tectonic printed was masked (0.8.12, live). Only a body `cat` sends to a
 * file (`>` on its line) or `tee` writes: one piped to a shell or an interpreter, or fed to one, is a script, and its
 * words still count. The line that starts it stays, so a credential file a heredoc writes is still named.
 */
function withoutWrittenHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  const kept: string[] = [];
  let end: string | null = null;
  for (const line of command.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    kept.push(line);
    const heredoc = WRITES_HEREDOC.exec(line);
    if (heredoc && (heredoc[4] !== undefined || line.includes(">"))) end = heredoc[2] ?? heredoc[4] ?? null;
  }
  return kept.join("\n");
}

/** The host an `ssh` in the command line reaches, without its user — what a handle's label says the file was on. */
function sshHost(text: string): string | undefined {
  const tokens = text.split(/\s+/).map((token) => token.replace(/^["']+|["']+$/g, ""));
  const ssh = tokens.findIndex((token) => /(^|\/)ssh$/.test(token));
  if (ssh === -1) return undefined;
  for (let i = ssh + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (SSH_VALUE_OPTIONS.has(token)) i += 1;
    else if (!token.startsWith("-") && token) return token.replace(/^[^@]*@/, "");
  }
  return undefined;
}

/** Where its values came from, as a handle's label says it: `DB_URL in proxmox:/root/nougate/.env`. */
function labelFor(source: PrintedSource, key: string): string {
  if (source.kind === "file" || source.kind === "template") return `${key} in ${source.host ? `${source.host}:` : ""}${source.name}`;
  return `${key} from ${source.name}${source.host ? ` on ${source.host}` : ""}`;
}

export interface PrintedOutput {
  /** A filter for one stream of the output — stdout and stderr each take one; they share the handles and the count. */
  filter(): TextFilter;
  /** The line the result ends with, saying what was swapped and how to use it — null when nothing was. */
  note(): string | null;
}

/**
 * The filter for one command's output. `held` and the call's conversation hold the handles; `known` are the values the
 * daemon already masks by name — the store's, the agent's own — which keep that mask rather than gaining a handle.
 */
export function printedOutput(
  source: PrintedSource,
  o: { held: TransientSecrets | undefined; ctx: Pick<ToolContext, "gatewayId" | "chatId" | "senderId"> & Partial<Pick<ToolContext, "gateway" | "chatType">>; known: Record<string, string> },
): PrintedOutput {
  const scope = o.held && o.ctx.gatewayId && o.ctx.chatId ? secretScope(o.ctx) : null;
  const knownBy = new Map(Object.entries(o.known).filter(([, value]) => value.length >= 6).map(([name, value]) => [value, name]));
  const swapped = new Set<string>();
  const swap = (value: string, key: string): string => {
    const name = knownBy.get(value);
    if (name) return `[REDACTED:${name}]`;
    const out = scope && o.held ? o.held.hold(value, { scope, label: labelFor(source, key), from: o.ctx.senderId || "a command" }) : `[REDACTED:${key}]`;
    swapped.add(out);
    // A URL is masked only where it appears whole (`secret-mask.ts`: its start is every URL's start), so the password
    // inside it is held on its own too: `${DB_URL%%@*}` printed the scheme, the user and the password, and nothing
    // matched. Not counted in the note — it is the same credential, and no command needs its handle.
    const password = URL_PASSWORD.exec(value)?.[1];
    if (scope && o.held && password && password.length >= 4 && password !== value) {
      o.held.hold(password, { scope, label: `${labelFor(source, key)} (its password)`, from: o.ctx.senderId || "a command" });
    }
    return out;
  };
  const where = source.host ? `${source.host}:${source.name}` : source.name;
  return {
    filter: () => new PrintedCredentials(source.kind, swap),
    note: () => {
      if (swapped.size === 0) return null;
      const n = `${swapped.size} ${plural(swapped.size, "value")}`;
      // Said, because an agent that saw a commit message masked took the commit for broken and rewrote it (2026-10-23).
      const unchanged = "Only this output is masked: nothing the command read, wrote or committed was changed";
      return scope
        ? `[${n} from ${where} ${swapped.size === 1 ? "is" : "are"} held as $TMP_SECRET_… handles in this conversation for an hour: use them in a command, never print them; ask the person to keep one for good with secret_save. ${unchanged}]`
        : `[${n} from ${where} ${swapped.size === 1 ? "was" : "were"} masked: this run has no conversation to hold them in. ${unchanged}]`;
    },
  };
}
