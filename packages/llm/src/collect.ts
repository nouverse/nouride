/**
 * A stream read to its end, as the one message `chat()` returns.
 *
 * For a server that streams when it was not asked to. `stream: false` is sent, and an OpenAI-compatible
 * proxy can still answer with Server-Sent Events — 9Router does when the field is absent, and nothing
 * obliges one to honour it when present. Parsing that body as JSON failed on its first `data:` line, so
 * turning streaming off broke every turn on such a route instead of only changing how the answer arrived.
 */

import type { ChatResponse, StopReason, StreamChunk, TokenUsage, ToolCall } from "@nouride/shared";

/** Whether a response is Server-Sent Events, by its header or — a proxy may mislabel it — by its first bytes. */
export function isEventStream(res: Response, body: string): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*(data|event):/.test(body);
}

export async function collectStream(chunks: AsyncIterable<StreamChunk>, model: string): Promise<ChatResponse> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let stopReason: StopReason = "stop";
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let cutAtLimit = false;
  for await (const chunk of chunks) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "tool_call") toolCalls.push(chunk.call);
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "done") {
      stopReason = chunk.stopReason;
      cutAtLimit = chunk.cutAtLimit === true;
    }
  }
  return { text, toolCalls, stopReason, ...(cutAtLimit ? { cutAtLimit: true } : {}), usage, model };
}
