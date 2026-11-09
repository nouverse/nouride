/**
 * What a new agent starts as, and an existing one's tools and default (`routes/agent-tools.ts`).
 */

export type PresetId = "nourider" | "researcher" | "assistant" | "developer" | "custom";

export interface AgentPresetView {
  id: PresetId;
  label: string;
  summary: string;
  /** The headline an agent made from it starts with, when none is written. Absent from a daemon before 0.7.18. */
  headline?: string;
  /** The SOUL.md an agent made from it starts with — filled into the form, editable. Absent from a daemon before 0.8.1. */
  soul?: string;
  /** What it would give on this daemon. Empty for `custom`. */
  tools: string[];
}

export interface AgentPresets {
  presets: AgentPresetView[];
  /** Every tool this daemon has, grouped for the switches. */
  groups: { label: string; tools: string[] }[];
}
