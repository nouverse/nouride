/**
 * Every request the skills hub makes, through one door: the SSRF guard on each hop, a deadline, and
 * a byte cap that is enforced while reading rather than after.
 *
 * The hubs are public services, so private addresses are refused whatever `allow_private_urls` says
 * — that setting is for a SearXNG on the LAN, not for a skill index that redirects somewhere
 * internal. The one exception is an address the operator named themselves (`allowPrivate`): the MCP
 * catalog pointed at a copy of Nouverse's on their own network. A GitHub token, when one is set, is
 * sent to GitHub's hosts and nowhere else.
 */

import { checkUrl, judgedFetch } from "@/modules/tools/url-safety.ts";

const MAX_REDIRECTS = 5;
const USER_AGENT = "nouride-skills (+https://github.com/nouverse/nouride)";
const GITHUB_HOSTS = new Set(["api.github.com", "codeload.github.com", "github.com", "raw.githubusercontent.com"]);

export interface HubFetchDeps {
  fetchImpl?: typeof fetch;
  checkUrlImpl?: typeof checkUrl;
  /** `github_token` from the secret store, if set: 5,000 GitHub API calls an hour instead of 60. */
  githubToken?: string;
  /** Private addresses too — only for an address the operator chose, never one a hub or a pack names. */
  allowPrivate?: boolean;
}

export interface HubRequest {
  maxBytes: number;
  accept?: string;
  timeoutMs?: number;
}

export class HubError extends Error {
  override name = "HubError";
  /** The HTTP status that refused the request, when one did. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function hubBytes(url: string, deps: HubFetchDeps, request: HubRequest): Promise<Uint8Array> {
  // From the addresses each hop's check judged, never from a second lookup of the name (S12).
  const doFetch = judgedFetch(deps.fetchImpl);
  const check = deps.checkUrlImpl ?? checkUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const verdict = await check(target, { allowPrivate: deps.allowPrivate === true });
      if (!verdict.allowed) throw new HubError(`refused ${hostOf(target)}: ${verdict.reason}`);
      const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: request.accept ?? "*/*" };
      if (deps.githubToken && GITHUB_HOSTS.has(hostOf(target))) headers.authorization = `Bearer ${deps.githubToken}`;

      const res = await doFetch(target, { headers, redirect: "manual", signal: controller.signal }, verdict.addresses ?? []);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        target = new URL(res.headers.get("location")!, target).toString();
        continue;
      }
      if (!res.ok) throw new HubError(statusMessage(res.status, target), res.status);
      return await readCapped(res, request.maxBytes, target);
    }
    throw new HubError(`too many redirects from ${hostOf(url)}`);
  } catch (err) {
    if (err instanceof HubError) throw err;
    if (controller.signal.aborted) throw new HubError(`${hostOf(url)} did not answer in time`);
    throw new HubError(`${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function hubText(url: string, deps: HubFetchDeps, request: HubRequest): Promise<string> {
  return new TextDecoder().decode(await hubBytes(url, deps, request));
}

export async function hubJson<T>(url: string, deps: HubFetchDeps, request: Omit<HubRequest, "accept">): Promise<T> {
  const text = await hubText(url, deps, { ...request, accept: "application/json" });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HubError(`${hostOf(url)} did not answer with JSON`);
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HubError(`${hostOf(url)} sent ${declared} bytes, more than the ${maxBytes} allowed`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new HubError(`${hostOf(url)} sent more than the ${maxBytes} bytes allowed`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function statusMessage(status: number, url: string): string {
  const host = hostOf(url);
  if (status === 404) return `not found on ${host}`;
  if ((status === 403 || status === 429) && host.endsWith("github.com")) {
    return `GitHub refused (HTTP ${status}), probably its rate limit of 60 requests an hour without a token. Set the secret \`github_token\` for 5,000.`;
  }
  return `HTTP ${status} from ${host}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
