/**
 * Whether a webhook can arrive from the internet (0.8.0, SMART_AUTOMATION §1.1).
 *
 * Most boxes sit behind a home router, where a call from GitHub or Stripe never arrives — and the Webhooks page said
 * nothing, so a person waited for something that would never come. Each hook now reads as one of three:
 *
 * - **local network only** — no public address is set (`[dashboard] public_url`), or the one set is on this network;
 * - **reachable** — a test sent through the public address reached this daemon;
 * - **unknown** — a public address is set, and no test through it has arrived.
 *
 * The test is the daemon posting to its own public address, carrying a word it is waiting for (`TEST_HEADER`). The
 * route counts what arrives with that word and answers without running the job (`hooks.ts`). Through a tunnel that is
 * a real trip out and back in. Behind port forwarding a router may not loop a box back to its own public address even
 * when the internet reaches it, so a test that does not arrive is unknown, not unreachable, and says why.
 */

import { randomToken } from "@nouride/runtime";
import type { Job, ReachTest } from "@nouride/shared";
import { classifyAddress } from "@/modules/tools/url-safety.ts";
import { webhookUrl } from "./hooks.ts";

/** The header a test carries. Its value is a word the daemon handed out for this test, so nothing else can pass as one. */
export const TEST_HEADER = "x-nouride-test";

/** How long a test waits for an answer. A tunnel's first request can take seconds; a minute would read as hung. */
const TEST_TIMEOUT_MS = 15_000;

/** How long a test's word is kept: past its own timeout, so one that arrives late is still counted, and no longer. */
const WORD_KEPT_MS = 60_000;

/** Why a forwarded port fails from inside: many routers do not loop a box back to its own public address. */
const LOOPBACK_HINT =
  "A box behind a home router often cannot reach its own public address even when the internet can; a tunnel such as " +
  "Cloudflare Tunnel or Tailscale Funnel does not have that problem.";

/**
 * A name the box cannot look up is no router's doing, so the loopback hint would send a person to the wrong place. The
 * live box's name was known only to its own network's DNS and Tailscale's, and the internet had no record of it at all.
 */
const NAME_HINT =
  "The internet most likely cannot find it either: the name has no public DNS record, or only a resolver on this " +
  "network knows it, such as the router's or Tailscale's. Give it a public record, or set public_url to a tunnel's address.";

/** What the test sends. Read by whoever looks at the request on the way — a tunnel's log, a proxy's. */
const TEST_BODY = JSON.stringify({ test: true, note: "Sent by Nouride's Send a test. It does not run the job." });

export type ReachState = "internet" | "local" | "unknown";

export interface HookReach {
  state: ReachState;
  /** One sentence a person reads under the state. */
  why: string;
  /** The last test through the address shown, when there was one. */
  test?: ReachTest;
}

type DashboardAddress = Parameters<typeof webhookUrl>[0];

/** Where a hook stands, from the address it is handed out under and its last test through that address. */
export function hookReach(dashboard: DashboardAddress, job: Pick<Job, "webhookToken" | "reachTest">): HookReach {
  const { url, guessed } = webhookUrl(dashboard, job.webhookToken ?? "");
  if (guessed) return { state: "local", why: "No public address is set, so only this network can call it." };
  const host = new URL(url).hostname;
  if (onThisNetwork(host)) return { state: "local", why: `The public address set, ${host}, is on this network, so only this network can call it.` };
  // A test of another address — before the token was rotated, or the public address changed — says nothing about this one.
  const test = job.reachTest?.url === url ? job.reachTest : undefined;
  if (test?.arrived) return { state: "internet", why: `A test sent through the public address arrived (${test.detail}).`, test };
  if (test) return { state: "unknown", why: `The last test did not arrive: ${test.detail}`, test };
  return { state: "unknown", why: "Not tested yet. Send a test to find out." };
}

