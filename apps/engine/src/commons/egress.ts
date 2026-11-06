/**
 * What leaves the daemon is masked of every credential it knows (0.7.17): each request a model is sent, each text it
 * embeds, and each line a chat is sent.
 *
 * By exact value, as `SecretMasker` (`@nouride/secrets`) reads them: the secret store's, and the credentials people
 * sent in chat, held under handles. The other guards keep a value out of a conversation — taken out of a message as
 * it arrives, masked out of a tool's result — and this is the one that holds when something got past them: a value
 * pasted into a chat before 0.7.17 and still in its history, one written into a memory file or a skill, one a path
 * nobody thought of handed back.
 *
 * Whole values only. `exec`'s masker takes the start of a value as well, because a command printing `${KEY:0:10}` is a
 * leak; here the text is a conversation, where the start of a stored value is too often an ordinary word. And not a
 * value too short or too plain to be told from one: a stored `postgres` would take the word out of every request.
 */

import { maskSecrets } from "@nouride/secrets";
import type { ChatParams, EmbedParams, Gateway, LLMProvider, MessageContent } from "@nouride/shared";

type Values = Record<string, string>;

/** The values worth masking in a conversation: eight characters or more, and not a plain word. */
export function egressValues(known: Values): Values {
  return Object.fromEntries(Object.entries(known).filter(([, value]) => value.length >= 8 && !/^[A-Za-z]+$/.test(value)));
}

const mask = (text: string, values: Values) => maskSecrets(text, values, { whole: true });

function maskContent(content: MessageContent, values: Values): MessageContent {
  if (typeof content === "string") return mask(content, values);
  return content.map((part) => (part.type === "text" ? { ...part, text: mask(part.text, values) } : part));
}

/** Every string in a call's arguments, however deep. */
function maskArguments(value: unknown, values: Values): unknown {
  if (typeof value === "string") return mask(value, values);
  if (Array.isArray(value)) return value.map((item) => maskArguments(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskArguments(item, values)]));
  return value;
}

/** A model's request with every value masked: its system prompt, its messages, and the arguments of the calls in them. */
export function maskRequest(params: ChatParams, values: Values): ChatParams {
  if (Object.keys(values).length === 0) return params;
  const { system } = params;
  return {
    ...params,
    ...(system === undefined ? {} : { system: typeof system === "string" ? mask(system, values) : system.map((block) => ({ ...block, text: mask(block.text, values) })) }),
    messages: params.messages.map((message) => ({
      ...message,
      content: maskContent(message.content, values),
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: maskArguments(call.arguments, values) as Record<string, unknown> })) } : {}),
    })),
  };
}

/** The same provider, every request and every text it embeds masked first. Read per call: a secret set a minute ago counts. */
export function withEgressMask(provider: LLMProvider, known: () => Values): LLMProvider {
  const masked: LLMProvider = Object.create(provider);
  return Object.assign(masked, {
    chat: (params: ChatParams) => provider.chat(maskRequest(params, egressValues(known()))),
    stream: (params: ChatParams) => provider.stream(maskRequest(params, egressValues(known()))),
    ...(provider.embed
      ? {
          embed: (params: EmbedParams) => {
            const values = egressValues(known());
            return provider.embed!({ ...params, input: params.input.map((text) => mask(text, values)) });
          },
        }
      : {}),
  });
}

/**
 * Every line a gateway is handed, masked first — in place rather than wrapped, because an adapter is an instance the
 * daemon tells apart by its class (a WhatsApp connection is logged out before it is removed) and keeps state a copy
 * would not share.
 */
export function maskOutbound(gateway: Gateway, known: () => Values): void {
  const send = gateway.send.bind(gateway);
  gateway.send = (message) => send({ ...message, text: mask(message.text, egressValues(known())) });
  const edit = gateway.editMessage?.bind(gateway);
  if (edit) gateway.editMessage = (chatId, messageId, text) => edit(chatId, messageId, mask(text, egressValues(known())));
}
