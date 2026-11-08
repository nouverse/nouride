/**
 * A model's arguments held to the schema a server declared, before a call is sent — `required`, and each declared
 * property's top-level `type`, and nothing more.
 *
 * Each rule is held by a case that only it decides: a schema with the rule and arguments that break only that rule.
 */

import { describe, expect, test } from "bun:test";
import { argumentProblems } from "../src/arguments.ts";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

describe("required", () => {
  test("a name it lists must be there — each missing one is said", () => {
    expect(argumentProblems(schema({ a: {}, b: {} }, ["a", "b"]), {})).toEqual(['"a" is required', '"b" is required']);
  });

  test("present is enough, null included: whether null is allowed is the type's to say", () => {
    expect(argumentProblems(schema({ a: {} }, ["a"]), { a: null })).toEqual([]);
  });

  test("a list that is not one, and entries that are not names, require nothing", () => {
    expect(argumentProblems({ type: "object", required: "a" }, {})).toEqual([]);
    expect(argumentProblems({ type: "object", required: [1, null] }, {})).toEqual([]);
  });

  test("a name only inherited is not there", () => {
    expect(argumentProblems(schema({}, ["toString"]), {})).toEqual(['"toString" is required']);
  });
});

describe("type", () => {
  const one = (type: unknown, value: unknown) => argumentProblems(schema({ v: { type } }), { v: value });

  test.each([
    ["string", "text", 5, '"v" must be a string, not 5'],
    ["number", 2.5, "2.5", '"v" must be a number, not a string'],
    ["integer", 3, 3.5, '"v" must be an integer, not 3.5'],
    ["boolean", false, "false", '"v" must be a boolean, not a string'],
    ["array", [], { 0: "a" }, '"v" must be an array, not an object'],
    ["object", {}, [], '"v" must be an object, not an array'],
    ["null", null, 0, '"v" must be null, not 0'],
  ])("%s takes %p and refuses %p", (type, good, bad, said) => {
    expect(one(type, good)).toEqual([]);
    expect(one(type, bad)).toEqual([said]);
  });

  test("an integer is a number; a number is not an integer", () => {
    expect(one("number", 4)).toEqual([]);
    expect(one("integer", 4.25)).toHaveLength(1);
  });

  test("an object is neither null nor an array", () => {
    expect(one("object", null)).toEqual(['"v" must be an object, not null']);
  });

  test("a list of types takes any of them", () => {
    expect(one(["string", "null"], null)).toEqual([]);
    expect(one(["string", "null"], "x")).toEqual([]);
    expect(one(["string", "null"], 1)).toEqual(['"v" must be a string or null, not 1']);
  });

  test("a type it does not know — or none — is not checked, rather than refusing a call it cannot judge", () => {
    expect(one("str", 5)).toEqual([]);
    expect(one(["string", "date"], 5)).toEqual([]);
    expect(one(undefined, 5)).toEqual([]);
    expect(argumentProblems(schema({ v: { anyOf: [{ type: "string" }] } }), { v: 5 })).toEqual([]);
  });
});

describe("what it leaves alone", () => {
  test("a property the schema does not declare", () => {
    expect(argumentProblems(schema({ a: { type: "string" } }), { a: "x", extra: 1 })).toEqual([]);
  });

  test("anything below the top level: a nested schema is the server's to judge", () => {
    const nested = schema({ filter: { type: "object", properties: { since: { type: "string" } }, required: ["since"] } });
    expect(argumentProblems(nested, { filter: { since: 5 } })).toEqual([]);
  });

  test("a schema that is not an object, or declares no properties", () => {
    expect(argumentProblems(undefined, { a: 1 })).toEqual([]);
    expect(argumentProblems("nonsense", { a: 1 })).toEqual([]);
    expect(argumentProblems({ type: "object" }, { a: 1 })).toEqual([]);
  });
});

test("every problem is said, in the order the schema and the call have them", () => {
  const declared = schema({ title: { type: "string" }, labels: { type: "array" }, count: { type: "integer" } }, ["title", "body"]);
  expect(argumentProblems(declared, { labels: "bug", count: "3" })).toEqual([
    '"title" is required',
    '"body" is required',
    '"labels" must be an array, not a string',
    '"count" must be an integer, not a string',
  ]);
});
