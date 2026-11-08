/**
 * The menu by how often a page is opened (0.8.24): which item is the page you are on, which tabs a section's pages
 * carry, and which pages a person may see. Asserted on the decisions, apart from the shell that draws them.
 */

import { describe, expect, test } from "bun:test";
import { DAILY, SETTINGS, isCurrent, visible } from "@/commons/components/layout/nav";
import { sectionTabs } from "@/commons/components/layout/SectionTabs";

const item = (to: string) => DAILY.find((one) => one.to === to)!;

describe("the page you are on", () => {
  test("is a section's item on the pages it holds, and on the pages under them", () => {
    expect(["/work", "/missions", "/missions/msn_1", "/jobs/job_1", "/schedule", "/webhooks"].every((path) => isCurrent(item("/work"), path))).toBe(true);
    expect(isCurrent(item("/agents"), "/office")).toBe(true);
    expect(isCurrent(item("/agents"), "/agents/nix/model")).toBe(true);
  });

  test("Home only at its own address, and no item by a shared beginning of a name", () => {
    expect(isCurrent(item("/"), "/")).toBe(true);
    expect(isCurrent(item("/"), "/chat")).toBe(false);
    // `/chatbot` is not under `/chat`.
    expect(isCurrent(item("/chat"), "/chatbot")).toBe(false);
    expect(isCurrent(item("/work"), "/workflows")).toBe(false);
  });
});

describe("a section's tabs", () => {
  test("over its list pages, and none over one mission or one agent", () => {
    expect(sectionTabs("/jobs")?.map((tab) => tab.label)).toEqual(["Waiting for you", "Missions", "Helpers", "Schedule", "Webhooks"]);
    expect(sectionTabs("/webhooks")?.[0]?.to).toBe("/work");
    expect(sectionTabs("/people/")?.map((tab) => tab.to)).toEqual(["/memories", "/people", "/groups"]);
    expect(sectionTabs("/office")?.map((tab) => tab.to)).toEqual(["/agents", "/office"]);
    expect(sectionTabs("/missions/msn_1")).toBeNull();
    expect(sectionTabs("/agents/nix")).toBeNull();
    expect(sectionTabs("/")).toBeNull();
  });
});

describe("what a person may see", () => {
  const settings = SETTINGS.flatMap((group) => group.items);
  test("a member sees no admin page, a box's page only on a paired box, the gateway only where it is hosted", () => {
    const shown = (where: Parameters<typeof visible>[1]) => visible(settings, where).map((one) => one.label);
    expect(shown({ admin: false, onBox: true, hostsGateway: true })).toEqual(["Connectors", "Access", "My Account", "Logs"]);
    expect(shown({ admin: true, onBox: false, hostsGateway: false })).not.toContain("My Box");
    expect(shown({ admin: true, onBox: false, hostsGateway: false })).not.toContain("LLM Gateway");
    expect(shown({ admin: true, onBox: true, hostsGateway: true })).toEqual(expect.arrayContaining(["My Box", "LLM Gateway", "Models", "Secrets"]));
  });

  test("every page of Settings says what it is for, in a line", () => {
    for (const one of settings) expect({ page: one.label, about: (one.about ?? "").length > 20 }).toEqual({ page: one.label, about: true });
  });
});
