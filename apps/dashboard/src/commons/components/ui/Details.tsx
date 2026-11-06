/**
 * What is technical by nature, for whoever runs the server: a command, a path, a version, the server's own error.
 * Closed by default under one word, so the page above it says what a person needs in everyday words and the rest is
 * one click away (0.8.19, "the dashboard in plain words": its readers are not technical, the owner, 2026-11-05).
 *
 * The dashboard's word inventory (`scripts/dashboard-words.ts`) reads what is inside one of these as for the server's
 * admin, and `plain-dashboard.test.ts` lets a command, a path or an internal word through here and nowhere else.
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

export function Details({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <details className={cn("text-xs", className)}>
      <summary className="text-base-content/65 hover:text-base-content cursor-pointer select-none">Details</summary>
      <div className="text-base-content/70 mt-1.5 space-y-1.5 break-words">{children}</div>
    </details>
  );
}
