/**
 * What a caller hands the graph. Nothing here knows what a node *is* — a conversation, a person, a
 * file — only how it looks: a colour, a size, a label, and whether it is a hub.
 */

export interface GraphNodeInput {
  id: string;
  label: string;
  /** `#rrggbb`: a halo is the same colour at low alpha, appended as two hex digits. */
  color: string;
  /** In graph units; the zoom scales it. */
  radius: number;
  /**
   * A node many others join: drawn with a halo, named before the rest, pushing its neighbours further
   * apart, and drawn under them, so a small node beside it stays on top.
   */
  hub?: boolean;
  /** Fill opacity at rest, 0–1. Default 1. */
  opacity?: number;
}

export interface GraphLinkInput {
  source: string;
  target: string;
  /** Rest length in graph units. Default 40. */
  distance?: number;
  dashed?: boolean;
  /** At rest. Default the theme's `link`. */
  color?: string;
  /** When both ends are lit. Default the target's colour. */
  litColor?: string;
  /** At rest, in screen pixels. Default 0.45. */
  width?: number;
}

export interface GraphTheme {
  /** Labels of hubs and of what is pointed at. */
  text: string;
  /** Labels of other nodes. */
  muted: string;
  /** Drawn behind every label, so it stays legible over links. The canvas's background colour. */
  backdrop: string;
  link: string;
  /** A link outside what is lit. */
  linkFaint: string;
  /** The labels' typeface, as a CSS `font-family` list — the page's own, so they match it. Default the system's sans-serif. */
  font?: string;
}

export interface GraphViewOptions {
  theme: GraphTheme;
  /** A node clicked or tapped, or `null` for the background. Not called for a drag. */
  onSelect?: (id: string | null) => void;
}
