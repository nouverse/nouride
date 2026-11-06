import { describe, expect, test } from "bun:test";
import { unauthorizedMessage } from "@/cli/diagnose.ts";
import { installFingerprint } from "@/modules/web/health.ts";

const base = {
  baseUrl: "http://localhost:18254",
  localInstall: "aaaaaaaaaaaa",
  tokenPath: "/home/me/project-a/data/.control-token",
};

describe("a 401 from the control API", () => {
  test("names the real cause when another install holds the port", () => {
    const { message, hint } = unauthorizedMessage({ ...base, daemonInstall: "bbbbbbbbbbbb" });

    expect(message).toContain("different Nouride install");
    // The port is the thing being contended, so it belongs in the message.
    expect(message).toContain("18254");
    expect(hint).toContain("/home/me/project-a/data");
    // The advice that sent the operator down the wrong path must not appear: the token is not the problem.
    expect(hint).not.toContain("Delete");
  });

  test("blames the token only when it is the same install", () => {
    const { message, hint } = unauthorizedMessage({ ...base, daemonInstall: base.localInstall });

    expect(message).toBe("The daemon rejected the control token.");
    expect(hint).toContain("Delete /home/me/project-a/data/.control-token");
  });

  test("says unknown rather than guessing when health does not answer", () => {
    const { hint } = unauthorizedMessage({ ...base, daemonInstall: undefined });

    // An older daemon has no fingerprint to report. Both remedies are offered, each with its condition,
    // because picking one would be a coin flip presented as a diagnosis.
    expect(hint).toContain("unknown");
    expect(hint).toContain("stop it");
    expect(hint).toContain("delete");
  });
});

describe("the install fingerprint", () => {
  test("separates two installs and is stable for one", () => {
    const a = installFingerprint("/home/me/project-a/data");
    const b = installFingerprint("/home/me/project-b/data");

    expect(a).not.toBe(b);
    expect(installFingerprint("/home/me/project-a/data")).toBe(a);
  });

  test("reveals no path, so an unauthenticated endpoint can carry it", () => {
    const id = installFingerprint("/home/me/secret-project/data");

    expect(id).not.toContain("secret");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("distinguishes sibling directories that differ only at the end", () => {
    // The realistic collision: ~/nouride-test and ~/Workspace/nouverse/nouride/tmp/nouride-test, which is
    // the pair that actually caused the confusion.
    expect(installFingerprint("/a/b/nouride-test/data")).not.toBe(
      installFingerprint("/a/b/c/nouride-test/data"),
    );
  });
});
