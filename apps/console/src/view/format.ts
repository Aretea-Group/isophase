/** Pure formatting helpers. No terminal, no I/O — see PRD-3 §5.1. */

/**
 * A tone is a *meaning*, not a colour.
 *
 * This layer never names a colour: PRD-3 §4.3 keeps `view/` free of the renderer, and the palette
 * belongs to `ui/theme.ts`. Emitting tones lets a line say what it means and leaves `ui/` to decide
 * what that looks like, which keeps the boundary intact in the one place colour would otherwise
 * cross it.
 */
export type Tone =
  /** Structure: a section heading, a field label, or text that is deliberately quiet. */
  | "heading"
  | "label"
  | "dim"
  /** A horizontal divider between sections. Decoration — it stands in for no state. */
  | "rule"
  /** Run and call state. */
  | "running"
  | "stale"
  | "failed"
  | "ok"
  /** The agent's own verdict. */
  | "true-positive"
  | "false-positive"
  | "inconclusive"
  /** The detection's severity, which is the rule's claim rather than the console's. */
  | "severity-high"
  | "severity-medium"
  | "severity-low"
  | "accent"
  | "selected";

export interface Span {
  text: string;
  tone?: Tone;
  /** Background tone. Used for the selected row in a list, where a marker alone reads weakly. */
  bg?: Tone;
  bold?: boolean;
}

/**
 * One rendered row.
 *
 * A plain string stays a plain string. Only the renderers where colour is load-bearing pay for
 * spans; every pure-text renderer keeps its existing return type and its existing tests.
 */
export type Line = string | Span[];

/** The text of a line, with the styling dropped — for width maths, copying and assertions. */
export function lineText(line: Line): string {
  return typeof line === "string" ? line : line.map((span) => span.text).join("");
}

export function linesText(lines: Line[]): string {
  return lines.map(lineText).join("\n");
}

/** The band word doubles as its own tone; `unknown` has nothing to say. */
export function bandTone(band: VerdictBand): Tone {
  return band === "unknown" ? "dim" : band;
}

/**
 * Impact, short enough for a list row.
 *
 * `confirmed-compromise` is twenty characters and was being clipped to `confirmed-comp` by the
 * select widget, which has no ellipsis of its own — so the most serious value on the screen was
 * the one that looked like a rendering fault.
 */
export function shortImpact(impact: string | undefined): string | undefined {
  if (impact === undefined) return undefined;
  return impact === "confirmed-compromise" ? "compromise" : impact;
}

/**
 * Impact borrows the verdict palette rather than introducing a second one.
 *
 * `confirmed-compromise` is the only impact that should read as loudly as a true positive, and
 * `contained` sits where an inconclusive verdict does. `none` and `unknown` stay quiet — a true
 * positive that achieved nothing is precisely the case an analyst should not be alarmed by.
 */
/**
 * The rule's severity.
 *
 * Coloured because it is a value the detection recorded, not a judgement the console is making —
 * the same reason the verdict band is coloured and the same limit: §9.8 still forbids styling
 * anything to look more approved-of than anything else.
 */
export function severityTone(severity: Severity): Tone | undefined {
  switch (severity) {
    case "High":
      return "severity-high";
    case "Medium":
      return "severity-medium";
    case "Low":
      return "severity-low";
    case "Informational":
      return "dim";
    default:
      return undefined;
  }
}

