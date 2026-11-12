/**
 * The dashboard page a message was written from, as `POST /chat/send` takes it in `page`: an address and what the page
 * is called, in words, and what it is about where it says. The chat that floats over the dashboard's pages sends it.
 *
 * Anything else is no page, never a refusal: a message is not lost for a line beside it. What is said of it to the
 * model is cut and made safe where it is said (`pageNote` in `pipeline/messages.ts`).
 */

import type { OpenPage } from "@nouride/shared";

/** The page a body names, to hand on with its message, and nothing where it names none. */
export function pageOf(raw: unknown): { page?: OpenPage } {
  const page = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof page.path !== "string" || !page.path.trim() || typeof page.title !== "string") return {};
  return { page: { path: page.path, title: page.title, ...(typeof page.subject === "string" && page.subject.trim() ? { subject: page.subject } : {}) } };
}
