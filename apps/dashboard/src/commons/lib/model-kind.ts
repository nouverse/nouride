/**
 * Which of a profile's listed models embed and which chat, by name: `/v1/models` says neither. A model picker for an
 * agent offers chat models only — the owner was offered `bge-m3` as an agent's model — and the semantic-search one
 * embedding models only. Suggestions either way: the field still takes any name typed.
 */

/** Names embedding models go by across Ollama, OpenAI, Gemini, Mistral and Jina. */
const EMBEDDING = /embed|bge|e5-|gte|nomic|minilm|mxbai|arctic|jina|snowflake/i;

export function isEmbeddingModel(model: string): boolean {
  return EMBEDDING.test(model);
}

/** The models a chat model field suggests: the listed ones that do not embed. */
export function chatModels(models: readonly string[]): string[] {
  return models.filter((model) => !isEmbeddingModel(model));
}
