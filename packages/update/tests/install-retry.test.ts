/**
 * The checksum file and its signature are asked for again when the release host fails for a moment. GitHub's release
 * downloads answered 504 for minutes once, and an update whose 55 MB had finished failed at Install with
 * "fetching checksums answered 504". A 5xx, a 429 or a dropped connection is tried again, four tries in all; a 404 is
 * an answer and is not.
 */
import { describe, expect, test } from "bun:test";
import { installStaged } from "../src/install.ts";

/** A `fetch` that answers each call with the next of `answers`, a status or a thrown error, counting the calls. */
function scripted(answers: (number | "drop")[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    if (answer === "drop") throw new TypeError("fetch failed");
    return { ok: answer === 200, status: answer, text: async () => "not a checksum file" };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

/** Up to the checksum fetch and no further: the tarball's own checks come after, and any error past it means it got there. */
async function install(fetchImpl: typeof fetch): Promise<string> {
  try {
    await installStaged({
      installDir: "/nonexistent-install",
      tarball: import.meta.path,
      checksumUrl: "https://example.invalid/v9.9.9/CHECKSUMS-router",
      artifact: "nouride-linux-x64",
      swap: ["nouride"],
      host: { platform: "linux", arch: "x64" },
      fetchImpl,
      retryWaitsMs: [0, 0, 0],
    } as Parameters<typeof installStaged>[0]);
    return "installed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("the checksum file, asked for again on a passing failure", () => {
  test("504 twice, then the file: it goes on with the file", async () => {
    const net = scripted([504, 504, 200]);
    const said = await install(net.fetchImpl);
    expect(net.calls()).toBe(3);
    expect(said).not.toContain("fetching checksums answered");
  });

  test("a dropped connection, then the file: it goes on", async () => {
    const net = scripted(["drop", 200]);
    expect(await install(net.fetchImpl)).not.toContain("fetch failed");
    expect(net.calls()).toBe(2);
  });

  test("504 every time: four tries, and the error says so", async () => {
    const net = scripted([504]);
    expect(await install(net.fetchImpl)).toBe("fetching checksums answered 504 (https://example.invalid/v9.9.9/CHECKSUMS-router), 4 tries");
    expect(net.calls()).toBe(4);
  });

  test("a 404 is an answer: one try", async () => {
    const net = scripted([404]);
    expect(await install(net.fetchImpl)).toBe("fetching checksums answered 404 (https://example.invalid/v9.9.9/CHECKSUMS-router)");
    expect(net.calls()).toBe(1);
  });
});
