/**
 * The shortest password the daemon takes — `MIN_PASSWORD_LENGTH` in `apps/engine/src/modules/users/users.store.ts`.
 *
 * The welcome page and My Account each kept their own `8`; they say it before the daemon refuses, so they
 * have to say the same thing. A copy of the engine's, because the dashboard is its own build and reaches
 * the daemon only over HTTP.
 */
export const MIN_PASSWORD_LENGTH = 8;
