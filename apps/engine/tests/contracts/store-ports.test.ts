/**
 * The proof that a store is now swappable, and the reason it is worth having.
 *
 * Before the ports existed, `constructor(private readonly db: SqliteDb)` made every store
 * structurally un-fakeable: a `private` member is part of the type, so nothing but that class is
 * assignable to it. The consequence was measurable — 18 test files open a temp SQLite file and run
 * 30 migrations, several of them to assert on business logic that never reads a row.
 *
 * So this test does the thing that used to be impossible: it drives real pipeline code with a plain
 * object in place of a store. No database, no migrations, no temp directory. If a future change puts
 * the handle back into a signature, this file stops compiling — which is the point, and is a
 * stronger guarantee than the two lint rules can give on their own.
 *
 * Second implementations are checked the same way, one type-level assertion each, because the
 * question a port has to answer is not "does SQLite satisfy it" but "would anything else".
 */

import { describe, expect, test } from "bun:test";
import type { Port } from "@nouride/shared";
import type {
  ChatAttachment,
  ChatAttachmentsPort,
} from "@/modules/attachments/chat-attachments.store.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { RoomsPort } from "@/modules/rooms/rooms.store.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { createAttachmentReadTool } from "@/modules/tools/builtins/attachment.ts";

const file = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  ref: "fabc123",
  gateway: "discord",
  chatId: "room-1",
  gatewayId: "discord:nouva",
  name: "dog.jpg",
  mimeType: "image/jpeg",
  kind: "image",
  size: 240_000,
  fromAgent: "nero",
  at: 1_757_000_000_000,
  ...over,
});

describe("a store can be replaced by a plain object", () => {
  test("real tool code runs against a plain object, with no database", () => {
    /**
     * The thing that was impossible before the ports existed. `attachment_read` reaches its store
     * through four closures, so a fake here needs only the two the listing path calls — and the
     * assertion is on the tool's real output, not on a mock being called.
     */
    const held = [file({ name: "screenshot.png", fromAgent: "nox" })];
    const tool = createAttachmentReadTool({
      find: (_ctx, ref) => held.find((entry) => entry.ref === ref) ?? null,
      list: () => held,
      open: async () => ({ error: "not reached by a listing" }),
      describe: async () => ({ error: "not reached by a listing" }),
      imageMode: () => "native" as const,
      listen: async () => ({ ok: false, reason: "not_advertised" }) as const,
      watch: async () => ({ media: [], lines: [] }),
    });

    return tool.execute({}, { agentId: "nouva", chatId: "room-1" } as never).then((result) => {
      expect(result.isError).toBe(false);
      expect(result.content).toContain("screenshot.png");
      expect(result.content).toContain("from nox");
    });
  });

  test("a fake satisfies the whole port, not only the method under test", () => {
    // The completeness property. A port derived from the class enumerates its surface, so an
    // implementation that forgets a method is a compile error rather than a runtime one.
    const complete: ChatAttachmentsPort = {
      register: () => "fabc123",
      markStored: () => undefined,
      find: () => file(),
      recent: () => [file()],
      since: () => [],
      sweep: () => 0,
      deleteForChat: () => 0,
    };

    expect(complete.find("fabc123", { gateway: "discord", gatewayId: "discord:nouva", chatId: "room-1", chatType: "channel" })?.name).toBe("dog.jpg");
  });
});

describe("what the ports promise about a second engine", () => {
  test("the SQLite store still satisfies its own port", () => {
    // Adopting a port must not be a rewrite of the store. Checked at the type level, which is where
    // the guarantee lives — the assignment is the assertion.
    const asPort: (store: ChatAttachmentIndex) => ChatAttachmentsPort = (store) => store;
    expect(typeof asPort).toBe("function");
  });

  test("a port carries no database handle, so another engine can implement it", () => {
    /**
     * The property that makes a Postgres store possible at all: `keyof` sees only public members, so
     * the private `db` field is not part of the port. If somebody makes the handle public — or
     * declares a store without `private` — this stops compiling, and that is the failure worth
     * catching early rather than during a port.
     */
    type Handles = Extract<keyof ChatAttachmentsPort, "db">;
    const noHandle: [Handles] extends [never] ? true : false = true;
    expect(noHandle).toBe(true);
  });

  test("every port under refactor is free of one, not just this one", () => {
    // Spot-checked across the three shapes: a plain store, one with a transaction, one with an
    // in-memory cache beside the handle (`TurnStore.nextSeq`).
    type Leaks =
      | Extract<keyof ChatEventsPort, "db">
      | Extract<keyof RoomsPort, "db">
      | Extract<keyof TurnsPort, "db" | "nextSeq">;
    const clean: [Leaks] extends [never] ? true : false = true;
    expect(clean).toBe(true);
  });

  test("Port<T> keeps public members and drops private ones", () => {
    // The helper's own contract, asserted directly rather than trusted.
    class Example {
      constructor(private readonly db: number) {}
      read(): number {
        // Calls the private member, which is the point: it is real, it is used, and it is still not
        // part of `Port<Example>`.
        return this.doubled();
      }
      private doubled(): number {
        return this.db * 2;
      }
    }
    const asObject: Port<Example> = { read: () => 7 };
    type Dropped = Extract<keyof Port<Example>, "db" | "doubled">;
    const dropped: [Dropped] extends [never] ? true : false = true;

    expect(asObject.read()).toBe(7);
    expect(dropped).toBe(true);
  });
});
