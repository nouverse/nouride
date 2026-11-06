/**
 * A skill fetched from a hub, as a pending draft — `skills-hub`'s way into the same gate.
 *
 * Installing is the same decision as accepting a draft an agent wrote: text that agents will read as
 * instructions, and scripts they will run. So it lands where those do, and nothing is on disk until a
 * person approves it. Where it came from, and what the installer changed, is the draft's transcript —
 * which is where the Workshop shows a draft's origin — and its first line is the pinned source,
 * read back on approval into the skill's own `source:` line.
 *
 * The pending cap applies to agents only: an operator who asked for five skills meant five.
 */

import { createLogger } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { DraftsPort } from "./drafts.store.ts";
import { announceDraft, type NotifyDeps } from "./notify.ts";
import type { SkillDraft } from "./types.ts";

const log = createLogger("reflection");

const SOURCE_PREFIX = "Source: ";

export interface InstallDeps {
  drafts: DraftsPort;
  maxPending: () => number;
  notify: NotifyDeps;
  audit?: AuditPort;
}

export interface InstallDraftInput {
  agentId: string;
  gatewayId?: string;
  chatId?: string;
  /** Whether the pending cap applies — true when an agent, not a person, asked for the install. */
  byAgent: boolean;
  source: string;
  name: string;
  description: string;
  requires: string;
  needsTools: string;
  body: string;
  files: { path: string; content: string }[];
  provenance: string;
}

export async function proposeInstall(
  deps: InstallDeps,
  input: InstallDraftInput,
): Promise<{ ok: true; draft: SkillDraft } | { ok: false; error: string }> {
  if (input.byAgent && deps.drafts.pendingCount() >= deps.maxPending()) {
    return { ok: false, error: `${deps.maxPending()} drafts are already waiting for a decision. Ask a person to clear some first.` };
  }
  const draft = deps.drafts.create({
    agentId: input.agentId,
    ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    triggerKind: "external_install",
    triggerReason: `installed from ${input.source}`,
    name: input.name,
    description: input.description,
    requires: input.requires,
    needsTools: input.needsTools,
    body: input.body,
    ...(input.files.length ? { files: input.files } : {}),
    transcript: `${SOURCE_PREFIX}${input.source}\n\n${input.provenance}`,
  });
  deps.audit?.record({
    action: "skill_draft_created",
    agentId: input.agentId,
    actor: input.agentId,
    details: { draft: draft.id, skill: draft.name, trigger: "external_install", source: input.source },
  });
  log.info("skill install proposed", { agent_id: input.agentId, draft: draft.id, skill: draft.name, source: input.source });
  await announceDraft(deps.notify, draft);
  return { ok: true, draft };
}

/**
 * What approval adds to the document for an installed draft: the wider file rule, and its source.
 * Empty for every other draft, so the approval reads the same either way.
 */
export function installedFields(draft: SkillDraft): { installed?: true; source?: string } {
  if (draft.triggerKind !== "external_install") return {};
  const first = draft.transcript?.split("\n", 1)[0] ?? "";
  const source = first.startsWith(SOURCE_PREFIX) ? first.slice(SOURCE_PREFIX.length).trim() : "";
  return { installed: true, ...(source ? { source } : {}) };
}