/**
 * A host only this network can reach: an address that is not public, or a name that never resolves outside —
 * `localhost`, mDNS's `.local`, `.home.arpa` (RFC 8375), `.internal`, a router's `.lan`, a name with no dot.
 * A public-looking name that resolves to a private address is found by the test, not here.
 */
function onThisNetwork(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":")) return classifyAddress(host) !== "public";
  if (!host.includes(".")) return true;
  return [".localhost", ".local", ".home.arpa", ".internal", ".lan"].some((suffix) => host.endsWith(suffix));
}

/** The tests in flight, each by the word its request carries. One per daemon, shared by the route and the sender. */
export class HookTests {
  private readonly waiting = new Map<string, { jobId: string; since: number; arrived?: number }>();
  readonly now: () => number;
  /** What a test is sent with — the runtime's `fetch`; a test hands in its own. */
  readonly send: typeof fetch;

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? Date.now;
    this.send = options.fetch ?? fetch;
  }

  /** A test about to be sent for this job: the word its request carries. */
  expect(jobId: string): string {
    for (const [word, entry] of this.waiting) if (this.now() - entry.since > WORD_KEPT_MS) this.waiting.delete(word);
    const word = randomToken();
    this.waiting.set(word, { jobId, since: this.now() });
    return word;
  }

  /** A request carrying `word` reached this job's hook: true when it is a test this daemon sent for it. */
  arrived(word: string, jobId: string): boolean {
    const entry = this.waiting.get(word);
    if (!entry || entry.jobId !== jobId) return false;
    entry.arrived = this.now();
    return true;
  }

  /** Whether the test with this word arrived — asked once, and the word forgotten. */
  take(word: string): boolean {
    const entry = this.waiting.get(word);
    this.waiting.delete(word);
    return entry?.arrived !== undefined;
  }
}

/** Post a test to the hook through its public address, and say what came of it. */
export async function sendReachTest(tests: HookTests, dashboard: DashboardAddress, job: Pick<Job, "id" | "webhookToken">): Promise<ReachTest> {
  const { url } = webhookUrl(dashboard, job.webhookToken ?? "");
  const word = tests.expect(job.id);
  const at = tests.now();
  let answer: Response | undefined;
  let failure: unknown;
  try {
    answer = await tests.send(url, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_HEADER]: word },
      body: TEST_BODY,
      // A redirect is somebody else's answer: followed, the test would reach wherever it points and call that arriving.
      redirect: "manual",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (err) {
    failure = err;
  }
  const ms = tests.now() - at;
  if (tests.take(word)) return { url, at, arrived: true, detail: `arrived in ${ms} ms` };
  const host = new URL(url).hostname;
  if (answer) {
    const moved = answer.status >= 300 && answer.status < 400 ? ` (a redirect to ${answer.headers.get("location") ?? "somewhere else"})` : "";
    return { url, at, arrived: false, detail: `${host} answered ${answer.status}${moved}, but the request never reached Nouride. Something else answers that address.` };
  }
  const hint = (failure as { code?: string } | undefined)?.code === "ENOTFOUND" ? NAME_HINT : LOOPBACK_HINT;
  return { url, at, arrived: false, detail: `${unreached(failure, host)}. ${hint}` };
}

/** Why a request got no answer, in words — from what the runtime's `fetch` reports. */
function unreached(failure: unknown, host: string): string {
  const { name, code, message } = (failure ?? {}) as { name?: string; code?: string; message?: string };
  if (name === "TimeoutError") return `Nothing answered at ${host} within ${TEST_TIMEOUT_MS / 1000} seconds`;
  if (code === "ENOTFOUND") return `The name ${host} does not resolve`;
  if (code === "ECONNREFUSED") return `${host} refused the connection`;
  if (code?.startsWith("CERT_") || /certificate/i.test(message ?? "")) return `${host}'s certificate was refused: ${message ?? code}`;
  return `Could not reach ${host}: ${message ?? String(failure)}`;
}
