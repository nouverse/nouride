import { describe, expect, test } from "bun:test";
import { ConfigError } from "@nouride/shared";
import { crashDetail, crashReport } from "@/commons/crash.ts";

describe("what a crash leaves in the log", () => {
  test("names the error's class, not only its message, and keeps the stack for symbolize", () => {
    const detail = crashDetail(new ConfigError("[memory] dir is not writable"));
    expect(detail.error).toBe("ConfigError: [memory] dir is not writable");
    expect(detail.stack).toContain("ConfigError: [memory] dir is not writable\n    at ");
  });

  test("a thrown value that is not an Error is its text, with no stack to invent", () => {
    expect(crashDetail("socket hang up")).toEqual({ error: "socket hang up" });
  });
});

describe("what a command says when a throw reaches its top", () => {
  test("a refusal the code meant is its class and message, with no stack to read past", () => {
    expect(crashReport(new ConfigError("[memory] dir is not writable"))).toEqual({ message: "ConfigError: [memory] dir is not writable", stack: null });
  });

  test("anything else is a crash, and keeps the stack symbolize reads", () => {
    const report = crashReport(new TypeError("null is not an object (evaluating 'A.minutes')"));
    expect(report.message).toBe("TypeError: null is not an object (evaluating 'A.minutes')");
    expect(report.stack).toContain("TypeError: null is not an object");
  });
});
