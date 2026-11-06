/**
 * Reading `nouride-pkg`'s answers, and carrying requests to it.
 */

import { describe, expect, test } from "bun:test";
import { askPackages, packageBackend } from "../src/client.ts";
import { isPackageName, parseAnswer, requestLine } from "../src/protocol.ts";
import { UnixSocketError, type UnixSocketFailure } from "@nouride/runtime";

describe("the answer", () => {
  test("a plan and its status line", () => {
    const answer = parseAnswer("Reading package lists...\n+ libjq1\n+ jq\n- oldthing\n@nouride-pkg ok planned\n");
    expect(answer).toEqual({
      status: "ok",
      detail: "planned",
      installs: ["libjq1", "jq"],
      removes: ["oldthing"],
      output: "Reading package lists...\n+ libjq1\n+ jq\n- oldthing",
    });
  });

  test("no status line is a failure, however much looked like an install", () => {
    const answer = parseAnswer("Setting up jq (1.7.1) ...\n");
    expect(answer.status).toBe("failed");
    expect(answer.detail).toContain("stopped before finishing");
  });

  test("requests are one line, and the rule on names is the script's", () => {
    expect(requestLine({ op: "install", names: ["jq", "poppler-utils"] })).toBe("install jq poppler-utils");
    expect(requestLine({ op: "remove", names: ["jq"], check: true })).toBe("check remove jq");
    expect(requestLine({ op: "status" })).toBe("status");
    for (const good of ["jq", "libstdc++6", "python3.13", "wpa_supplicant"]) expect(isPackageName(good)).toBe(true);
    for (const bad of ["", "-o", "Jq", "jq=1.6", "a/b", "jq-", "jq+", "*", "a b"]) expect(isPackageName(bad)).toBe(false);
  });
});

describe("the client", () => {
  /** A service that answers its status as `status` says, and every change with `+ jq`. */
  const service = (status: string, seen: string[] = []) => ({
    request: async (_path: string, line: string) => {
      seen.push(line);
      return line === "status" ? `@nouride-pkg ${status}\n` : "+ jq\n@nouride-pkg ok install done\n";
    },
  });

  test("carries the request and reads the answer, once the service has said it speaks this protocol", async () => {
    const seen: string[] = [];
    const answer = await askPackages({ op: "install", names: ["jq"] }, service("ok protocol=1 backend=apt", seen));
    expect(seen).toEqual(["status", "install jq"]);
    expect(answer.status).toBe("ok");
    expect(await packageBackend(service("ok protocol=1 backend=apt"))).toBe("apt");
  });

  test("a service of another protocol is refused before anything is asked of it, with what puts it in step", async () => {
    for (const status of ["ok protocol=2 backend=apt", "ok backend=apt"]) {
      const seen: string[] = [];
      const answer = await askPackages({ op: "install", names: ["jq"] }, service(status, seen));
      expect(seen).toEqual(["status"]);
      expect(answer.status).toBe("refused");
      expect(answer.detail).toContain("re-run install.sh with --allow-packages");
      expect(await packageBackend(service(status))).toBeNull();
    }
    expect((await askPackages({ op: "status" }, service("ok protocol=2 backend=apt"))).detail).toContain("speaks protocol 2, and this daemon 1");
  });

  test("an unreachable service is an answer that says why, never a throw", async () => {
    const failing = (failure: UnixSocketFailure) => ({
      request: async (): Promise<string> => {
        throw new UnixSocketError(failure, "x");
      },
    });
    expect((await askPackages({ op: "status" }, failing("missing"))).detail).toContain("not set up on this box");
    expect((await askPackages({ op: "status" }, failing("denied"))).detail).toContain("not allowed");
    expect(await packageBackend(failing("timeout"))).toBeNull();
  });
});
