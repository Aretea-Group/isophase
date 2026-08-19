import type { Tone } from "../view/format.ts";

/**
 * Colour never carries meaning on its own (PRD-3 §9.8).
 *
 * Every state that has a colour here also has a glyph in the view layer, because these panes get
 * screenshotted into tickets and read on projectors. The palette stays close to the terminal's own
 * 16 colours so it inherits whatever theme the analyst already trusts.
 */
export const COLOR = {
  text: "#d0d0d0",
  /** Section headings. Brighter than body text — `dim` made them the hardest thing to read. */
  heading: "#ffffff",
  /** Field labels. Legible on a dark background, unlike `dim`, which is for asides only. */
  label: "#9e9e9e",
  dim: "#6c6c6c",
  border: "#3a3a3a",
  borderFocused: "#00afd7",
  title: "#d7d7d7",
  selected: "#005f87",
  running: "#00afd7",
  stale: "#767676",
  failed: "#d75f5f",
  ok: "#5faf5f",
  truePositive: "#d75f5f",
  falsePositive: "#5faf5f",
  inconclusive: "#d7af5f",
  severityHigh: "#ff5f5f",
  severityMedium: "#ffaf5f",
  severityLow: "#5fafd7",
  accent: "#00afd7",
} as const;

/**
 * The single meaning-to-colour mapping.
 *
 * This replaces the per-concept `runStateColor` / `bandColor` / `impactColor` helpers, which asked
 * `ui/` to know what a run state or an impact was. The view layer now decides what a span *means*
 * and names a `Tone` (`view/format.ts`); this is the only place that decides what a meaning looks
 * like, so the palette stays owned by `ui/` without the boundary leaking either way.
 */
export function toneColor(tone: Tone | undefined): string {
  switch (tone) {
    case "heading":
      return COLOR.heading;
    case "label":
      return COLOR.label;
    case "dim":
      return COLOR.dim;
    case "running":
      return COLOR.running;
    case "stale":
      return COLOR.stale;
    case "failed":
      return COLOR.failed;
    case "ok":
      return COLOR.ok;
    case "true-positive":
      return COLOR.truePositive;
    case "false-positive":
      return COLOR.falsePositive;
    case "inconclusive":
      return COLOR.inconclusive;
    case "severity-high":
      return COLOR.severityHigh;
    case "severity-medium":
      return COLOR.severityMedium;
    case "severity-low":
      return COLOR.severityLow;
    case "accent":
      return COLOR.accent;
    case "selected":
      return COLOR.selected;
    default:
      return COLOR.text;
  }
}
