/**
 * The credentials a person sent, held under handles: for their own conversation, an hour from when they were last
 * sent, the same handle for the same value, and never more of them than the ceiling.
 */

import { describe, expect, test } from "bun:test";
import { handlesIn, TransientSecrets } from "../src/transient.ts";

const HOUR = 60 * 60_000;

describe("TransientSecrets", () => {
  test("a handle is a shell variable, and holds its value for its own conversation only", () => {
    const held = new TransientSecrets();
    const handle = held.hold("s3cr3t-Value-1", { scope: "chat-a", label: "a password or key", from: "u1" });
    expect(handle).toMatch(/^\$TMP_SECRET_[0-9A-F]{12}$/);
    expect(held.get(handle, "chat-a")).toMatchObject({ value: "s3cr3t-Value-1", label: "a password or key", from: "u1", name: handle.slice(1) });
    expect(held.get(handle.slice(1), "chat-a")?.value).toBe("s3cr3t-Value-1");
    expect(held.get(handle, "chat-b")).toBeUndefined();
    expect(held.valuesFor("chat-a")).toEqual({ [handle.slice(1)]: "s3cr3t-Value-1" });
    expect(held.valuesFor("chat-b")).toEqual({});
  });

  test("the same value sent again in the same conversation is the same handle, and its hour starts over", () => {
    let now = 0;
    const held = new TransientSecrets({ now: () => now });
    const first = held.hold("s3cr3t-Value-1", { scope: "chat-a", label: "x", from: "u1" });
    now = HOUR - 1;
    expect(held.hold("s3cr3t-Value-1", { scope: "chat-a", label: "x", from: "u1" })).toBe(first);
    // Another conversation's copy is its own.
    expect(held.hold("s3cr3t-Value-1", { scope: "chat-b", label: "x", from: "u1" })).not.toBe(first);
    now = HOUR + 10;
    expect(held.get(first, "chat-a")?.value).toBe("s3cr3t-Value-1");
    now = 2 * HOUR;
    expect(held.get(first, "chat-a")).toBeUndefined();
  });

  test("gone an hour after it was sent, and gone when let go", () => {
    let now = 0;
    const held = new TransientSecrets({ now: () => now });
    const handle = held.hold("s3cr3t-Value-1", { scope: "chat-a", label: "x", from: "u1" });
    now = HOUR - 1;
    expect(held.values()).toEqual({ [handle.slice(1)]: "s3cr3t-Value-1" });
    now = HOUR;
    expect(held.values()).toEqual({});

    const again = held.hold("s3cr3t-Value-2", { scope: "chat-a", label: "x", from: "u1" });
    held.release(again);
    expect(held.get(again, "chat-a")).toBeUndefined();
  });

  test("never more than its ceiling — the oldest go first", () => {
    const held = new TransientSecrets({ max: 3 });
    const handles = ["v-0000001", "v-0000002", "v-0000003", "v-0000004"].map((value) => held.hold(value, { scope: "s", label: "x", from: "u" }));
    expect(Object.keys(held.values())).toEqual(handles.slice(1).map((handle) => handle.slice(1)));
  });
});

describe("handlesIn", () => {
  test("each handle a command names, once — and nothing that only starts like one", () => {
    expect(handlesIn('curl -H "Authorization: Bearer $TMP_SECRET_0A1B2C3D4E5F" https://x && echo $TMP_SECRET_0A1B2C3D4E5F $TMP_SECRET_FFFFFFFFFFFF')).toEqual([
      "$TMP_SECRET_0A1B2C3D4E5F",
      "$TMP_SECRET_FFFFFFFFFFFF",
    ]);
    expect(handlesIn("$TMP_SECRET_0A1B2C3D4E5FG $TMP_SECRET_0A1B $TMP_SECRET_0a1b2c3d4e5f")).toEqual([]);
  });
});

describe("the ceiling, against a printed credential file", () => {
  test("hundreds held — a few long .env files across a few chats — push out nothing a chat still uses", () => {
    const held = new TransientSecrets();
    const first = held.hold("sent-in-chat-Value", { scope: "chat-a", label: "a password or key", from: "u1" });
    for (let i = 0; i < 400; i += 1) held.hold(`VAR_${i}-value-x9Q`, { scope: `chat-${i % 4}`, label: `VAR_${i} in .env`, from: "u1" });
    expect(held.get(first, "chat-a")?.value).toBe("sent-in-chat-Value");
  });
});
