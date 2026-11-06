/**
 * What `nouride-pkg` is asked and what it answers — protocol 1, `root/nouride-pkg`.
 *
 * A request is one line: an operation and package names. The answer is the package manager's output,
 * a plan as `+ name` / `- name` lines, and a last line `@nouride-pkg ok|refused|failed <detail>`.
 *
 * The rules are the script's, not these: it runs as root and is the only thing that decides. The name
 * check here is the same rule, applied first so a bad name is refused with a clear sentence before a
 * connection is opened — never instead of the script's.
 *
 * Pure.
 */

/** The protocol this side speaks: the script's `PROTOCOL`, which its status answer carries as `protocol=1`. */
const PACKAGE_PROTOCOL = 1;

const PACKAGE_OPS = ["install", "remove", "upgrade"] as const;
export type PackageOp = (typeof PACKAGE_OPS)[number];

export type PackageRequest =
  | { op: "status" }
  | { op: "refresh" }
  /** `check`: what it would change, changing nothing. */
  | { op: PackageOp; names: readonly string[]; check?: boolean };

export interface PackageAnswer {
  status: "ok" | "refused" | "failed";
  detail: string;
  /** Installed or upgraded, from the plan. */
  installs: string[];
  removes: string[];
  /** Everything before the status line. */
  output: string;
}

export function isPackageOp(value: unknown): value is PackageOp {
  return typeof value === "string" && (PACKAGE_OPS as readonly string[]).includes(value);
}

/** The script's `valid_name`: lowercase letters, digits and `.+_-`, not ending in `-` or `+`. */
export function isPackageName(name: string): boolean {
  return name.length <= 100 && /^[a-z0-9][a-z0-9.+_-]*$/.test(name) && !/[-+]$/.test(name);
}

export function requestLine(request: PackageRequest): string {
  if (request.op === "status" || request.op === "refresh") return request.op;
  const words = [...(request.check ? ["check"] : []), request.op, ...request.names];
  return words.join(" ");
}

const STATUS_LINE = /^@nouride-pkg (ok|refused|failed)\b ?(.*)$/;

/**
 * An answer with no status line is a failure: the process died, or something else is listening on
 * the socket. Never read as success because the output looked like an install.
 */
export function parseAnswer(text: string): PackageAnswer {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const last = lines[lines.length - 1] ?? "";
  const match = STATUS_LINE.exec(last);
  const body = match ? lines.slice(0, -1) : lines;
  return {
    status: match ? (match[1] as PackageAnswer["status"]) : "failed",
    detail: match ? match[2]! : "no answer from nouride-pkg: it stopped before finishing",
    installs: body.filter((line) => line.startsWith("+ ")).map((line) => line.slice(2)),
    removes: body.filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
    output: body.join("\n"),
  };
}

/**
 * A status answer from a service that speaks another protocol, as the refusal it is.
 *
 * The root script is installed by `install.sh` and not replaced by `nouride update`, which runs as the service user
 * and cannot write where it lives — so a daemon that updated itself can meet an older script, or a rollback a newer
 * one. A request the other side would read another way is not sent; the person is told what puts them in step.
 */
export function agreed(status: PackageAnswer): PackageAnswer {
  if (status.status !== "ok") return status;
  const spoken = /\bprotocol=(\d+)/.exec(status.detail)?.[1];
  if (spoken === String(PACKAGE_PROTOCOL)) return status;
  return {
    ...status,
    status: "refused",
    detail:
      `the package service on this box speaks protocol ${spoken ?? "(none named)"}, and this daemon ${PACKAGE_PROTOCOL}: ` +
      "re-run install.sh with --allow-packages to bring it in step (`nouride update` cannot: it runs as the service user)",
  };
}

/** `protocol=1 backend=apt` from a status answer's detail. */
export function backendOf(answer: PackageAnswer): string | null {
  return answer.status === "ok" ? (/\bbackend=(\S+)/.exec(answer.detail)?.[1] ?? null) : null;
}
