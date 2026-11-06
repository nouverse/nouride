/**
 * Every control route reads its body through `jsonBody` (`web/control/payloads.ts`).
 *
 * `c.req.json()` answers a body of `null` with `null`, and the routes read it through `.catch(() => ({}))`, which only
 * catches a body that is not JSON — so a `null` reached `body.minutes` and the route answered 500. One reader that
 * hands a route an object or nothing, and no route reading the body any other way.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonBody } from "@/modules/web/control/payloads.ts";

const asRequest = (body: string) => ({ req: { json: async () => JSON.parse(body) as unknown } });

describe("a JSON body", () => {
  test("is the object it holds", async () => {
    expect(await jsonBody(asRequest('{"minutes":5}'))).toEqual({ minutes: 5 });
  });

  test("is nothing when it is JSON of another shape, or not JSON at all", async () => {
    for (const body of ["null", "[1,2]", "5", '"text"', "true", "{not json"]) {
      expect({ body, read: await jsonBody(asRequest(body)) }).toEqual({ body, read: null });
    }
  });
});

describe("the control routes", () => {
  test("read a body only through jsonBody", () => {
    const routes = join(import.meta.dir, "../../src/modules/web/control/routes");
    const readers = readdirSync(routes)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /\.req\.json\(\)/.test(readFileSync(join(routes, file), "utf8")));
    expect(readers).toEqual([]);
  });
});
