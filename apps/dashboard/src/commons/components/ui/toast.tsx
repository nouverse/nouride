/**
 * "That worked" / "that did not" — once, for everything that reports it.
 *
 * The dashboard has no way to say either today. What it has instead is one of three things per
 * screen: a `<div className="alert">` that pushes the layout down and stays until the next render,
 * an error folded into `<ErrorNote>` where it reads as a *state* of the page rather than the result
 * of what was just clicked, or nothing at all — a save that succeeds and looks identical to a save
 * that never fired.
 *
 * ## Why a provider, when `confirm.tsx` argues against one
 *
 * That file is right about confirmations and the same reasoning inverts here. A confirmation belongs
 * to the component that asks: there is never more than one in flight, and the state that answers it
 * is the state that knows what is being deleted.
 *
 * A toast is the opposite on both counts.
 *
 *   - **It outlives its caller.** Saving a setting and immediately navigating away is the normal
 *     shape of "Saved". Owned by the page, the toast unmounts with the page and the confirmation
 *     never appears — worst on exactly the actions people leave right after.
 *   - **Several are legitimate at once.** Two mutations settling together are two results, and a
 *     per-component host would either stack two overlapping boxes in the same corner or let the
 *     second silently replace the first.
 *
 * So there is one host, mounted above the router, and `useToast()` reaches it through context.
 *
 * ## What it is not for
 *
 * A toast disappears, so nothing that has to be *read* to be acted on belongs in one: a validation
 * error stays next to the field, a refusal that needs a decision is a `useConfirm`, and a failure
 * the page's whole content depends on is `<ErrorNote>`. This is for the outcome of a thing somebody
 * just did, where the page itself already shows the new state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { failureWords } from "@/commons/lib/api.client";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastRequest {
  /** One line, in the past tense: "Schedule saved", "Could not reach the daemon". */
  message: string;
  kind?: ToastKind;
  /**
   * A second line, for the part that does not fit: which field, what to try.
   *
   * Optional because most outcomes are one line, and a detail nobody needs is a box that covers
   * more of the screen for longer.
   */
  detail?: string;
  /**
   * For whoever runs the server, closed under Details: a failure's own words, where the page says everyday ones
   * (0.8.20): a route's error and note beside its `plain`, or the route that answered and its status.
   */
  details?: string;
  /**
   * Milliseconds before it leaves. `0` keeps it until dismissed.
   *
   * Defaults differ by kind rather than being one number, because the two ends are read differently:
   * "Saved" is confirmation of something the reader already knows and four seconds is generous,
   * while a failure often carries a name or a path somebody has to copy — so errors stay until
   * dismissed rather than daring the reader to read faster.
   */
  duration?: number;
}

interface Toast extends ToastRequest {
  id: number;
}

/** How long each kind lingers. `0` for errors: an error that vanishes is an error reported to nobody. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4_000,
  info: 5_000,
  warning: 7_000,
  error: 0,
};

/**
 * Most stacked at once.
 *
 * A burst — several mutations failing together because the daemon went away — is exactly when a
 * toast is least useful and most in the way: eight boxes covering the page say nothing that one
 * plus "and 7 more" would not. The oldest go first, so what is on screen is what just happened.
 */
const MAX_STACKED = 4;

const ICONS: Record<ToastKind, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

const ALERT_CLASS: Record<ToastKind, string> = {
  success: "alert-success",
  error: "alert-error",
  warning: "alert-warning",
  info: "alert-info",
};