export function impactTone(impact: string | undefined): Tone {
  if (impact === "confirmed-compromise") return "true-positive";
  if (impact === "contained") return "inconclusive";
  return "dim";
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

export function tokens(count: number | undefined): string {
  if (count === undefined) return "—";
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function cost(amount: number | undefined): string {
  if (amount === undefined) return "—";
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(3)}`;
}

export function chars(count: number | undefined): string {
  if (count === undefined) return "—";
  return count < 1000 ? `${count} ch` : `${(count / 1000).toFixed(1)}k ch`;
}

export function clockTime(iso: string | undefined): string {
  if (iso === undefined || iso.length < 19) return "—";
  return iso.slice(11, 19);
}

/** Truncate to a display width, keeping the ellipsis inside the budget. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

export function pad(text: string, width: number): string {
  const clipped = truncate(text, width);
  return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

/**
 * The TP/FP bar.
 *
 * PRD-3 §9.8: colour never carries the meaning on its own, so the band is also reported as a word
 * by `verdictBand` and the bar itself is readable in monochrome.
 */
export function tpBar(tpPercent: number | undefined, width: number): string {
  if (tpPercent === undefined || width <= 0) return "";
  const filled = Math.round((Math.min(100, Math.max(0, tpPercent)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export type VerdictBand = "true-positive" | "false-positive" | "inconclusive" | "unknown";

/**
 * Which way a verdict leans.
 *
 * The 30-70 band matches the one `scripts/evaluate-runs.ts` scores against, so the console and the
 * evaluator describe the same run the same way (PRD-3 §9.8).
 */
export function verdictBand(tpPercent: number | undefined): VerdictBand {
  if (tpPercent === undefined) return "unknown";
  if (tpPercent >= 30 && tpPercent <= 70) return "inconclusive";
  return tpPercent > 70 ? "true-positive" : "false-positive";
}

/**
 * The band as a word.
 *
 * Computed since PRD-3 and rendered nowhere until now, which left `TP 45%` for the analyst to
 * interpret. `inconclusive` is a conclusion — the agent reporting that the evidence did not
 * separate the two readings — and reading it off a percentage is work the console should not
 * be handing back.
 */
export function bandLabel(band: VerdictBand): string {
  switch (band) {
    case "true-positive":
      return "TRUE POSITIVE";
    case "false-positive":
      return "FALSE POSITIVE";
    case "inconclusive":
      return "INCONCLUSIVE";
    default:
      return "UNSCORED";
  }
}

/**
 * Wrap prose to a width, preserving paragraph breaks.
 *
 * Long unbroken tokens are hard-broken rather than allowed to overflow. Tool results are minified
 * JSON — a 14,000-character schema response is a single "word" — and letting the terminal soft-wrap
 * it loses the pane's indentation and runs the text under the border.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    let line = "";
    const push = (): void => {
      out.push(line);
      line = "";
    };

    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      if (word.length > width) {
        if (line !== "") push();
        for (let at = 0; at < word.length; at += width) out.push(word.slice(at, at + width));
        continue;
      }
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
      else {
        push();
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Incident time, formatted so it can never be mistaken for investigation time.
 *
 * These two clocks are unrelated and on this corpus five years apart: the telemetry is historical
 * Training Lab data, so an alert from 2021 is investigated in 2026. Every incident timestamp is
 * therefore rendered date-first and explicitly UTC, while investigation timing is only ever shown
 * as a clock time or a duration (PRD-3 §6.1).
 */
export function incidentTime(iso: string | undefined): string {
  if (iso === undefined || iso.length < 16) return "—";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/** A window, collapsed when both ends fall on the same day. */
export function incidentWindow(start: string | undefined, end: string | undefined): string {
  if (start === undefined) return incidentTime(end);
  if (end === undefined || end === start) return incidentTime(start);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return sameDay
    ? `${start.slice(0, 10)} ${start.slice(11, 16)}→${end.slice(11, 16)}Z`
    : `${incidentTime(start)} → ${incidentTime(end)}`;
}

/** Just the date, for a list column. */
export function incidentDate(iso: string | undefined): string {
  return iso === undefined || iso.length < 10 ? "" : iso.slice(0, 10);
}

export type Severity = "High" | "Medium" | "Low" | "Informational" | "Unknown";

export function severityOf(value: string | undefined): Severity {
  switch (value) {
    case "High":
    case "Medium":
    case "Low":
    case "Informational":
      return value;
    default:
      return "Unknown";
  }
}

/**
 * Fixed-width severity marker; the word carries it without colour (PRD-3 §9.8).
 *
 * Blank rather than a placeholder when nothing was recorded. Most artifacts on disk predate the
 * alert block, and filling their rows with `???` would read as a data problem rather than as a
 * column that simply does not apply to them.
 */
export function severityTag(value: string | undefined): string {
  switch (severityOf(value)) {
    case "High":
      return "HIGH";
    case "Medium":
      return "MED ";
    case "Low":
      return "LOW ";
    case "Informational":
      return "INFO";
    default:
      return value === undefined ? "    " : "??? ";
  }
}
