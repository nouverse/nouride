/**
 * What a new chat connection is called before anybody types.
 *
 * The default was `"main"` on every agent and every platform, and the cost was not cosmetic: the
 * save is an upsert keyed on `<platform>:<name>`, so the second agent to accept the default took the
 * first one's connection over — same id, and the incoming `agent` wins. Nothing refused it and
 * nothing said it had happened.
 */

import { describe, expect, test } from "bun:test";
import { defaultConnectionName } from "@/modules/agents/components/connection-name";

describe("the default connection identifier", () => {
  test("is the agent's own id, so two agents cannot collide by accepting it", () => {
    expect(defaultConnectionName("ren")).toBe("ren");
    expect(defaultConnectionName("nouva")).toBe("nouva");
    expect(defaultConnectionName("ren")).not.toBe(defaultConnectionName("nouva"));
  });

  test("is lowercased and trimmed, because the id it becomes is", () => {
    // `saveGateway` lowercases and trims before building `<platform>:<name>`. A default that did
    // not would show `whatsapp:Ren` in the hint and save `whatsapp:ren`.
    expect(defaultConnectionName("  Ren  ")).toBe("ren");
  });

  test("falls back rather than producing an empty id", () => {
    // No caller should pass an empty agent id, and a bare `whatsapp:` is not the thing to render if
    // one ever does.
    expect(defaultConnectionName("")).toBe("main");
    expect(defaultConnectionName("   ")).toBe("main");
  });
});
