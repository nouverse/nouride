/**
 * Who is asking, on every request to a model's endpoint: this client's own name and version, where the HTTP library's
 * went before. A service that tells its clients apart asks for exactly that (OpenCode Go: "identify itself with its
 * own user agent, rather than a generic SDK or HTTP-library name"). A profile's own `headers` can say another.
 */
const CLIENT_HEADERS = { "user-agent": `nouride/${VERSION}` };

/**
 * Provider profiles → live clients.
 *
 * One client per profile, shared by every agent that names it. The credential is resolved
 * once here from the secret store, so it exists in exactly one place in memory and never
 * appears in an agent config, a log line, or the dashboard.
 */

import { createProvider, profileHeaders, type HttpDeps } from "@nouride/llm";
import { withEgressMask } from "@/commons/egress.ts";
import { VERSION } from "@/commons/version.ts";
import {
  ConfigError,
  createLogger,
  type GlobalConfig,
  type LLMProvider,
  type ProviderProfile,
} from "@nouride/shared";
import type { SecretStore } from "@nouride/secrets";
import { ModelCatalog } from "./catalog.ts";

const log = createLogger("llm.providers");

export class ProviderRegistry {
  private clients = new Map<string, LLMProvider>();
  /** What each profile's endpoint says about its models — one listing per profile, for hearing and for windows. */
  readonly catalog: ModelCatalog;

  constructor(
    private readonly profiles: GlobalConfig["providers"],
    private readonly secrets: SecretStore,
    /** Retry and fetch behaviour, injectable so tests never touch the network. */
    private readonly http?: HttpDeps,
    /** Every credential the daemon knows, which every request is masked of before it leaves (`commons/egress.ts`). */
    private readonly known?: () => Record<string, string>,
  ) {
    this.catalog = new ModelCatalog({
      endpointFor: (name) => this.endpointFor(name),
      ...(http?.fetchImpl ? { fetchImpl: http.fetchImpl } : {}),
    });
  }

  /**
   * Client for a profile name, created on first use.
   *
   * Lazily, not at boot: a profile nobody references should not require its credential to
   * be present. Otherwise the two default profiles would make every deployment declare both
   * an Anthropic and an OpenAI key to start.
   */
  get(name: string): LLMProvider {
    const existing = this.clients.get(name);
    if (existing) return existing;

    const profile = this.profiles[name];
    if (!profile) {
      throw new ConfigError(
        `provider profile "${name}" is not defined (known: ${Object.keys(this.profiles).join(", ")})`,
      );
    }

    const apiKey = this.secrets.require(profile.apiKeySecret, `[providers.${name}]`);
    const client = createProvider({
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      apiKey,
      headers: { ...CLIENT_HEADERS, ...profile.headers },
      ...(profile.identify ? { identify: true } : {}),
      ...(profile.maxTokensField ? { maxTokensField: profile.maxTokensField } : {}),
      ...(profile.cacheMinutes !== undefined ? { cacheMinutes: profile.cacheMinutes } : {}),
      ...(this.http ? { http: this.http } : {}),
    });

    const served = this.known ? withEgressMask(client, this.known) : client;
    this.clients.set(name, served);
    log.info("provider ready", { profile: name, kind: profile.kind, base_url: profile.baseUrl });
    return served;
  }

  /**
   * The raw endpoint facts for a profile, credential included.
   *
   * Needed by the vision path, which builds a multimodal request by hand rather than through
   * `LLMProvider` — `ChatMessage.content` is a string, and widening it to content blocks would
   * ripple through truncation, token estimation and session persistence to serve one capability.
   *
   * Kept beside `get` so both resolve the credential the same way, and named `endpointFor` rather
   * than something like `credentials` so a future reader sees it is about reaching an endpoint, not
   * about handing secrets around.
   */
  endpointFor(name: string): {
    kind: ProviderProfile["kind"];
    baseUrl: string;
    apiKey: string;
    headers?: Record<string, string>;
  } {
    const profile = this.profiles[name];
    if (!profile) {
      throw new ConfigError(
        `provider profile "${name}" is not defined (known: ${Object.keys(this.profiles).join(", ")})`,
      );
    }
    return {
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      apiKey: this.secrets.require(profile.apiKeySecret, `[providers.${name}]`),
      // Asked outside a client (the model list, a picture, a voice note): each such call is one of its own, so a
      // header that asks for the conversation's id gets an id of that call, never the bare `{session}`.
      headers: { ...CLIENT_HEADERS, ...profileHeaders(profile.headers) },
    };
  }

  /** Profiles whose credential is present — what the dashboard shows as usable. */
  available(): { name: string; kind: string; baseUrl: string; hasCredential: boolean }[] {
    return Object.entries(this.profiles).map(([name, profile]) => ({
      name,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      hasCredential: this.secrets.has(profile.apiKeySecret),
    }));
  }

  names(): string[] {
    return Object.keys(this.profiles);
  }

  /**
   * Drop the client built for a profile, so the next call builds one from the profile and key as they are now.
   *
   * The profiles are the running config's own, which a save changes in place (`config/follow.ts`): the setup wizard
   * writes a provider into `config.toml` and the operator expects to send a message immediately afterwards, and a
   * restart to apply it turns "finish setup" into "finish setup and wait for the container to come back".
   *
   * But a client holds its base URL and credential from construction, so a changed profile with a live client would
   * keep talking to the old endpoint — the kind of bug that only shows up when someone corrects a typo and nothing
   * changes. Evicted, not updated; and a removed profile's client goes too, or its name would still answer.
   */
  forget(name: string): void {
    if (this.clients.delete(name)) log.info("provider client dropped, so the next call builds it again", { profile: name });
    // And what its endpoint said: a corrected base URL is a different gateway, with its own models.
    this.catalog.forget(name);
  }
}
