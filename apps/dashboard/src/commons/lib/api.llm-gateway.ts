/**
 * The LLM gateway's switch: whether it runs, and turning it on or off. Spread into `api` like the others; the payload
 * types are `@nouride/wire`'s.
 */

import { control, request } from "./api.client";
import type { LlmGatewaySwitched, LlmGatewayView } from "@nouride/wire";

/**
 * Turning it on boots the gateway in the daemon's process, its database and every provider, which on a small box can
 * outlast the client's usual fifteen seconds without anything being wrong.
 */
const START_TIMEOUT_MS = 60_000;

export const llmGatewayApi = {
  llmGateway: () => request<LlmGatewayView>(`${control}/llm-gateway`),
  switchLlmGateway: (on: boolean) =>
    request<LlmGatewaySwitched>(`${control}/llm-gateway`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
      timeoutMs: START_TIMEOUT_MS,
    }),
};
