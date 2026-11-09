/**
 * The LLM gateway's switch (`routes/llm-gateway.ts`): whether it runs, who holds the switch, and who would notice it
 * gone.
 */

/** An agent that reaches its model, or one of its fallbacks, through the gateway. */
export interface LlmGatewayUser {
  id: string;
  name: string;
}

/** `GET /llm-gateway`. */
export interface LlmGatewayView {
  /** The build carries the gateway. False: there is nothing to switch. */
  carried: boolean;
  /** It runs in this process now. */
  on: boolean;
  /** `environment`: the server's environment holds the switch. Null: the dashboard may turn it. */
  decidedBy: "environment" | null;
  /** What stops answering when it is off. */
  usedBy: LlmGatewayUser[];
  /** Whether something starts Nouride again once it ends: turning the gateway off is a restart. */
  restarts: boolean;
}

/** `PUT /llm-gateway`'s answer. */
export interface LlmGatewaySwitched {
  /** It runs now: still, once it was turned off, until the restart that stops it. */
  on: boolean;
  /** The setting is written, so the next start keeps it. */
  saved: boolean;
  /** Turning it off: the restart asked for, and whether it waits for running work first. Absent when none was. */
  restart?: { waiting: boolean; note: string };
  /** What happened, in the dashboard's words. */
  plain: string;
}
