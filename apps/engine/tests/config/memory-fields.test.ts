/**
 * Which setting `[memory]`'s check refuses (0.8.23): the Memory page saves several at once, and says which one to fix
 * rather than "check what you entered". The loader reads the same refusal as a `ConfigError`, as it always did.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError, type MemorySection, type ProviderProfile } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { MemoryConfigError, validateMemory } from "@/modules/config/global/validate-memory.ts";

const PROVIDERS = {
  ollama: { kind: "openai", baseUrl: "http://localhost:11434/v1", apiKeySecret: "ollama" },
  claude: { kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeySecret: "claude" },
} as unknown as Record<string, ProviderProfile>;

/** The setting a memory section is refused for, or "valid". */
function refused(memory: Partial<MemorySection>, semantic: Partial<MemorySection["semantic"]> = {}): string {
  const section = { ...DEFAULT_CONFIG.memory, ...memory, semantic: { ...DEFAULT_CONFIG.memory.semantic, ...semantic } };
  try {
    validateMemory({ memory: section, providers: PROVIDERS });
    return "valid";
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err instanceof MemoryConfigError ? err.field : "no field";
  }
}

describe("[memory] refused, by the setting the page names", () => {
  test("the defaults are valid, so each case below fails for its own reason", () => {
    expect(refused({})).toBe("valid");
  });

  test("each number and time against its own bounds", () => {
    expect(refused({ promptRecent: 21 })).toBe("promptRecent");
    expect(refused({ transcriptDays: -1 })).toBe("transcriptDays");
    expect(refused({ passAt: "25:00" })).toBe("passAt");
    expect(refused({ facts: "sometimes" as never })).toBe("facts");
    expect(refused({ passPerNight: 0 })).toBe("passPerNight");
    expect(refused({ passMaxTokens: -1 })).toBe("passMaxTokens");
    expect(refused({ maxAttempts: 11 })).toBe("maxAttempts");
  });

  test("the helper model and its provider: the one left empty, a provider that is no profile, a tier beside one", () => {
    expect(refused({ passModel: "m-1", passProvider: "" })).toBe("passProvider");
    expect(refused({ passModel: "", passProvider: "ollama" })).toBe("passModel");
    expect(refused({ passModel: "m-1", passProvider: "ghost" })).toBe("passProvider");
    expect(refused({ passModel: "small", passProvider: "ollama" })).toBe("passProvider");
    expect(refused({ passModel: "m-1", passProvider: "ollama" })).toBe("valid");
  });

  test("search by meaning: its dimensions, its provider, its model", () => {
    expect(refused({}, { dimensions: 16 })).toBe("semanticDimensions");
    expect(refused({}, { enabled: true, provider: "", model: "bge-m3" })).toBe("semanticProvider");
    expect(refused({}, { enabled: true, provider: "ollama", model: "" })).toBe("semanticModel");
    expect(refused({}, { enabled: true, provider: "ghost", model: "bge-m3" })).toBe("semanticProvider");
    expect(refused({}, { enabled: true, provider: "claude", model: "bge-m3" })).toBe("semanticProvider");
    expect(refused({}, { enabled: true, provider: "ollama", model: "bge-m3" })).toBe("valid");
  });
});
