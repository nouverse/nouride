/**
 * A finished run, delivered to a URL instead of a chat.
 *
 * Behind the same SSRF guard as `web_fetch`, and for a sharper reason than that tool has: this URL is stored, and it
 * fires on a schedule with nobody reading the result. An unguarded webhook pointed at `169.254.169.254` is a
 * credential exfiltration path that runs every hour and reports success. `[security.web] allow_private_urls` is the
 * one knob that opens it, for an operator who genuinely means to reach a service on their own network.
 *
 * Two things the guard did not cover until 0.7.9. The POST went to whatever the name resolved to a moment after
 * the check, so a resolver could answer public for one and private for the other; it goes to the address the check
 * judged now. And `fetch` followed a redirect on its own, to wherever it pointed and past the one check made — turning
 * the POST into a GET without its body on the way, so a run was recorded delivered that never was. A redirect is
 * refused instead, with where it pointed, the way a webhook sender is expected to behave.
 */

import { checkUrl, judgedFetch, type UrlPolicy } from "@/modules/tools/url-safety.ts";

export async function postWebhook(
  url: string,
  body: unknown,
  policy: UrlPolicy,
  /** The check, injectable so a test can stand in for a resolver. */
  check: typeof checkUrl = checkUrl,
): Promise<void> {
  const verdict = await check(url, policy);
  if (!verdict.allowed) throw new Error(verdict.reason ?? "refused by the URL policy");

  const response = await judgedFetch()(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      // Bounded, because this runs inside a scheduled job: a receiver that accepts the connection
      // and never answers would otherwise hold the run open until the turn deadline.
      signal: AbortSignal.timeout(30_000),
    },
    verdict.addresses ?? [],
  );
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    throw new Error(
      `the receiver answered ${response.status}, a redirect${location ? ` to ${location}` : ""}. A webhook is posted ` +
        "to the URL it was given and nowhere else; set it to the address the receiver redirects to",
    );
  }
  if (!response.ok) throw new Error(`the receiver answered ${response.status}`);
}
