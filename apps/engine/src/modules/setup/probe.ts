/**
 * Checking a provider's URL and key before they are saved.
 *
 * The alternative is what every previous version of this daemon did: accept whatever was typed, report
 * success, and fail on the first message with an error the operator has to go looking for. On a first
 * run that is the worst possible moment — they have no working baseline to compare against, so a typo
 * in a base URL reads as "this software does not work".
 *
 * A model listing rather than a completion. It proves the URL resolves, the TLS handshake works and the
 * key is accepted, it costs nothing, and it comes back with the names the operator has to choose from
 * next — so the same request that validates the credential also populates the model picker. A one-token
 * completion would prove slightly more and cost real money on a provider that meters by request.
 *
 * How the listing is asked for — each format's auth, Anthropic's version — is `@nouride/llm`'s (`listModels`); what
 * is here is the sentences a setup form shows for each way it can fail.
 */

import { listModels } from "@nouride/llm";

export type ProviderKind = "openai" | "anthropic";

export interface ProbeResult {
  ok: boolean;
  /** Model ids the endpoint reported, best-effort and possibly empty. */
  models: string[];
  /** Written for someone staring at a setup form, so it says what to change. */
  error?: string;
  /**
   * Why it failed, for the dashboard's words at its route (0.8.20): `error` names the address and its `/v1` for whoever
   * types one into the CLI. `status` is the one it answered with.
   */
  why?: "invalid_url" | "unauthorized" | "not_found" | "status" | "timeout" | "unreachable";
  status?: number;
}

/** Long enough for a cold serverless endpoint, short enough that a wrong host does not hang the form. */
const TIMEOUT_MS = 15_000;

export async function probeProvider(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const listing = await listModels({ ...input, timeoutMs: TIMEOUT_MS });
  if (listing.ok) return { ok: true, models: listing.models.map((model) => model.id).sort() };
  const fail = (error: string): ProbeResult => ({ ok: false, models: [], error, why: listing.reason, ...(listing.reason === "status" ? { status: listing.status } : {}) });
  switch (listing.reason) {
    // Parsed before it is used, so `not a url` is reported as a malformed address rather than as a network failure
    // the operator would go looking for in their firewall.
    case "invalid_url":
      return fail(`"${input.baseUrl}" is not a valid URL`);
    case "unauthorized":
      return fail("The endpoint rejected that API key.");
    case "not_found":
      return fail(`No model list at ${listing.url}. Check the base URL: it usually ends in /v1.`);
    case "status":
      return fail(`The endpoint answered ${listing.status}.`);
    case "timeout":
      return fail(`No answer from ${listing.url} within 15 seconds.`);
    case "unreachable":
      // Never the raw cause: a DNS failure stringifies to something that names internals and helps nobody filling in
      // a form.
      return fail(`Could not reach ${listing.url}. Check the address and that this machine can get out to it.`);
  }
}
