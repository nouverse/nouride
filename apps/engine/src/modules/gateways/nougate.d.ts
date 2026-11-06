/**
 * What the engine needs from `@nouverse/nougate-backend`, declared here rather than imported.
 *
 * Same reasoning as `wa-bridge.d.ts`, and the same mistake avoided. A `paths` mapping to the
 * submodule's source would pull nougate's whole program — and its `drizzle-orm` dependency, which a
 * root `bun install` does not touch — into this project's typecheck, and would make an optional
 * submodule required for a fresh clone to typecheck at all.
 *
 * The surface is a handful of functions, so there is very little to drift — and what there is,
 * `scripts/check-seams.ts` (`bun run lint:seams`) catches: it compiles
 * `nougate/apps/backend/src/boot.ts`, the entry its `exports` map names, against everything below.
 */

declare module "@nouverse/nougate-backend" {
  /**
   * What a host says about a request it built itself — `nougate/apps/backend/src/core/host.ts`.
   *
   * Answered from the request *object*, never a header: only a request the host created after
   * checking its own session can be one it recognises.
   */
  export interface HostRequest {
    /** The host's name for the signed-in person. */
    username: string;
    /** Where the host serves the gateway, e.g. `/llm-gateway`. */
    basePath: string;
    /** Where a client reaches the gateway's API from the viewer's network, when the host knows. */
    apiOrigin?: string;
  }

  /**
   * Bring the gateway up and return its fetch handler, without binding a port.
   *
   * Not idempotent: the provider registries and the database handle are module state, so one gateway
   * per process. `host` makes the dashboard trust the host's sign-in for the requests it vouches for.
   */
  export function boot(options?: {
    host?: (req: Request) => HostRequest | null;
  }): Promise<(req: Request) => Response | Promise<Response>>;

  /**
   * A gateway key for the host's own model calls. `current` — what the host stored — is handed back
   * unchanged while it still verifies; otherwise a new key is minted under `name`. After `boot()`.
   */
  export function ensureHostKey(
    name: string,
    current?: string | null,
  ): Promise<{ key: string; minted: boolean }>;

  /** Every model a signed-in account can serve right now, prefixed as a client sends it. After `boot()`. */
  export function connectedModels(): string[];

  /** Whether the dashboard bundle on disk can be shown inside a host — absent from older builds. */
  export function dashboardEmbeddable(): boolean;

  /**
   * Remove every gateway account, so the next boot seeds the first one from `INITIAL_ADMIN_*`.
   * After `boot()`; the caller restarts. Returns how many were removed.
   */
  export function resetAccounts(): Promise<number>;

  /**
   * Write what the gateway holds — its buffered usage rows and debounced state files — and close its database. The
   * host's shutdown calls it, once nothing sends the gateway requests any more: inside a host the gateway answers no
   * signal of its own.
   */
  export function shutdown(): Promise<void>;
}
