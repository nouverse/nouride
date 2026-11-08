/**
 * Tearing infrastructure down asks first; creating and changing it do not.
 *
 * The gap was visible the moment an agent was pointed at a Terraform repository: nothing classified
 * it, so a scheduled turn would have rebuilt a homelab with nobody watching. Until 0.8.0 every change
 * was on the list — `apply`, `scale`, `pct stop` — and asked every time, which is the work an agent is
 * given a repository or a cluster for. The fixed list keeps what does not come back;
 * `careful` still asks the rest once, as any new command.
 *
 * On the list rather than an ordinary approval, for the property that defines it: the answer can never
 * become a standing grant. "Allow always" for `terraform destroy` is not a permission anybody means to give.
 */

import { describe, expect, test } from "bun:test";
import { classifyHardline, decideExec } from "@nouride/policy";

describe("what tears infrastructure down", () => {
  test("terraform destroy, and apply -destroy", () => {
    expect(classifyHardline(["terraform", "destroy", "-auto-approve"])?.class).toBe("teardown");
    expect(classifyHardline(["terraform", "apply", "-destroy"])?.class).toBe("teardown");
  });

  test("the reason says what it tears down, not merely that it is dangerous", () => {
    // A human woken at 3am needs to know whether this is `rm -rf` or `terraform destroy`. They are different emergencies.
    const reason = classifyHardline(["terraform", "destroy"])?.reason ?? "";
    expect(reason).toContain("terraform destroy");
    expect(reason).toMatch(/infrastructure/);
  });

  test("kubectl delete, helm uninstall, pulumi and tofu destroy", () => {
    expect(classifyHardline(["kubectl", "delete", "pod", "x"])?.class).toBe("teardown");
    expect(classifyHardline(["helm", "uninstall", "app"])?.class).toBe("teardown");
    expect(classifyHardline(["pulumi", "destroy"])?.class).toBe("teardown");
    expect(classifyHardline(["tofu", "destroy"])?.class).toBe("teardown");
  });
});

describe("what does not", () => {
  test("creating and changing — apply, scale, drain, a playbook", () => {
    for (const argv of [
      ["terraform", "apply"],
      ["tofu", "apply"],
      ["pulumi", "up"],
      ["kubectl", "drain", "node-1"],
      ["kubectl", "scale", "deploy/web", "--replicas=3"],
      ["helm", "rollback", "app", "2"],
      ["ansible-playbook", "site.yml"],
    ]) {
      expect({ argv, verdict: classifyHardline(argv) }).toEqual({ argv, verdict: null });
    }
  });

  test("reading — plan, get, diff, status", () => {
    expect(classifyHardline(["terraform", "plan"])).toBeNull();
    expect(classifyHardline(["terraform", "validate"])).toBeNull();
    expect(classifyHardline(["kubectl", "get", "pods"])).toBeNull();
    expect(classifyHardline(["kubectl", "describe", "node", "x"])).toBeNull();
    expect(classifyHardline(["helm", "list"])).toBeNull();
  });

  test("a dry run is a preview, whatever the subcommand says", () => {
    // Refusing to *simulate* a change is exactly the friction that gets a gate switched off.
    expect(classifyHardline(["kubectl", "delete", "pod", "x", "--dry-run"])).toBeNull();
    expect(classifyHardline(["kubectl", "delete", "pod", "x", "--dry-run=client"])).toBeNull();
  });

  test("an unrelated program named like a subcommand is not caught", () => {
    expect(classifyHardline(["echo", "destroy"])).toBeNull();
    expect(classifyHardline(["git", "apply", "patch.diff"])).toBeNull();
  });
});

describe("on the fixed list", () => {
  const decide = (canAsk: boolean) =>
    decideExec({
      policy: { blocked: [] },
      request: { argv: ["terraform", "destroy"], cwd: "/opt/projects/x", agentId: "nouva" },
      grantKey: "k",
      grants: new Set<string>(["k"]),
      canAsk,
      ownStateByOs: false,
    });

  test("it is never grantable — a grant for the very command does not answer it", () => {
    expect(decide(true)).toMatchObject({ action: "ask", grantable: false, hardline: true, hardlineClass: "teardown" });
  });

  test("with nobody to ask it is refused, not queued for a prompt nobody sees", () => {
    // This is what a scheduled turn hits under `careful`: a cron job must not tear a homelab down silently.
    expect(decide(false).action).toBe("refuse");
  });
});
