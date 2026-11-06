/**
 * `@nouride/policy` — the exec permission decision layer.
 *
 * Pure: no filesystem, no database, no clock. The daemon supplies the policy, the grants it
 * holds and whether a human is reachable; this package answers run / ask / refuse. Splitting it
 * out is what makes the permission model testable without booting anything, and it is the piece
 * a second Nouverse tool could reuse without dragging the daemon along.
 */

export { decideExec, resolveDecision, type DecideInput } from "./decide.ts";
export { commandSegments, looseSegments, secretBindingWarnings, secretsFor, type SecretBinding } from "./exec-secrets.ts";
export { sendDestinations, sendsOverNetwork } from "./network-send.ts";
export {
  autoApprovable,
  BALANCED_ASKS,
  classifyHardline,
  classifyOwnState,
  credentialPath,
  HARDLINE_SUMMARY,
  HARDLINE_EXEMPTIONS,
  SCRATCHPAD_DIRNAME,
  type HardlineVerdict,
} from "./hardline.ts";
export {
  execGrantKey,
  executedFileArgIndex,
  toolGrantKey,
  type GrantKeyInput,
  type ToolGrantKeyInput,
} from "./grant-key.ts";
export type { ApprovalDecision, ExecGrant, ExecPolicy, ExecRequest, PolicyAsk, PolicyOutcome } from "./types.ts";
export * from "./approvals.ts";
