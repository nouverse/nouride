/**
 * What the operator is told when a turn fails on something that is theirs to fix (`modules/pipeline/turn.ts`).
 *
 * The classifier's hint says what to change in this install. A gateway in between knows more: one with no account for
 * the model says which provider wants one, and the hint alone sent the operator to this install's own key. So the
 * provider's sentence goes with the hint, to the operator, and never into the chat.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const made of benches.splice(0)) made.dispose();
});

/** A daemon whose provider answers every request with `status` and `body`, its alerts recorded. */
async function bench(status: number, body: unknown) {
  const alerts: { key: string; text: string }[] = [];
  const failing = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const made = await pipelineBench({
    fetch: () => failing,
    maxAttempts: 1,
    gateway: new FakeGateway("telegram:nouva"),
    deps: { notifier: { toChat: async () => true, alert: async (key: string, text: string) => (alerts.push({ key, text }), true) } as never },
  });
  benches.push(made);
  made.pipeline.attach();
  return { ...made, alerts };
}

describe("a turn that failed on something the operator has to fix", () => {
  // What a gateway with no account for a model answers: the status and the type every client reads as a credential.
  const NO_ACCOUNT = '"gpt-9" is served by kiro, but none of them has an account configured on this gateway. Add one on the provider page.';

  test("a gateway with no account for the model: the person hears of a credential, the operator reads which to add", async () => {
    const h = await bench(401, { error: { message: NO_ACCOUNT, type: "authentication_error", code: "no_account" } });
    h.gateway.receive(envelope({ gatewayId: "telegram:nouva", text: "hi", timestamp: Date.now() }));
    await h.pipeline.idle();

    const reply = h.gateway.lastText();
    expect(reply).toMatch(/credentials are not working/i);
    expect(reply).not.toMatch(/building requests/i);
    // The provider's sentence is the operator's to read: it stays out of the chat.
    expect(reply).not.toContain("kiro");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.key).toBe("provider_auth:test");
    expect(h.alerts[0]!.text).toStartWith("nouva cannot reach test: auth. the provider rejected the credential.");
    expect(h.alerts[0]!.text).toEndWith(`The provider said: "${NO_ACCOUNT}"`);
  });

  test("a provider that wrote no sentence: the hint alone, as before", async () => {
    const h = await bench(401, "<html><body>401</body></html>");
    h.gateway.receive(envelope({ gatewayId: "telegram:nouva", text: "hi", timestamp: Date.now() }));
    await h.pipeline.idle();

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.text).toEndWith("(`nouride doctor` lists which resolve).");
    expect(h.alerts[0]!.text).not.toContain("The provider said");
  });

  test("a failure that is not theirs to fix alerts nobody, whatever the provider wrote", async () => {
    const h = await bench(400, { error: { message: "content_policy violation: the provider wrote a sentence" } });
    h.gateway.receive(envelope({ gatewayId: "telegram:nouva", text: "hi", timestamp: Date.now() }));
    await h.pipeline.idle();

    expect(h.gateway.lastText()).toMatch(/declined to answer/i);
    expect(h.alerts).toEqual([]);
  });
});
