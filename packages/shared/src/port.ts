/**
 * The public surface of a store, as a plain structural type.
 *
 * Business logic in this daemon takes a **port**, never a store class, and this is what makes that
 * cheap enough to be worth doing everywhere. `Port<TurnStore>` is one line and stays correct by
 * construction; the hand-written alternative was 197 method signatures across 18 stores, every one
 * of them free to drift from the implementation it describes.
 *
 * ## What it buys, exactly
 *
 * Four properties, and each one was checked before this was adopted:
 *
 *   1. **A plain object satisfies it.** A class with `constructor(private readonly db)` cannot be
 *      faked — `private` members are part of the type, so nothing but that class assignable to it.
 *      That is why 18 test files open a real SQLite file and run 30 migrations to assert on business
 *      logic that never touches a row. `keyof` sees only public members, so a mapped type over them
 *      drops the private field and a literal becomes assignable.
 *   2. **The real class satisfies it**, so adopting a port is not a rewrite of the store.
 *   3. **A second implementation satisfies it structurally.** `class PgTurnStore implements
 *      Port<TurnStore>` type-checks, which is the whole point of the exercise.
 *   4. **A missing method is a compile error.** This is the migration safety and the reason a mapped
 *      type is not merely the lazy option: a hand-written interface describes what somebody
 *      *remembered* the store does, and the day a port drops a method nothing says so until a query
 *      runs. Derived from the class, the compiler enumerates the surface for you.
 *
 * ## What it does not buy
 *
 * Minimality. A port derived from a class carries every public method, so it does not narrow what a
 * caller may reach for — and the type still names the SQLite class, so the dependency arrow points
 * the conventional way round only in practice, not on paper. Narrow with `Pick` at the point of use
 * where a module genuinely needs three methods out of twenty-one; that is a decision per consumer,
 * which is where it belongs.
 *
 * When a second implementation actually exists, the honest move is to promote the shape to a
 * hand-written interface that neither store owns. Until then this describes reality: there is one
 * implementation, and what the daemon depends on is its public surface.
 */
export type Port<T> = { [K in keyof T]: T[K] };
