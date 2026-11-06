/**
 * What the engine needs from `nouride-oauth`, declared here rather than imported.
 *
 * The same choice — and the same two reasons — as `gateways/wa-bridge.d.ts`:
 *
 * - A path mapping would drag the plugin's source into this project's program,
 *   so the engine's typecheck would start reporting the plugin's problems as
 *   its own.
 * - It would make the plugin **required**. Every edition but `--pro` is built
 *   with `--external nouride-oauth`, and an optional component must never
 *   become a required one.
 *
 * `scripts/check-seams.ts` (`bun run lint:seams`) compiles the plugin's module
 * against everything below, and holds `OauthSettings` equal to the config's
 * `DashboardOAuthSection`, so the duplication cannot drift silently. It skips
 * when `internals/pro` is not checked out.
 */

declare module "nouride-oauth" {
  export interface OauthSettings {
    issuer: string;
    clientId: string;
    secretName: string;
    label: string;
  }

  export interface OidcIdentity {
    sub: string;
    email: string;
    name?: string;
  }

  export type CallbackResult =
    | { ok: true; identity: OidcIdentity }
    | { ok: false; error: string };

  export interface FlowStart {
    authorizeUrl: string;
    cookie: string;
  }

  export const OIDC_FLOW_COOKIE: string;

  export function discover(issuer: string): Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint: string;
  }>;

  export function beginLogin(input: {
    oauth: OauthSettings;
    redirectUri: string;
    secure: boolean;
  }): Promise<FlowStart>;

  export function completeLogin(input: {
    oauth: OauthSettings;
    clientSecret: string;
    redirectUri: string;
    code: string | undefined;
    state: string | undefined;
    cookieValue: string | undefined;
  }): Promise<CallbackResult>;

  export function flowCookie(value: string, secure: boolean, maxAge: number): string;
  export function clearedFlowCookie(secure: boolean): string;
}