export interface Toaster {
  /** The general form. Returns the id, so a caller that wants to can dismiss it early. */
  show: (request: ToastRequest) => number;
  success: (message: string, detail?: string) => number;
  /** `failure`: words of the page's own, or what was thrown, said as `failureWords` says it, with its Details. */
  error: (message: string, failure?: unknown) => number;
  warning: (message: string, detail?: string) => number;
  info: (message: string, detail?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<Toaster | null>(null);

/** A failure as a toast's second line and its Details: a string is the line itself; anything thrown, its words. */
function described(failure: unknown): Pick<ToastRequest, "detail" | "details"> {
  if (failure === undefined || failure === null || failure === "") return {};
  if (typeof failure === "string") return { detail: failure };
  const { said, detail } = failureWords(failure);
  return { detail: said, ...(detail ? { details: detail } : {}) };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  /**
   * Ids from a counter, not `Date.now()`.
   *
   * Two toasts raised in the same millisecond — two mutations settling from one click — would share
   * a key, and React reuses the DOM node for a duplicate key: the second message overwrites the
   * first in place and its dismiss button removes whichever the map finds first.
   */
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (request: ToastRequest) => {
      const id = (nextId.current += 1);
      const kind = request.kind ?? "info";
      const duration = request.duration ?? DEFAULT_DURATION[kind];

      setToasts((current) => {
        const next = [...current, { ...request, kind, id }];
        // Trimmed here rather than by the effect below, so the timers of the dropped ones are the
        // only thing left to clean up and there is exactly one place that decides what is on screen.
        return next.length > MAX_STACKED ? next.slice(next.length - MAX_STACKED) : next;
      });

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  /**
   * Clear every pending timer when the provider goes away.
   *
   * A `setTimeout` holding `dismiss` keeps this component's state setter alive past unmount, which
   * React warns about and which in a hot-reloading dev server means a timer from the previous
   * module version firing into a tree that no longer exists.
   */
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const toaster = useMemo<Toaster>(
    () => ({
      show,
      dismiss,
      success: (message, detail) => show({ message, kind: "success", ...(detail ? { detail } : {}) }),
      error: (message, failure) => show({ message, kind: "error", ...described(failure) }),
      warning: (message, detail) => show({ message, kind: "warning", ...(detail ? { detail } : {}) }),
      info: (message, detail) => show({ message, kind: "info", ...(detail ? { detail } : {}) }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={toaster}>
      {children}
      {/*
        daisyUI's `toast` places the stack; `toast-end toast-bottom` is the corner furthest from
        anything clickable in this layout — the sidebar is on the left and page actions sit top-right.
        `pointer-events-none` on the stack with it restored per toast so a box that happens to sit
        over a button does not swallow the click, while its own dismiss still works.
      */}
      <div
        className="toast toast-end toast-bottom z-[100] pointer-events-none max-w-[min(28rem,calc(100vw-2rem))]"
        // `polite`, not `assertive`: these announce the result of something the reader just did, and
        // interrupting a screen reader mid-sentence to say "Saved" is worse than waiting for the pause.
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((toast) => {
          const kind = toast.kind ?? "info";
          const Icon = ICONS[kind];
          return (
            <div
              key={toast.id}
              role="status"
              className={`alert ${ALERT_CLASS[kind]} pointer-events-auto flex items-start gap-2.5 rounded-2xl py-2.5 pr-2.5 shadow-lg`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 leading-snug">
                {/* `break-words`: a daemon error can be one unbroken path or URL, and without it the
                    box grows past the viewport instead of wrapping. */}
                <div className="text-sm font-medium break-words">{toast.message}</div>
                {toast.detail ? (
                  <div className="text-xs opacity-80 break-words">{toast.detail}</div>
                ) : null}
                {/* In the toast's own colour, which the shared Details' grey would not read on. */}
                {toast.details ? (
                  <details className="mt-1 text-xs opacity-80">
                    <summary className="cursor-pointer select-none">Details</summary>
                    <p className="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">{toast.details}</p>
                  </details>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-square shrink-0"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * The hook every caller uses.
 *
 * Throws rather than returning a no-op when the provider is missing. A silent no-op would mean a
 * screen whose saves confirm nothing, which looks exactly like the bug this component was written to
 * fix and would be found by a person rather than by the first render.
 */
export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error("useToast must be used inside a <ToastProvider>");
  return toaster;
}
