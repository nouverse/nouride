/**
 * The dashboard's connection: platform `web`, instance `dashboard`. Until 0.6 it was `local:dev` —
 * the platform named after how it is wired rather than what it is, and "dev" in the id of every
 * conversation somebody had from the browser on a live box. 0.6 moved what was recorded under the
 * old names, and 0.7.x rewrote the settings that said them; 0.8.0 refuses a `[[people]]` id that still does
 * (`people/match.ts`).
 */
export const LOCAL_GATEWAY_ID = "web:dashboard";
