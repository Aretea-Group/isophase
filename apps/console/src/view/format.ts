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
 * `**bold**` rendered as bold, rather than as four asterisks.
 *
 * Reasoning previews arrive as the model wrote them, and models write markdown. The console has had
 * a `bold` span since PRD-3 and was printing `**Investigating event logs**` literally, so the one
 * piece of emphasis the agent actually supplied reached the analyst as punctuation.
 *
 * Deliberately not a markdown parser: paired `**` on one line is the only construct these previews
 * use, and an unpaired marker left by truncation is dropped rather than shown.
 */
export function inlineBold(text: string, tone?: Tone): Span[] {
  const spans: Span[] = [];
  let at = 0;

  for (;;) {
    const open = text.indexOf("**", at);
    if (open === -1) break;
    const close = text.indexOf("**", open + 2);
    if (close === -1) break;
    if (open > at) spans.push({ text: text.slice(at, open), tone });
    spans.push({ text: text.slice(open + 2, close), tone, bold: true });
    at = close + 2;
  }

  if (at < text.length) spans.push({ text: text.slice(at).replaceAll("**", ""), tone });
  return spans.length === 0 ? [{ text, tone }] : spans;
}

/**
 * A money column whose decimal points line up.
 *
 * `cost` switches from three decimals to four below a cent, which is right on its own — $0.0004
 * shown as $0.000 says nothing — and wrong in a column, where `$0.0096` sat under `$0.011` and
 * neither the point nor the digits aligned. Padding the short one with a space rather than a zero
 * aligns them without inventing precision the figure does not have.
 */
export function alignDecimal(text: string, fractionWidth = 4): string {
  const point = text.indexOf(".");
  const fraction = point === -1 ? 0 : text.length - point - 1;
  return text + " ".repeat(Math.max(0, fractionWidth - fraction));
}

/**
 * A model id short enough for a list column, whichever vendor wrote it.
 *
 * The column exists to tell two runs of the same alert apart. It was stripping `gpt-<version>-` and
 * nothing else, so `gpt-5.6-terra` became `terra` while every Anthropic id — `claude-opus-5`,
 * `claude-sonnet-5` — became `claud…`, which distinguishes two runs only if they used different
 * vendors. Vendor and date stamp are what two runs of one alert are least likely to differ in, so
 * they go first; the version follows only if the tier name alone will not fit.
 */
export function shortModel(id: string, width: number): string {
  const stripped = id
    .replace(/^(?:gpt|claude|gemini|llama|mistral|o)-/, "")
    .replace(/^[\d.]+-/, "")
    .replace(/-\d{8}$/, "");
  const name = stripped === "" ? id : stripped;
  return pad(name.length > width ? name.replace(/-[\d.]+$/, "") : name, width);
}

function lineSpans(line: Line): Span[] {
  return typeof line === "string" ? [{ text: line }] : line;
}

/**
 * Blocks of lines set side by side.
 *
 * A single column stops being the right shape somewhere past a couple of hundred characters, and
 * capping it there only moves the problem: the pane is still drawn to the terminal's edge, so the
 * cap buys readable lines at the price of a wide strip of empty frame. Splitting fills the pane
 * *and* keeps the lines short, which is the only arrangement that does both.
 *
 * Trailing empty cells are dropped rather than padded, so a short block leaves no run of spaces
 * behind the one beside it.
 */
export function columns(blocks: Line[][], columnWidth: number, gutter: number): Line[] {
  const height = Math.max(0, ...blocks.map((block) => block.length));
  const out: Line[] = [];

  for (let row = 0; row < height; row += 1) {
    const cells = blocks.map((block) => block[row] ?? "");
    // Past the last cell with anything in it there is nothing to align to.
    const last = cells.findLastIndex((cell) => lineText(cell) !== "");
    if (last === -1) {
      out.push("");
      continue;
    }

    const spans: Span[] = [];
    for (const [at, cell] of cells.slice(0, last + 1).entries()) {
      if (at > 0) {
        const previous = lineText(cells[at - 1] ?? "");
        spans.push({ text: " ".repeat(Math.max(1, columnWidth + gutter - previous.length)) });
      }
      spans.push(...lineSpans(cell));
    }
    out.push(spans);
  }
  return out;
}

/**
 * A term and its definition, as a row that wraps under the definition rather than under the border.
 *
 * The help screen is a definition list — a key, and what pressing it does — and it was drawn as
 * flat strings padded by hand to a width guessed when they were written. Anything past the guess
 * soft-wrapped to column 0 and ran under the frame, which is the exact failure `wrap` above exists
 * to prevent. At 120 columns, a common terminal, the help broke in five places.
 *
 * Made structural, the row earns something the flat string could not have: the term and the
 * definition are separate spans, so the key reads as the thing being looked up rather than as the
 * first few characters of a sentence.
 */
export function definitionRow(
  term: string,
  detail: string,
  width: number,
  termWidth: number,
  tone: Tone = "accent",
): Line[] {
  const gutter = 2;
  const body = Math.max(8, width - gutter - termWidth);
  const hang = " ".repeat(gutter + termWidth);
  return wrap(detail, body).map((line, at) =>
    at === 0
      ? [{ text: `${" ".repeat(gutter)}${pad(term, termWidth)}`, tone }, { text: line }]
      : [{ text: `${hang}${line}` }],
  );
}

/** A wrapped paragraph at the pane's standard indent. */
export function prose(text: string, width: number, tone?: Tone): Line[] {
  return wrap(text, Math.max(8, width - 2)).map((line) => [{ text: `  ${line}`, tone }]);
}

/**
 * `n thing` / `n things`, without the parenthetical.
 *
 * `investigation(s)`, `path(s)`, `turn(s)`, `line(s)` — six sites wrote the plural as a hedge in a
 * console that is otherwise careful about its words, and the count is nearly always known by the
 * time the string is built. The header already did this properly and nothing else did.
 */
export function plural(count: number, singular: string, plural_ = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural_}`;
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
  // Case-folded, because severity stays source-native by design: ADR 010 §2 keeps these as the
  // product's own strings rather than mapping them into a shared taxonomy, and the two products
  // disagree on case — Sentinel emits `Informational`, Defender's Graph API emits `informational`.
  // Matching PascalCase alone rendered every Defender alert as `???`, in the queue and in the case
  // pane, which reads as missing data rather than as a display bug.
  //
  // Folding case is not the same as normalising the value: nothing here rewrites what the artifact
  // records, and a severity neither product uses still lands on `Unknown`.
  switch (value?.toLowerCase()) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "informational":
      return "Informational";
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
