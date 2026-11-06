/**
 * Noticing when a pack's `approval_required` is narrower than the default it replaced.
 *
 * Found live. An install had `approval_required = ["write"]`, which reads like a gate being asked for
 * and is in fact a gate being removed from `edit`, `exec` and every harness tool — the list replaces
 * `DEFAULT_APPROVAL_REQUIRED` rather than adding to it. The agent then rewrote its own `config.toml` to
 * widen its workspace roots with no prompt at all, and the operator's reasonable conclusion was that
 * approvals had regressed.
 *
 * The warning is only useful if it is quiet in the ordinary cases, so those are tested too.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_APPROVAL_REQUIRED } from "@nouride/persona";
import { droppedApprovalGates } from "@/modules/tools/registry.ts";

describe("droppedApprovalGates", () => {
  test("names the gates an explicit list removed", () => {
    // The exact configuration that caused the confusion.
    expect(
      droppedApprovalGates({
        enabled: ["read", "glob", "grep", "write", "edit", "exec"],
        approvalRequired: ["write"],
        approvalRequiredExplicit: true,
      }),
    ).toEqual(["exec", "edit"]);
  });

  test("stays silent for a pack that wrote no list at all", () => {
    // A seeded default is not the operator narrowing anything, and warning about it would fire on
    // every ordinary agent — which is how a warning stops being read. The list is short of the
    // default here on purpose: with the whole default in it there is nothing to drop, and the test
    // passed with the `explicit` check deleted.
    expect(
      droppedApprovalGates({
        enabled: ["write", "edit", "exec"],
        approvalRequired: DEFAULT_APPROVAL_REQUIRED.filter((name) => name !== "exec"),
        approvalRequiredExplicit: false,
      }),
    ).toEqual([]);
  });

  test("stays silent when the explicit list keeps everything the agent can call", () => {
    expect(
      droppedApprovalGates({
        enabled: ["read", "write", "edit"],
        approvalRequired: ["write", "edit"],
        approvalRequiredExplicit: true,
      }),
    ).toEqual([]);
  });

  test("an explicitly empty list drops every gated tool the agent enables, and names none it cannot call", () => {
    // `approval_required = []` is a legitimate thing for an operator to write on a trusted host. It
    // should still be said out loud, because it is the widest possible reading of that one line. Only
    // the enabled ones: `cron_manage` is in the default list but not enabled here, and a warning about a
    // tool this agent does not have is the false positive that gets warnings skimmed past.
    expect(
      droppedApprovalGates({
        enabled: ["exec", "write", "edit", "agent_create"],
        approvalRequired: [],
        approvalRequiredExplicit: true,
      }),
    ).toEqual(["exec", "write", "edit", "agent_create"]);
  });
});
