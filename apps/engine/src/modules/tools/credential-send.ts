/**
 * A credential file sent off this machine (0.7.17): the command asks first, under the agent's secret guard.
 *
 * `scp .env server:`, `curl -F file=@.env …`, `gh gist create .env`: each puts what the file holds somewhere nothing of
 * Nouride's reaches, where masking means nothing. Rare in real work and real when it happens — a deploy that copies an
 * `.env` across — so it asks, once, at every approval level: the question `tools/held-secrets.ts` asks for a credential
 * sent in chat, which is the switch that turns both off. A commit or a push is `git-guard.ts`'s.
 */

import { join } from "@nouride/runtime";
import { commandSegments, looseSegments } from "@nouride/policy";
import type { GateAsk } from "@nouride/shared";
import { credentialKind } from "@/modules/tools/credential-files.ts";

/** Programs that send a file they are given somewhere else, and the subcommand that does it where there is one. */
const SENDERS: Readonly<Record<string, readonly string[] | null>> = {
  scp: null,
  sftp: null,
  rsync: null,
  rclone: null,
  curl: null,
  wget: null,
  nc: null,
  ncat: null,
  netcat: null,
  socat: null,
  gh: ["gist", "release"],
  aws: ["s3"],
  gsutil: ["cp", "rsync"],
  kubectl: ["cp"],
};

/** The credential file a command sends off this machine, or null. */
export function credentialSent(argv: readonly string[], cwd: string): string | null {
  for (const segment of commandSegments(argv) ?? looseSegments(argv)) {
    const program = segment[0]?.replace(/^.*\//, "") ?? "";
    const subcommands = SENDERS[program];
    if (subcommands === undefined) continue;
    if (subcommands && !subcommands.includes(segment[1] ?? "")) continue;
    for (const word of sentWords(program, segment.slice(1))) {
      const kind = credentialKind(word.startsWith("/") ? word : join(cwd, word));
      if (kind === "env" || kind === "credential") return word;
    }
  }
  return null;
}

/**
 * The local files a command hands over. curl and wget take one only where it uploads — `-F f=@.env`, `-d @.env`,
 * `-T .env`, `--post-file=.env` — since a URL or `-o .env` is a download; the others take any path that is not on
 * another machine (`server:/x/.env`) or an address.
 */
function sentWords(program: string, args: readonly string[]): string[] {
  if (program === "curl" || program === "wget") {
    return args.flatMap((arg, i) => {
      const uploaded = arg.match(/@([^;,\s]+)/)?.[1];
      if (uploaded) return [uploaded];
      if (["-T", "--upload-file"].includes(args[i - 1] ?? "")) return [arg];
      return arg.match(/^--(?:post|body)-file=(.+)$/)?.slice(1) ?? [];
    });
  }
  return args.filter((arg) => !arg.startsWith("-") && !arg.includes("://") && !/^[\w.@-]+:/.test(arg));
}

/** The question for it: the secret guard's — no grant covers it, and of the levels only `trusted` answers it. */
export function credentialSendAsk(file: string): GateAsk {
  return {
    action: "ask",
    grantable: false,
    hardline: true,
    hardlineClass: "credential-out",
    reason: `it sends \`${file}\`, which holds credentials, off this machine`,
  };
}
