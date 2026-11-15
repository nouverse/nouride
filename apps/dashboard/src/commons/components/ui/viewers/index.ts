/**
 * What a fenced block can be drawn as, by the language its fence names: a picture, a formula, a diagram.
 *
 * Each viewer is a module of its own, so a chunk of its own, asked for only when a block in its language is drawn: a
 * page with no such block never loads it, and the main bundle carries this list and nothing of what it names.
 * `CodeBlock` keeps the code a press away, the copy button with it, and falls back to the code when a viewer does not
 * load or cannot draw the block.
 */

import type { ComponentType } from "react";

export interface ViewerProps {
  /** The block as written. */
  text: string;
  /** The block cannot be drawn: it is shown as its code, with nothing said of why. */
  onFail: () => void;
}

export interface Viewer {
  /** The name of what it draws, on the switch beside "Code". */
  label: string;
  load: () => Promise<{ default: ComponentType<ViewerProps> }>;
}

/** By the first word of a fence's language, lower case. */
export const VIEWERS: Record<string, Viewer> = {};

/** The viewer a fence's language names, or none: a fence may say more than its language ("svg title=…"). */
export function viewerFor(lang: string | undefined): Viewer | null {
  const name = (lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  return (name && Object.hasOwn(VIEWERS, name) ? VIEWERS[name] : null) ?? null;
}
