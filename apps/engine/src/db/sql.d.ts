/**
 * `.sql` files imported as text.
 *
 * The migration manifest imports its SQL with `with { type: "text" }` so the statements are compiled
 * into the binary rather than read from a directory that a single-file executable does not have. Bun
 * resolves that at build time; TypeScript needs telling what the module's shape is.
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
