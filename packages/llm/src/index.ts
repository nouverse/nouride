/**
 * `@nouride/llm` — the two request formats Nouride speaks (TD-004), over raw fetch
 * (TD-006).
 *
 * Nothing here knows about agents, tools or sessions: it turns a `ChatParams` into a
 * `ChatResponse` or a chunk stream. The tool-call loop that uses it lives in the
 * engine, because that loop needs approval gates and a tool registry.
 */

import { ConfigError, type LLMProvider, type ProviderKind } from "@nouride/shared";
import { AnthropicProvider } from "./anthropic.ts";
import type { HttpDeps } from "./http.ts";
import { OpenAIProvider } from "./openai.ts";

export { listModels, wireCapabilities, type ListedModel } from "./models.ts";
export type { HttpDeps } from "./http.ts";
export {
  compactionLimitInfo,
  contextWindowInfo,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolsTokens,
} from "./tokens.ts";
export { outputLimitInfo } from "./output-limits.ts";
export { estimateCost, type CostEstimate, type ModelPrice } from "./cost.ts";
export { flattenSystem, systemBlocks, SYSTEM_BLOCK_SEPARATOR } from "./system.ts";

export interface ProviderSpec {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** Send `ChatParams.identity` — `ProviderProfile.identify`. */
  identify?: boolean;
  http?: HttpDeps;
}

export function createProvider(spec: ProviderSpec): LLMProvider {
  switch (spec.kind) {
    case "openai":
      return new OpenAIProvider(spec);
    case "anthropic":
      return new AnthropicProvider(spec);
    default: {
      // Exhaustiveness guard: adding a ProviderKind without an implementation should
      // fail here, not silently fall through to a default provider.
      const exhaustive: never = spec.kind;
      throw new ConfigError(`unknown provider kind: ${String(exhaustive)}`);
    }
  }
}
export { describeImage, isSupportedImageType, type DescribeImageOptions, type ImageDescription } from "./vision.ts";
export type { Classification, FailureClass } from "./classify.ts";
