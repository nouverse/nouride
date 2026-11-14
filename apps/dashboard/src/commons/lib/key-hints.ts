/**
 * Where a person gets the key a provider asks for, and what using it costs: the list under "How to get an API key",
 * the same wherever a provider is added (the Models page, and the first-run setup).
 *
 * The question a person has at that field is not only "where is the key" but "will this charge me": a chat
 * subscription does not cover the same company's API, and a few services do include the key in a plan. So each
 * service says which it is, in a sentence, beside the link to the page where its key is made.
 *
 * Each line was read from the service's own documentation, and its address asked without a key: it refused for the
 * key alone, which is what a right address does. A service that needs more than a key and an address is not listed,
 * since the hint would lead to a provider that answers nothing.
 */

export interface KeyHint {
  /** A name a provider added from this line starts with. */
  id: string;
  name: string;
  /** The page of the service where a person makes the key. */
  keyUrl: string;
  /** How Nouride talks to it, and where: what "Use it" fills in. */
  kind: "openai" | "anthropic";
  baseUrl: string;
  /** Whether using the key is charged by use, or is part of a plan the person already pays for. */
  cost: "per-use" | "included";
  /** What it costs and what to know first, in a sentence or two. */
  words: string;
}

export const KEY_HINTS: readonly KeyHint[] = [
  {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    cost: "per-use",
    words: "Charged per use, from credits you add there. A ChatGPT subscription does not cover it.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyUrl: "https://platform.claude.com/settings/keys",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    cost: "per-use",
    words: "Charged per use, billed apart from a Claude subscription.",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    cost: "per-use",
    words: "Free within its limits, then charged per use.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    cost: "per-use",
    words: "Charged per use, from the balance you top up there.",
  },
  {
    id: "zai",
    name: "Z.ai",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    cost: "per-use",
    words: "Charged per use, from your balance there. Its GLM Coding Plan is for the coding tools Z.ai lists, and does not cover use from here.",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    keyUrl: "https://opencode.ai/console",
    kind: "openai",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    cost: "per-use",
    words: "Charged per request, from credits you add there. Its free models answer only inside OpenCode itself.",
  },
  {
    id: "commandcode",
    name: "Command Code",
    keyUrl: "https://commandcode.ai/settings/keys",
    kind: "openai",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    cost: "included",
    words: "Your Command Code plan includes the key: use draws on the plan's credits and stops when they run out, so nothing is charged outside it. Every plan but Go.",
  },
];
