/**
 * Small readers the CLIs' use parses share: a field of an answer, a number, a time in ms. An answer is the maker's,
 * read as JSON and trusted for nothing: what is not the expected kind is none.
 */

export const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((at, key) => (at && typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined), value);

/** A finite number, or one written as a string; else null. */
export function numberOf(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** A share used, held to 0..100. */
export const percent = (value: number): number => Math.max(0, Math.min(100, value));

/** A time as ms: an ISO date, or seconds since 1970 where it is a number below 1e12, or ms already. */
export function timeOf(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "" && Number.isNaN(Number(value))) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const number = numberOf(value);
  if (number === null || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}
