/**
 * A value that lags behind, so a request does not chase every keystroke.
 *
 * The box stays instant — it is the state the caller already owns. This is what the *query* keys off,
 * which is the difference between one search per word and one per letter, and it matters here because
 * the search is a LIKE over the whole history rather than a filter over what is on screen.
 */

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    // Cleared on every change, so the timer only fires once the typing stops — and on unmount, so a
    // closed drawer does not set state on a component that is gone.
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}
