/**
 * The fundamental UI building blocks of the Nouride dashboard.
 * Designed with Apple Human Interface Design principles:
 * - Frosted glass / translucent materials
 * - Tactile active states (active:scale-[0.98])
 * - Precise typography & hierarchy
 * - DaisyUI semantic theme colors
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { failureWords } from "@/commons/lib/api.client";
import { cn } from "@/commons/lib/utils";
import { Details } from "./Details";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-4 pb-1", className)}>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-base-content sm:text-3xl">{title}</h1>
        {description && (
          <p className="text-base-content/65 max-w-2xl text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  bodyClassName,
  glass = true,
  folded,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** For a card whose body scrolls on its own under a header that stays put. */
  bodyClassName?: string;
  glass?: boolean;
  /**
   * A card that folds to its header (0.8.11): its title a button that opens and closes it, its body there only while it
   * is open. A mission's brief, closed until asked for — the owner's word.
   */
  folded?: { open: boolean; toggle: () => void };
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-base-content/[0.08] shadow-sm transition-all duration-200",
        glass ? "bg-base-100/80 backdrop-blur-xl backdrop-saturate-150" : "bg-base-100",
        className
      )}
    >
      {(title ?? actions) && (
        <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6 sm:py-4", (!folded || folded.open) && "border-b border-base-content/[0.08]")}>
          {/* A long path in the description breaks inside the card (`overflow-wrap: anywhere`): a brief's — "Named in its
              goal: /srv/nouride/.nouride/workspace/…/BRIEF.md" — ran past the card's edge and under its header's button on
              a phone (0.8.12). A folded card's title takes 16rem before its actions sit beside it, so on a phone the
              actions go under it rather than squeeze it to a column. */}
          {folded ? (
            <button type="button" className="flex min-w-0 flex-[1_1_16rem] items-start gap-2 text-left" aria-expanded={folded.open} onClick={folded.toggle}>
              <ChevronDown size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0 text-base-content/60 transition-transform", !folded.open && "-rotate-90")} />
              <span className="space-y-0.5 min-w-0">
                {title && <h2 className="font-semibold tracking-tight text-base-content text-base [overflow-wrap:anywhere]">{title}</h2>}
                {description && <p className="text-base-content/65 text-sm [overflow-wrap:anywhere]">{description}</p>}
              </span>
            </button>
          ) : (
            <div className="space-y-0.5 min-w-0">
              {title && <h2 className="font-semibold tracking-tight text-base-content text-base [overflow-wrap:anywhere]">{title}</h2>}
              {description && <p className="text-base-content/65 text-sm [overflow-wrap:anywhere]">{description}</p>}
            </div>
          )}
          {/* Wraps rather than overflows: held at its full width, a search and a filter side by side ran past a phone's
              card edge (Missions). On a wide card they still sit beside the title, as before. */}
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {/* 16px on a phone, where a card inside the page's own 16px kept 72px of a 390px screen for its edges. */}
      {(!folded || folded.open) && <div className={cn("p-4 sm:p-6", bodyClassName)}>{children}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      {/* Block, so a control narrower than the row starts below its label rather than beside it. */}
      <span className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">
        {label}
      </span>
      {children}
      {hint && <span className="text-base-content/65 block text-xs leading-normal">{hint}</span>}
    </label>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3.5 py-12 px-4 text-center", className)}>
      <div className="bg-base-content/[0.05] text-base-content/65 grid size-12 place-items-center rounded-2xl border border-base-content/[0.06] shadow-inner">
        <Icon size={24} aria-hidden="true" />
      </div>
      <div className="space-y-1 max-w-md">
        <p className="font-semibold text-base-content text-base tracking-tight">{title}</p>
        {description && (
          <p className="text-base-content/65 text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/**
 * A live state as a capsule with a dot: daisyUI's `status` in the theme's success, warning or error, and a
 * `halo` of the same colour (`styles/main.css`) where it is live.
 */
export function StatusDot({ status }: { status: string | null }) {
  const isConnected = status === "connected" || status === "running" || status === "ok";
  const isConnecting = status === "connecting" || status === "reconnecting";
  const isDead = status === "dead" || status === "error";

  const dotTone =
    status === null
      ? "bg-base-content/30"
      : isConnected
        ? "status-success halo"
        : isConnecting
          ? "status-warning halo animate-pulse"
          : isDead
            ? "status-error halo"
            : "bg-base-content/30";

  const badgeTone =
    status === null
      ? "bg-base-content/5 text-base-content/65"
      : isConnected
        ? "bg-success/10 text-success border border-success/20"
        : isConnecting
          ? "bg-warning/10 text-warning border border-warning/20"
          : isDead
            ? "bg-error/10 text-error border border-error/20"
            : "bg-base-content/5 text-base-content/65";

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-xs font-medium", badgeTone)}>
      <span className={cn("status size-1.5 rounded-full shrink-0", dotTone)} />
      <span className="capitalize">{status ?? "not started"}</span>
    </span>
  );
}

/**
 * A clean inline error banner with Lucide status icon. `role="alert"`, so a reader announces it when it appears. What
 * it says is `failureWords`: a route's everyday words, and its own under Details (0.8.20); a route's error and what to
 * do about it where it gave no others.
 */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const { said: words, detail } = failureWords(error);
  const said = <span className="font-medium">{words}</span>;
  return (
    <div role="alert" className="alert alert-error bg-error/10 text-error border border-error/20 rounded-xl p-3 text-xs flex items-center gap-2">
      <AlertCircle size={15} className="shrink-0" />
      {detail ? (
        <div className="min-w-0 space-y-1">
          {said}
          <Details>
            {/* A line for the error and one for its note, as the CLI prints them; a long path still wraps. */}
            <p className="whitespace-pre-line [overflow-wrap:anywhere]">{detail}</p>
          </Details>
        </div>
      ) : (
        said
      )}
    </div>
  );
}
