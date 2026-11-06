/**
 * An agent's headline (0.7.18): one short line in its IDENTITY.md that its peers read to decide whom to ask, and the
 * Agents pages show — not its system prompt. Set at creation, from onboarding or the dashboard, and edited on its page.
 */

import { describe, expect, test } from "bun:test";
import { cleanHeadline, HEADLINE_MAX, withHeadline } from "@/modules/setup/identity-headline.ts";
import { PRESETS } from "@/modules/setup/presets.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The dashboard's field, read as text: the engine's tests do not compile the dashboard's JSX. */
const DASHBOARD_MAX = Number(/const HEADLINE_MAX = (\d+);/.exec(readFileSync(join(import.meta.dir, "../../../dashboard/src/commons/components/ui/HeadlineField.tsx"), "utf8"))?.[1]);

describe("a headline", () => {
  test("is one line, at most 150 characters — the dashboard's field holds the same number", () => {
    expect(HEADLINE_MAX).toBe(150);
    expect(DASHBOARD_MAX).toBe(HEADLINE_MAX);
    expect(cleanHeadline("  Code and\\n servers  ".replace("\\n", "\n"))).toBe("Code and servers");
    expect(cleanHeadline("x".repeat(150))).toHaveLength(150);
    expect(cleanHeadline("x".repeat(151))).toBeNull();
    expect(cleanHeadline("   ")).toBeNull();
  });

  test("every preset has one, said in a line short enough to keep", () => {
    for (const preset of PRESETS) expect(cleanHeadline(preset.headline)).toBe(preset.headline);
  });
});

describe("setting it in IDENTITY.md", () => {
  test("replaces the Headline line, and nothing else moves", () => {
    const before = "# IDENTITY\n\n- **Name:** Nero\n- **Headline:** Old\n- **Emoji:** 🛠\n";
    expect(withHeadline(before, "Infra and deploys")).toBe("# IDENTITY\n\n- **Name:** Nero\n- **Headline:** Infra and deploys\n- **Emoji:** 🛠\n");
  });

  test("leaves a Role line (packs before 0.7.18) as written: since 0.8.0 it is not the headline", () => {
    const before = "# IDENTITY\n\n- **Name:** Nero\n- **Role:** Infrastructure Engineer & SRE for Nouverse Technologies\n";
    expect(withHeadline(before, "Infra: servers, deploys, VPN")).toBe(
      "# IDENTITY\n\n- **Name:** Nero\n- **Headline:** Infra: servers, deploys, VPN\n- **Role:** Infrastructure Engineer & SRE for Nouverse Technologies\n",
    );
  });

  test("goes after the Name line, else after the heading, else at the top, where there is none", () => {
    expect(withHeadline("# IDENTITY\n\n- **Name:** Lyra\n\nWrites.\n", "Writing")).toBe("# IDENTITY\n\n- **Name:** Lyra\n- **Headline:** Writing\n\nWrites.\n");
    expect(withHeadline("# Lyra\n\nWrites.\n", "Writing")).toBe("# Lyra\n\n- **Headline:** Writing\nWrites.\n");
    expect(withHeadline("Writes.\n", "Writing")).toBe("- **Headline:** Writing\nWrites.\n");
  });
});
