/**
 * The usage card's routes (0.8.13): each profile and model with its cached share and cost a million
 * input, and above them the daemon's warning when a route of a model caches far below another route of it. A provider
 * that never said what it cached shows "—", not 0 %.
 */

import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageRoutes } from "@/modules/home/components/UsageRoutes";

const route = (provider: string, model: string, requests: number, cachedShare: number | null, usdPerMillion: number | null) => ({
  provider, model, requests, inputTokens: 1_000_000, cachedShare, usdPerMillion,
});

test("the routes, their cache and cost, and the warning said as the daemon said it", () => {
  const said = "flash through profile-b cached 1 % of its input at $0.77 a million input; through profile-a, 94 % at $0.15 a million input.";
  const html = renderToStaticMarkup(
    createElement(UsageRoutes, {
      days: 7,
      routes: [route("profile-b", "flash", 400, 0.01, 0.77), route("profile-a", "flash", 300, 0.94, 0.15), route("local", "llama", 50, null, null)],
      warnings: [{ said }],
    }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain(said.replaceAll("$", "$"));
  expect(html).toContain("By provider · last 7 days");
  expect(html).toContain("<td>profile-b</td>");
  expect(html).toContain(">1%</td>");
  expect(html).toContain(">94%</td>");
  expect(html).toContain(">$0.15</td>");
  // Nothing said of its cache, nothing claimed.
  expect(html).toMatch(/<td>local<\/td><td class="break-all">llama<\/td><td class="text-right">50<\/td><td class="text-right">—<\/td><td class="text-right">—<\/td>/);
});

test("no routes yet, nothing drawn", () => {
  expect(renderToStaticMarkup(createElement(UsageRoutes, { days: 7, routes: [], warnings: [] }))).toBe("");
});
