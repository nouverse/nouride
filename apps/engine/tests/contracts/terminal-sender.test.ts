/**
 * Who writes from a terminal is `terminal` (0.7.18), not `dev`: memory had filed `nouride chat` as a person, `web:dev`.
 * The default, and a `[[people]]` id written the old way.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { LocalGateway, TERMINAL_SENDER } from "@/modules/gateways/local.ts";
import { canonicalPersonId, findPerson, refusePersonId } from "@/modules/people/match.ts";
import { readPeople } from "@/modules/people/entry.ts";
import type { Person } from "@nouride/shared";

describe("a message that names no sender", () => {
  test("is from the terminal", () => {
    const local = new LocalGateway();
    const seen: MessageEnvelope[] = [];
    local.onMessage((envelope) => seen.push(envelope));
    local.dispatch({ agent: "nouva", chatId: "c1", text: "hi" });
    expect(TERMINAL_SENDER).toBe("terminal");
    expect(seen.map((envelope) => [envelope.senderId, envelope.senderName])).toEqual([["terminal", "Terminal"]]);
  });
});

describe("a [[people]] entry that names the terminal's old id", () => {
  // `web:dev` until 0.7.18; 0.7.x rewrote it in every file, and 0.8.0 refuses it at load, naming today's.
  test("is refused, naming web:terminal — and not read as it", () => {
    expect(refusePersonId("web:dev")).toContain('write it as "web:terminal"');
    expect(canonicalPersonId("web:dev")).toBe("web:dev");
    const [person] = readPeople([{ key: "ops", ids: ["web:terminal"], name: "Ops" }]) as [Person];
    expect(findPerson([person], { gatewayId: "web:dashboard", senderId: "terminal" })?.name).toBe("Ops");
  });
});
