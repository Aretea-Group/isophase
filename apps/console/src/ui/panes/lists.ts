import type { RunArtifact, RunResult } from "../../data/runs.ts";
import { alertFactsFromResult } from "../../view/alert.ts";
import {
  bandTone,
  impactTone,
  pad,
  severityTone,
  shortImpact,
  truncate,
  type Line,
  type Span,
} from "../../view/format.ts";
import {
  pendingCount,
  runStateTone,
  toResultRow,
  toRunRow,
  type LivenessInput,
} from "../../view/run-list.ts";

/**
 * One line per row, drawn by hand rather than by `SelectRenderable`.
 *
 * The widget was costing three things at once: two lines per run whether or not the second earned
 * its place, an option type of plain strings that no colour could reach, and a background of its
 * own that made the pane look unlike every other. Rows are `Line[]` now, so they colour like
 * everything else and the pane owns its own scrolling.
 */

const MARKER_WIDTH = 2;
/**
 * Fixed columns, so a row can never be wider than its pane.
 *
 * The outcome was budgeted at nine characters and then written unbounded, so `last written
 * 12:04:33` on a stale run wrapped onto a second line — reintroducing exactly the two-line row the
 * single-line layout exists to remove.
 */
const OUTCOME_WIDTH = 9;
const IMPACT_WIDTH = 11;

function marker(selected: boolean): Span {
  return {
    text: selected ? "▶ " : "  ",
    tone: selected ? "accent" : undefined,
    ...(selected ? { bg: "selected" as const } : {}),
  };
}

/**
 * Hard-clip a row to its pane.
 *
 * A backstop, not the primary mechanism — the column arithmetic below is meant to fit exactly. It
 * exists because getting that arithmetic wrong is silent: the row simply wraps, and a wrapped row
 * is the two-line row this layout removed.
 */
function clip(spans: Span[], width: number): Span[] {
  const out: Span[] = [];
  let used = 0;
  for (const span of spans) {
    if (used >= width) break;
    const room = width - used;
    out.push(span.text.length <= room ? span : { ...span, text: span.text.slice(0, room) });
    used += Math.min(span.text.length, room);
  }
  return out;
}

/** Paint the selection across the whole row, so it reads as a bar rather than as a stray glyph. */
function highlight(rawSpans: Span[], selected: boolean, width: number): Line {
  const spans = clip(rawSpans, width);
  if (!selected) return spans;
  const drawn = spans.reduce((total, span) => total + span.text.length, 0);
  const filled: Span[] = [];
  for (const span of spans) {
    span.bg = "selected";
    filled.push(span);
  }
  if (drawn < width) filled.push({ text: " ".repeat(width - drawn), bg: "selected" });
  return filled;
}

/**
 * A window over the rows that keeps the selection visible without moving under it.
 *
 * The offset is carried by the caller rather than recomputed from the selection, because a
 * recomputed one re-centres on every keypress — which is what made the list appear to jump while
 * an analyst was moving through it.
 */
export function scrollOffset(
  offset: number,
  selected: number,
  count: number,
  height: number,
): number {
  if (height <= 0) return 0;
  let next = offset;
  if (selected < next) next = selected;
  if (selected >= next + height) next = selected - height + 1;
  return Math.max(0, Math.min(next, Math.max(0, count - height)));
}

export function windowed(rows: Line[], offset: number, height: number): Line[] {
  return rows.slice(offset, offset + Math.max(0, height));
}

/**
 * Runs, one line each.
 *
 * Severity, when it happened and what it was, then how it came out. The run id and the model are
 * not here: they identify a file and a configuration, both of which the `c` screen carries, and
 * they were the entire reason each run needed a second line.
 */
export function runRows(
  runs: RunArtifact[],
  now: number,
  growing: Set<string>,
  selected: number,
  width: number,
): Line[] {
  return runs.map((run, at) => {
    const row = toRunRow({
      run,
      now,
      ...(growing.has(run.runId) ? { traceGrowing: true } : {}),
    } satisfies LivenessInput);

    const only = run.results.length === 1 ? run.results[0] : undefined;
    const facts = only === undefined ? undefined : alertFactsFromResult(only);
    const severity = facts?.severityTag ?? "    ";

    const pending = pendingCount(run);
    const live = row.state === "running" || row.state === "stale";
    const outcome = live
      ? pending === undefined
        ? row.detail
        : `${row.done}/${row.planned ?? "?"} done`
      : row.tpPercent === undefined
        ? row.detail
        : `TP ${row.tpPercent}%`;

    // The model stays, unlike the run id: this corpus reruns the same alert across tiers, so it is
    // what actually tells two otherwise identical rows apart. The run id identifies a file, and the
    // `c` screen is where files are identified.
    const outcomeText = truncate(outcome, OUTCOME_WIDTH).padStart(OUTCOME_WIDTH);
    const fixed = MARKER_WIDTH + 2 + severity.length + 1 + 1 + OUTCOME_WIDTH;
    // The model is the first thing to go on a narrow pane: it tells two runs of the same alert
    // apart, which matters less than being able to read either of their titles.
    const model = width - fixed - 7 >= 12 ? pad(row.model.replace(/^gpt-[\d.]+-/, ""), 6) : "";
    const room = Math.max(1, width - fixed - (model === "" ? 0 : model.length + 1));
    const isSelected = at === selected;

    return highlight(
      [
        marker(isSelected),
        { text: `${row.glyph} `, tone: runStateTone(row.state) },
        { text: `${severity} `, tone: severityTone(facts?.severity ?? "Unknown") },
        { text: pad(truncate(row.label, room), room), bold: isSelected },
        { text: model === "" ? "" : ` ${model}`, tone: "dim" },
        { text: ` ${outcomeText}`, tone: live ? "running" : bandTone(row.band) },
      ],
      isSelected,
      width,
    );
  });
}

/** Alerts within the selected run, one line each, with the impact the run list has no room for. */
export function resultRows(results: RunResult[], selected: number, width: number): Line[] {
  return results.map((result, at) => {
    const row = toResultRow(result, width);
    const facts = alertFactsFromResult(result);
    const impact = shortImpact(result.summary?.impact) ?? "";
    const outcome = row.failed
      ? "FAIL"
      : row.tpPercent === undefined
        ? "—"
        : `TP ${row.tpPercent}%`;

    const outcomeText = truncate(outcome, 7).padStart(7);
    const impactText = pad(truncate(impact, IMPACT_WIDTH - 1), IMPACT_WIDTH - 1);
    const room = Math.max(
      1,
      width - MARKER_WIDTH - 2 - facts.severityTag.length - 1 - 1 - 7 - 1 - (IMPACT_WIDTH - 1),
    );
    const isSelected = at === selected;

    return highlight(
      [
        marker(isSelected),
        { text: `${row.glyph} `, tone: row.failed ? "failed" : "ok" },
        { text: `${facts.severityTag} `, tone: severityTone(facts.severity) },
        { text: pad(truncate(row.title, room), room), bold: isSelected },
        { text: ` ${outcomeText}`, tone: row.failed ? "failed" : bandTone(row.band) },
        { text: ` ${impactText}`, tone: impactTone(result.summary?.impact) },
      ],
      isSelected,
      width,
    );
  });
}

export function pendingLine(run: RunArtifact | undefined): string | undefined {
  if (run === undefined) return undefined;
  const pending = pendingCount(run);
  if (pending === undefined || pending === 0) return undefined;
  return `  ${pending} alert${pending === 1 ? "" : "s"} pending of ${run.alertCount ?? "?"}`;
}
