/**
 * A tool's result as MCP 2025-06-18 shapes it, read the way the model will.
 *
 * `structuredContent` is the answer as data: a server is asked to put the same in a text block, so the text is what
 * the model reads when there is any, and a result with only the data has the data written out — it read as empty
 * before. A `resource_link` is one line naming the link, its address first, where it was "[resource_link content, not
 * renderable as text]". `isError` is as it was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { McpClient } from "../src/client.ts";
import { flattenContent } from "../src/protocol.ts";
import { stdioClient } from "./fixtures/clients.ts";

const opened: McpClient[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

async function connected(): Promise<McpClient> {
  const client = stdioClient({});
  opened.push(client);
  await client.connect();
  return client;
}

describe("from a real server", () => {
  test("structured content beside its text: the text is what is read", async () => {
    const client = await connected();
    expect(await client.callTool("structured", {})).toStrictEqual({
      text: "22.5°C, partly cloudy",
      isError: false,
      images: [],
      structured: { temperature: 22.5, conditions: "Partly cloudy" },
    });
  });

  test("the data comes back beside the text, so whoever holds the tool's output schema can check it; none when there is none", async () => {
    const client = await connected();
    expect((await client.callTool("structured", { text: false })).structured).toEqual({ temperature: 22.5, conditions: "Partly cloudy" });
    expect(await client.callTool("echo", { text: "hi" })).not.toHaveProperty("structured");
  });

  test("a tool's declared output schema is kept from the listing; a schema that is not an object is not one", async () => {
    const outputSchema = { type: "object", properties: { temperature: { type: "number" } }, required: ["temperature"] };
    const client = stdioClient({ tools: [{ name: "weather", outputSchema }, { name: "odd", outputSchema: ["nope"] as never }] });
    opened.push(client);
    await client.connect();
    const tools = await client.listTools();
    expect(tools.find((tool) => tool.name === "weather")?.outputSchema).toEqual(outputSchema);
    expect(tools.find((tool) => tool.name === "odd")).not.toHaveProperty("outputSchema");
  });

  test("structured content alone: written out, rather than an answer that reads as empty", async () => {
    const client = await connected();
    expect((await client.callTool("structured", { text: false })).text).toBe('{"temperature":22.5,"conditions":"Partly cloudy"}');
  });

  test("a resource link is a line with its address, on one line however the server wrote it", async () => {
    const client = await connected();
    expect((await client.callTool("link", {})).text).toBe(
      "The entry point:\n[resource link: main.rs] file:///project/src/main.rs (text/x-rust): Primary application entry point",
    );
  });

  test("a failure the tool reports is still a result", async () => {
    const client = await connected();
    expect(await client.callTool("no_such_tool", {})).toEqual({ text: "no tool no_such_tool", isError: true, images: [] });
  });
});

describe("each rule", () => {
  test("text is preferred only when it says something: an empty text block leaves the data to be read", () => {
    expect(flattenContent({ content: [{ type: "text", text: "  " }], structuredContent: { ok: true } })).toBe('{"ok":true}');
  });

  test("data with no text is read alongside the rest: a picture is still numbered", () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    expect(flattenContent({ content: [image], structuredContent: { width: 1 } })).toBe('{"width":1}\n[image 1]');
  });

  test("no data at all — absent or null — adds nothing", () => {
    expect(flattenContent({ content: [] })).toBe("");
    expect(flattenContent({ content: [], structuredContent: null })).toBe("");
  });

  test("a link's title is its label before its name; its size is said; a link with no address is no link", () => {
    expect(flattenContent({ content: [{ type: "resource_link", uri: "https://x.test/a.pdf", name: "a.pdf", title: "The report", size: 2048 }] })).toBe(
      "[resource link: The report] https://x.test/a.pdf (2048 bytes)",
    );
    expect(flattenContent({ content: [{ type: "resource_link", uri: "file:///b" }] })).toBe("[resource link] file:///b");
    expect(flattenContent({ content: [{ type: "resource_link", name: "nowhere" }] })).toBe("[resource_link content, not renderable as text]");
  });

  test("content that is not a list, or blocks that are not objects, are passed over rather than thrown on", () => {
    expect(flattenContent({ content: "oops" as never, structuredContent: { ok: 1 } })).toBe('{"ok":1}');
    expect(flattenContent({ content: [null, 7, { type: "text", text: "kept" }] as never })).toBe("kept");
  });
});
