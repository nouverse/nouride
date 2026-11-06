/**
 * The Update page below a release's upgrade floor: it offers the stepping stone, says why in the daemon's sentence (the
 * one `nouride update` prints), and with no stone does not say "Up to date".
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { UpdateStatus } from "@/commons/lib/api";
import { FloorCard } from "@/modules/update/FloorCard";
import { InstallCard } from "@/modules/update/InstallCard";
import UpdatePage from "@/modules/update/index.page";
import { UPDATE_QUERY_KEY } from "@/commons/hooks/use-update";

const STATUS: UpdateStatus = {
  supported: true,
  install: { version: "0.7.11", edition: "basic", installDir: "/srv/nouride", supervisor: "systemd", compiled: true, platform: "linux", arch: "arm64", musl: false },
  download: { status: "idle", received: 0, total: null, tag: null, artifact: null, error: null },
};
const FLOOR = { release: "v0.8.0", needs: "0.7.14", message: "update to 0.7.14 first; 0.8.0 needs it" };

const page = (check: NonNullable<UpdateStatus["check"]>) =>
  renderToString(createElement("div", null, createElement(InstallCard, { data: { ...STATUS, check } }), createElement(FloorCard, { check })))
    .replace(/<!-- -->/g, "");

describe("the Update page below a release's floor", () => {
  test("offers the stepping stone and says why", () => {
    const html = page({
      current: "0.7.11",
      latest: "v0.7.14",
      newer: true,
      publishedAt: null,
      notesUrl: null,
      latestElsewhere: "v0.8.0",
      blockedReason: "it upgrades only from 0.7.14 or later, which this install has to run first",
      floor: FLOOR,
      plan: { can: true, from: "0.7.11", to: "v0.7.14", artifact: "nouride-linux-arm64" },
    });
    expect(html).toContain("v0.7.14");
    expect(html).toContain("update to 0.7.14 first; 0.8.0 needs it");
    expect(html).toContain("0.8.0 needs 0.7.14 first");
    // Not the generic "no build for this edition" note: the floor card says it.
    expect(html).not.toContain("Each edition is published on its own");
  });

  test("with no stone, it is not 'Up to date'", () => {
    const html = page({ current: "0.7.11", latest: "0.7.11", newer: false, publishedAt: null, notesUrl: null, latestElsewhere: "v0.8.0", floor: FLOOR });
    expect(html).not.toContain("Up to date");
    expect(html).toContain("Needs 0.7.14 first");
    expect(html).toContain("install 0.7.14 by hand");
  });

  test("the page itself shows it, beside the step that downloads the stone", () => {
    const check = { current: "0.7.11", latest: "v0.7.14", newer: true, publishedAt: null, notesUrl: null, floor: FLOOR, plan: { can: true, from: "0.7.11", to: "v0.7.14", artifact: "nouride-linux-arm64" } };
    const client = new QueryClient();
    client.setQueryData(UPDATE_QUERY_KEY, { ...STATUS, check });
    const html = renderToString(createElement(QueryClientProvider, { client }, createElement(UpdatePage))).replace(/<!-- -->/g, "");
    expect(html).toContain("update to 0.7.14 first; 0.8.0 needs it");
    expect(html).toContain("Install v0.7.14");
  });

  test("without a floor there is no card", () => {
    expect(renderToString(createElement(FloorCard, { check: { current: "0.7.11", latest: "v0.7.12", newer: true, publishedAt: null, notesUrl: null } }))).toBe("");
  });
});

/**
 * A Pro licence past its year of updates: newer releases exist and none is offered. It is said as what it is — the
 * install keeps working, critical releases still come — and not as "Up to date", nor as the channel being unreachable.
 */
describe("the Update page past a licence's year of updates", () => {
  const NOTICE =
    "this licence's updates ended on 2027-10-27 — Nouride keeps working as it is, and releases marked critical still come; newer releases come with a renewal";

  test("says the updates ended and that the install keeps working, not 'Up to date'", () => {
    const html = page({ current: "0.8.4", latest: "0.8.4", newer: false, publishedAt: null, notesUrl: null, notice: NOTICE });
    expect(html).toContain("This licence&#x27;s updates ended on 2027-10-27 — Nouride keeps working as it is");
    expect(html).toContain("Newest for this licence");
    expect(html).not.toContain("Up to date");
    expect(html).not.toContain("could not be reached");
  });
});
