/**
 * Which links in an agent's answer open a page of this dashboard (`commons/lib/page-link.ts`).
 *
 * The answer is a model's text, and what it read on the way: a link in it is drawn for a click. So each case here is
 * either a page the person asked to be taken to and could not click, or a place a click must not reach from inside
 * the dashboard: another site made to look like a path, or the daemon's own routes.
 */

import { describe, expect, test } from "bun:test";
import { pageInDashboard } from "@/commons/lib/page-link";

const HERE = { origin: "https://box.example", basepath: "/dashboard" };
const page = (href: string) => pageInDashboard(href, HERE);

describe("a page of this dashboard", () => {
  test("by its path, with its query and its place on the page, as the router takes it", () => {
    expect(page("/dashboard/memories/graph")).toBe("/memories/graph");
    expect(page("/dashboard/automations/cron_1")).toBe("/automations/cron_1");
    expect(page("/dashboard/mcp?install=github&agent=nouva")).toBe("/mcp?install=github&agent=nouva");
    expect(page("/dashboard/access?tab=history#newest")).toBe("/access?tab=history#newest");
    // Home, with and without the slash after it.
    expect(page("/dashboard")).toBe("/");
    expect(page("/dashboard/")).toBe("/");
  });

  test("by this dashboard's own address in full: the same page, opened here and not in a second tab", () => {
    expect(page("https://box.example/dashboard/missions/msn_1")).toBe("/missions/msn_1");
    expect(page("HTTPS://BOX.example/dashboard/skills")).toBe("/skills");
  });

  test("with the base the router has, whatever slash it ends in", () => {
    expect(pageInDashboard("/dashboard/skills", { origin: "https://box.example", basepath: "/dashboard/" })).toBe("/skills");
    expect(pageInDashboard("/skills", { origin: "https://box.example", basepath: "/" })).toBe("/skills");
  });
});

describe("not a page of this dashboard", () => {
  test("another site, also one written to look like a path here", () => {
    for (const href of [
      "https://example.com/dashboard/skills",
      "http://box.example/dashboard/skills", // the same host over another scheme is another origin
      "https://box.example.evil.test/dashboard/skills",
      "//evil.test/dashboard/skills",
      "/\\evil.test/dashboard/skills",
      "https://box.example@evil.test/dashboard/skills",
    ]) {
      expect(page(href), href).toBeNull();
    }
  });

  test("another part of this one: the daemon's own routes, and a path that climbs out of the dashboard to them", () => {
    for (const href of ["/api/control/secrets", "/health", "/dashboardx/skills", "/dashboard/../api/control/secrets", "/dashboard/%2e%2e/api/control/secrets", "/dashboard\\..\\api\\control\\secrets", "https://box.example/api/control/secrets"]) {
      expect(page(href), href).toBeNull();
    }
  });

  test("what is no address of a page: a script, data, a file's path said relative, an empty one, the login form", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "dashboard/skills", "./skills", "?tab=x", "#top", "", "mailto:a@b.c", "/dashboard/login?next=/skills"]) {
      expect(page(href), href).toBeNull();
    }
  });
});
