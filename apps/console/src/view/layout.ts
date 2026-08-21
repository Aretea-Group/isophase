/** Pure layout arithmetic. No terminal, no renderer — same rule as the rest of `view/`. */

/**
 * The sidebar is elastic.
 *
 * It was a fixed 46 columns, which meant every column past that went to the main pane and nowhere
 * else: at 200 columns the verdict prose ran to 148 characters a line while `[3] Case` was still
 * clipping `SOC-RULE-0001-RdpBruteFo…` in the same frame. Surplus width now goes to the pane that
 * is truncating before it goes to the pane that is already wide enough.
 *
 * The floor matters more than the ceiling. Between 100 and 115 columns the layout used to keep a
 * 46-column sidebar and hand the main pane 50, which is narrower than its own tab strip — so the
 * strip soft-wrapped to column 0 and ran under the border. Shrinking the sidebar to 40 there keeps
 * the main pane above `MAIN_MIN_WIDTH` without moving the collapse threshold PRD-3 §9.6 fixes.
 */
export const SIDEBAR_MIN_WIDTH = 40;
export const SIDEBAR_MAX_WIDTH = 120;
/** 0.38 is chosen so that a 120-column terminal still gets the 46 columns it always had. */
const SIDEBAR_SHARE = 0.38;
/** Narrower than this and the main pane cannot hold its own tab strip. */
const MAIN_MIN_WIDTH = 58;

/** Below this the two columns collapse; below `MIN_WIDTH` nothing is drawn (PRD-3 §9.6). */
export const NARROW_WIDTH = 100;
export const MIN_WIDTH = 60;
/**
 * The height guard PRD-3 §9.6 never specified.
 *
 * There was a `MIN_WIDTH` and no counterpart, so a short terminal did not degrade — it overflowed.
 * The three sidebar panes had floors summing to 20 rows, the budget handed out 20 rows plus a
 * header and a key bar, and the run list's bottom border was drawn straight over the key bar. A
 * tmux split or an editor's terminal drawer is routinely shorter than that.
 */
export const MIN_HEIGHT = 12;

/**
 * 14, not 20.
 *
 * The case pane is fixed-height on purpose — sizing it to its alert resized the run list below it
 * and made the list jump under the analyst's own keypress. But a fixed 20 on a 64-row terminal
 * meant eighteen rows holding seven rows of facts while the run list, with forty-four runs in it,
 * had twenty-six. Fourteen covers a full alert including its entities and hands the rest to the
 * pane that gains from length. Below about 47 rows the share is under the cap and nothing changes.
 */
export const CASE_MAX_HEIGHT = 14;
export const CASE_MIN_HEIGHT = 8;
/** Under five rows the case pane is two borders and a scrollbar, so it gives up its space. */
const CASE_ABS_MIN_HEIGHT = 5;
export const QUEUE_MAX_HEIGHT = 18;
export const QUEUE_MIN_HEIGHT = 6;
/** Under four rows the queue shows one alert; below that it is worth less than the rows cost. */
const QUEUE_ABS_MIN_HEIGHT = 4;
export const RUNS_MIN_HEIGHT = 6;
/** Rows the main pane keeps in narrow mode before the sidebar may take any. */
const NARROW_MAIN_MIN_HEIGHT = 10;
/**
 * Stacked, the same terminal needs more rows than `MIN_HEIGHT`.
 *
 * Side by side, the main pane takes the whole column and only the sidebar is divided. Stacked, the
 * run list and the main pane share one budget, and below their two floors the layout cannot honour
 * both — at 60x12 the run list won against a zero-row sidebar and drew straight through pane [4]'s
 * frame. Saying "too short" is the honest outcome; drawing two panes over each other is not.
 */
export const MIN_NARROW_HEIGHT = RUNS_MIN_HEIGHT + NARROW_MAIN_MIN_HEIGHT + 2;

/**
 * Prose takes the pane. There is no measure cap.
 *
 * There was one, at 96 characters and then at 120, on the reasoning that past about a hundred
 * characters the eye stops reliably finding the start of the next line. That is true of a printed
 * column and false of this pane: at 269 columns the cap left roughly fifty columns of empty frame
 * inside a drawn border, and empty frame reads as a rendering fault, not as a considered margin.
 * A reader who wants a narrower measure can narrow the window; a reader who has widened it has
 * said what they want.
 *
 * The sidebar still takes its share first, so the main pane is never the only thing absorbing a
 * wide terminal — that is what keeps the line length reasonable at ordinary sizes without a cap.
 */
