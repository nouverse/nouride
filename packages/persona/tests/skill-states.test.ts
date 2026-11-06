/**
 * `agents/<id>/skills.toml` — the file that decides which skills an agent carries.
 *
 * Two properties are worth pinning down, and both are the kind that regress into something that
 * still looks like it works: a non-boolean is **refused** rather than coerced, and the rendered file
 * keeps only decisions somebody actually made.
 */

import { describe, expect, test } from "bun:test";
import { parseToml } from "@nouride/runtime";
import { parseSkillStates, renderSkillStates } from "../src/skill-states.ts";

const WHERE = "agents/nouva/skills.toml";

describe("parseSkillStates", () => {
  test("an absent file means every skill is on", () => {
    // The common case, and the one an upgrade lands in: nobody has decided anything.
    expect(parseSkillStates(null, WHERE)).toEqual({});
    expect(parseSkillStates({}, WHERE)).toEqual({});
  });

  test("reads the [skills] table", () => {
    const raw = parseToml<{ skills?: unknown }>("[skills]\ndocument-authoring = false\nk8s = true\n");
    expect(parseSkillStates(raw, WHERE)).toEqual({ "document-authoring": false, k8s: true });
  });

  test("a non-boolean is refused, naming the file and the key", () => {
    // `= "off"` coerced to `true` would leave a skill switched on while the file says otherwise —
    // exactly the silent-setting failure this codebase keeps finding.
    const raw = parseToml<{ skills?: unknown }>('[skills]\ndocument-authoring = "off"\n');
    expect(() => parseSkillStates(raw, WHERE)).toThrow(/document-authoring must be true or false/);
    expect(() => parseSkillStates(raw, WHERE)).toThrow(/agents\/nouva\/skills.toml/);
  });

  test("a [skills] that is not a table is refused", () => {
    expect(() => parseSkillStates({ skills: ["a", "b"] }, WHERE)).toThrow(/must be a table/);
  });
});

describe("renderSkillStates", () => {
  test("round-trips through the parser", () => {
    const states = { alpha: false, zeta: true };
    expect(parseSkillStates(parseToml(renderSkillStates(states)), WHERE)).toEqual(states);
  });

  test("sorted, so saving twice does not churn the file", () => {
    const written = renderSkillStates({ zeta: false, alpha: false });
    expect(written.indexOf("alpha")).toBeLessThan(written.indexOf("zeta"));
    expect(renderSkillStates({ alpha: false, zeta: false })).toBe(written);
  });

  test("a name that is not a bare TOML key is quoted", () => {
    // A dotted bare key is a *nested table* in TOML, so an unquoted `a.b` would parse as something
    // else entirely and the toggle would silently apply to nothing.
    const written = renderSkillStates({ "a.b": false });
    expect(written).toContain('"a.b" = false');
    expect(parseSkillStates(parseToml(written), WHERE)).toEqual({ "a.b": false });
  });

  test("an empty map still writes a readable file", () => {
    // Everything switched back on. The header and its comments stay, so the operator sees where the
    // decision would go rather than an empty file that looks broken.
    const written = renderSkillStates({});
    expect(written).toContain("[skills]");
    expect(parseSkillStates(parseToml(written), WHERE)).toEqual({});
  });
});
