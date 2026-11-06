/**
 * Sizes as a person reads them — the one `formatBytes` the file picker, the update page, MCP's schema
 * cost, the archive line and the approval card all use now.
 */

import { describe, expect, test } from "bun:test";
import { formatBytes } from "@/commons/lib/format";

describe("formatBytes", () => {
  test("bytes, then whole kilobytes, then megabytes to one place", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(921_792)).toBe("900 KB");
    expect(formatBytes(57 * 1024 * 1024)).toBe("57.0 MB");
  });
});