export function measure(bodyWidth: number): number {
  return bodyWidth;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The narrowest a body column is allowed to be, and the gap between two of them.
 *
 * Sixty-four is about a printed book's measure — comfortably readable, and narrow enough that a
 * genuinely wide terminal gets three columns rather than two lopsided ones.
 */
const MIN_COLUMN_WIDTH = 64;
export const COLUMN_GUTTER = 6;
export const MAX_COLUMNS = 3;

/** How many columns a body of this width should be laid out in. */
export function columnCount(bodyWidth: number): number {
  const fit = Math.floor((bodyWidth + COLUMN_GUTTER) / (MIN_COLUMN_WIDTH + COLUMN_GUTTER));
  return clamp(fit, 1, MAX_COLUMNS);
}

/**
 * Where to cut an ordered list of sections into `count` columns of about equal height.
 *
 * Columns are drawn row by row, so what they look like is decided entirely by how evenly the
 * content is split. Assigning them by meaning — context here, argument there, evidence in the
 * third — read well as a sentence and rendered badly: a fourteen-line WHAT HAPPENED beside a
 * sixty-line stack of evidence is not two columns, it is one column and a hole.
 *
 * Cuts are contiguous, so reading order survives: down the first column, then the second. The
 * search is exhaustive because there are never more than a handful of sections and the cost of
 * getting it wrong is the whole screen.
 */
export function balancedCuts(heights: number[], count: number): number[] {
  const total = heights.length;
  const groups = Math.min(count, total);
  if (groups <= 1) return [total];

  const height = (from: number, to: number): number =>
    heights.slice(from, to).reduce((sum, each) => sum + each, 0);

  let best: number[] = [total];
  let bestWorst = Number.POSITIVE_INFINITY;

  const walk = (start: number, left: number, cuts: number[]): void => {
    if (left === 1) {
      const all = [...cuts, total];
      let previous = 0;
      let worst = 0;
      for (const cut of all) {
        worst = Math.max(worst, height(previous, cut));
        previous = cut;
      }
      if (worst < bestWorst) {
        bestWorst = worst;
        best = all;
      }
      return;
    }
    for (let cut = start + 1; cut <= total - left + 1; cut += 1) {
      walk(cut, left - 1, [...cuts, cut]);
    }
  };

  walk(0, groups, []);
  return best;
}

export type TooSmall = "narrow" | "short";

/** Why the dashboard cannot be drawn, if it cannot. */
export function tooSmall(width: number, height: number): TooSmall | undefined {
  if (width < MIN_WIDTH) return "narrow";
  if (height < (width < NARROW_WIDTH ? MIN_NARROW_HEIGHT : MIN_HEIGHT)) return "short";
  return undefined;
}

/** The rows this width needs before the dashboard is drawn — the number the message quotes. */
export function minHeightFor(width: number): number {
  return width < NARROW_WIDTH ? MIN_NARROW_HEIGHT : MIN_HEIGHT;
}

export interface Layout {
  /** Panes stack in one column rather than sitting side by side. */
  narrow: boolean;
  sidebarWidth: number;
  /** Rows the sidebar occupies as a block. Narrow mode has to state this or it takes them all. */
  sidebarHeight: number;
  /** Rows per sidebar pane, borders included. Zero means the pane is not drawn at this size. */
  caseHeight: number;
  alertsHeight: number;
  runsHeight: number;
}

/**
 * Every pane's geometry, derived from the terminal alone.
 *
 * Purely from the terminal, deliberately: a budget that consulted the selected alert would resize
 * pane [3] as an analyst moved down pane [2], which is the reflow the fixed heights were introduced
 * to stop. Nothing here reads content.
 *
 * The allocation is a cascade in reverse priority order — the run list is served first because it
 * is the only route to a run, then the queue, and the case facts last because pane [4] renders the
 * same facts and can be reached at any size. Whatever survives the cascade returns to the run list,
 * which is the pane that gains from being long. The sum never exceeds the rows available, which is
 * the whole point: the previous budget could hand out 21 rows in a 20-row column.
 */
export function layout(width: number, height: number): Layout {
  const narrow = width < NARROW_WIDTH;
  // Surplus width goes to the sidebar until it reaches its ceiling, because that is the pane whose
  // content is being cut: at 200 columns `[3] Case` was still clipping `SOC-RULE-0001-RdpBruteFo…`
  // and every run title ended in an ellipsis, while the main pane had room it was not using.
  const sidebarWidth = narrow
    ? width
    : Math.min(
        clamp(Math.round(width * SIDEBAR_SHARE), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        Math.max(SIDEBAR_MIN_WIDTH, width - MAIN_MIN_WIDTH),
      );

  // The header and the key bar are drawn outside the columns and are never negotiable.
  const rows = Math.max(0, height - 2);
  const mainRows = narrow
    ? Math.min(rows, Math.max(NARROW_MAIN_MIN_HEIGHT, Math.round(rows * 0.45)))
    : 0;

  let left = rows - mainRows;

  const runsFloor = Math.min(left, RUNS_MIN_HEIGHT);
  left -= runsFloor;

  const alertsWanted = clamp(
    Math.floor(rows * (narrow ? 0.5 : 0.35)),
    QUEUE_MIN_HEIGHT,
    QUEUE_MAX_HEIGHT,
  );
  const alertsHeight =
    Math.min(left, alertsWanted) < QUEUE_ABS_MIN_HEIGHT ? 0 : Math.min(left, alertsWanted);
  left -= alertsHeight;

  const caseWanted = clamp(Math.floor(rows * 0.3), CASE_MIN_HEIGHT, CASE_MAX_HEIGHT);
  const caseHeight =
    narrow || Math.min(left, caseWanted) < CASE_ABS_MIN_HEIGHT ? 0 : Math.min(left, caseWanted);
  left -= caseHeight;

  const runsHeight = runsFloor + left;

  return {
    narrow,
    sidebarWidth,
    sidebarHeight: caseHeight + alertsHeight + runsHeight,
    caseHeight,
    alertsHeight,
    runsHeight,
  };
}
