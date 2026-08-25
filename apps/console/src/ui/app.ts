import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { InvestigationControl, LiveRun } from "@soc/investigator/control";
import type { ModelChoice } from "@soc/investigator/model";

import { readAlerts, type QueueAlert } from "../data/alerts.ts";
import { pollRuns, pollTrace, type Stoppable } from "../data/poll.ts";
import type { RunArtifact, RunResult, UnreadableRun } from "../data/runs.ts";
import { aggregate, indexAll, resolveTracePath, runTotals, type Aggregate } from "../data/stats.ts";
import { readAlert, readEvent, readToolResult } from "../data/trace-detail.ts";
import { indexTrace, type ToolCall, type TraceIndex } from "../data/trace-index.ts";
import type { ConsoleEnv } from "../env.ts";
import { queryLanguageForCall, type ActivityRow } from "../view/activity.ts";
import {
  alertFactsFromAlert,
  alertFactsFromResult,
  alertLines,
  enrichWithAlertJson,
  remediationLines,
  type AlertFacts,
} from "../view/alert.ts";
import { duplicateSpend, queueRows } from "../view/coverage.ts";
import {
  bandLabel,
  bandTone,
  classificationForBand,
  classificationLabel,
  definitionRow,
  linesText,
  prose,
  plural,
  truncate,
  verdictBand,
  wrap,
  type Line,
} from "../view/format.ts";
import {
  CASE_MAX_HEIGHT,
  MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  layout,
  minHeightFor,
  measure,
  tooSmall,
} from "../view/layout.ts";
import { RUN_STATE_WORD, classifyRun, isPending, resultsWithPending } from "../view/run-list.ts";
import { toTranscript, transcriptLines, type TranscriptBlock } from "../view/transcript.ts";
import { pendingLine, queueLines, runRows, scrollOffset, windowed } from "./panes/lists.ts";
import {
  activityBody,
  callArgsText,
  callDetail,
  configBody,
  progressBody,
  streamBody,
  verdictBody,
} from "./panes/main.ts";
import { styled } from "./styled.ts";
import { COLOR } from "./theme.ts";

type Tab = "verdict" | "activity" | "transcript" | "stream";
type Focus = 1 | 2 | 3 | 4;
type Screen = "dashboard" | "config" | "help";

/**
 * Order matters: the stream sits beside the verdict because those are the two an analyst watches.
 * Activity and Transcript are for going back over a finished run, so they follow.
 */
const TABS: Tab[] = ["verdict", "stream", "activity", "transcript"];

/** Display names. "stream" alone did not say whose. */
const TAB_LABEL: Record<Tab, string> = {
  verdict: "verdict",
  stream: "agent stream",
  activity: "activity",
  transcript: "transcript",
};
/**
 * Sidebar geometry lives in `view/layout.ts`.
 *
 * It is arithmetic over two numbers, it was the source of both ways this screen broke at the edges
 * of the size envelope, and it is now a pure function with tests rather than eleven expressions
 * inside `render`. The rule it encodes has not changed: every pane is sized from the *terminal*,
 * never from its contents. Sizing the case pane to its alert looked tidier and was wrong — moving
 * down the run list resized the pane below it, and the list appeared to jump under the analyst's
 * own keypress.
 */
/** The four classifications, in the order the overlay cycles them (PRD-5 §10). */
const CLASSIFICATIONS = [
  "TruePositive",
  "BenignPositive",
  "FalsePositive",
  "Undetermined",
] as const;

/**
 * How many fields each overlay has, so traversal cycles without falling off the end.
 *
 * Traversal is ours: OpenTUI 0.5.4 ships no `focusNext`, `focusPrevious` or `tabIndex` at all
 * (PRD-5 §12.5), so this is the single place that knows the shape of each form.
 */
function fieldCount(kind: ComposeKind): number {
  switch (kind) {
    // Start takes the same inputs as a re-run — context and a model. Offering them only on a
    // re-run meant the first investigation of an alert could not be steered or re-pointed without
    // running it once with the defaults first, which is a strange thing to make someone do.
    case "start":
      return 2;
    case "rerun":
      return 2;
    case "feedback":
      return 2;
  }
}

/** Which field index holds the model list, or `-2` for overlays that have none. */
function modelField(kind: ComposeKind): number {
  return kind === "feedback" ? -2 : 1;
}

/**
 * The cursor column, and the one place that decides what "focused" looks like.
 *
 * Every row asks this rather than testing `field` inline, so a row cannot end up marked focused
 * while another is taking keys — which is what the old strip did by painting a highlighted
 * `Cancel` at all times, next to a `▶` sitting on a different row.
 */
function fieldMark(compose: ComposeState, field: number): { text: string; tone: "accent" } {
  return { text: compose.field === field ? "  ▶ " : "    ", tone: "accent" };
}

/**
 * The overlay's own title, on the overlay's own border.
 *
 * It used to be `[4]`'s title, because compose replaced the pane's contents; a modal about a
 * *queue* alert then appeared to belong to whatever run was selected. Now that the overlay is a
 * box floating over `[4]` (§12.4), the border carries the subject and the pane underneath keeps
 * telling the truth about itself.
 */
function composeTitle(compose: ComposeState): string {
  const alert = truncate(compose.alertTitle, 44);
  switch (compose.kind) {
    case "start":
      return `Start an investigation — ${alert}`;
    case "rerun":
      return `Re-run — ${alert}`;
    case "feedback":
      return `Your feedback — ${alert}`;
  }
}

/**
 * What the action button says it will do.
 *
 * A generic "Confirm" makes the overlay that spends money look identical to the one that writes a
 * local file — and the button is the last thing read before pressing it.
 */
function confirmVerb(kind: ComposeKind): string {
  switch (kind) {
    case "start":
      return "Start";
    case "rerun":
      return "Run";
    case "feedback":
      return "Save";
  }
}

/**
 * Where the compose form's values start: the cursor column plus the widest label.
 *
 * `fieldMark` is four characters and `comment  ` is nine, so anything hanging under a value — the
 * comment field's description — lines up here rather than at the pane's own margin.
 */
const COMMENT_GUTTER = 13;

/**
 * Rows of the model list shown at once.
 *
 * The list is windowed rather than complete because the overlay floats over `[4]` and must not
 * grow past it. Eight is enough to read the shape of the catalogue without the confirm strip
 * leaving the box on a short terminal.
 */
const MODEL_LIST_HEIGHT = 8;

/** Public contract for the two terminal inputs that perform compose traversal. */
export const COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS = ["tab", "shift+tab"] as const;

function composeTraversalKey(
  key: KeyEvent,
): (typeof COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS)[number] | undefined {
  if (key.name !== "tab") return undefined;
  return key.shift ? "shift+tab" : "tab";
}

/**
 * Why the transcript tabs have nothing to show.
 *
 * Two different absences, and telling an analyst the wrong one is worse than saying nothing: a
 * traced run that has only just started has no transcript *yet*, and reporting that as "tracing
 * was off" describes a configuration the run does not have (PRD-3 §11).
 */
function noTranscriptLines(waiting: boolean, width: number): Line[] {
  if (waiting) {
    return [
      "",
      [{ text: "  Waiting for this investigation's transcript.", tone: "heading", bold: true }],
      "",
      ...prose(
        "Tracing is on for this run, so the file appears as soon as the agent writes its first " +
          "event; this pane picks it up within a second and follows it from there.",
        width,
      ),
    ];
  }
  return [
    "",
    [{ text: "  No transcript for this investigation.", tone: "heading", bold: true }],
    "",
    ...prose(
      "Tracing was off when this run happened (INVESTIGATOR_TRACE=false), so its tool calls, " +
        "reasoning, source queries and token usage were never written down.",
      width,
    ),
    "",
    [{ text: "  Future runs record them with:", tone: "label" }],
    "    INVESTIGATOR_TRACE=true bun run investigate",
  ];
}

/**
 * The help screen, as the definition list it always was.
 *
 * Every line here used to be a hand-padded string sized to a guess, so the screen needed about 136
 * columns to render without soft-wrapping under its own border — and the one place an analyst
 * reads carefully was the worst offender on the whole dashboard. The keys are data now, the prose
 * is wrapped to the pane, and the sections carry headings in the same voice the verdict pane uses.
 */
const HELP_SECTIONS: { heading: string; keys: [string, string][]; notes?: string[] }[] = [
  {
    heading: "MOVING AROUND",
    keys: [
      ["1 2 3 4", "focus Alerts, Runs, Case, Main"],
      ["j k ↓ ↑", "move within the focused panel"],
      ["g G", "first / last"],
      ["[ ]", "previous / next tab — Verdict · Agent stream · Activity · Transcript"],
      ["⏎", "expand the selected call, or load a transcript block in full"],
      ["⎋", "back, or clear the filter"],
      ["/", "filter the focused list — see WHILE FILTERING below"],
      ["y", "copy the focused pane — on a call, the exact source query"],
    ],
  },
  {
    heading: "THE QUEUE",
    keys: [
      ["n", "start an investigation on the selected alert"],
      ["s", "show only alerts with ground truth behind them"],
      ["a", "also show alerts that already have a run"],
    ],
    notes: [
      "The left glyph is what has been tried against an alert: blank is nothing yet, ● is a run " +
        "that has it now, ✓ is investigated, ✓· is only ever run with analyst context supplied, " +
        "and ✗ means every run against it failed.",
      "◆ marks an alert with ground truth behind it. The scenario id is deliberately not shown, " +
        "because most scenario names give the verdict away.",
      "Counts do not fold duplicates: 107 of the 151 alerts are two vendor views of 54 events, so " +
        "the outstanding-work number overstates by roughly fifty.",
    ],
  },
  {
    heading: "ACTING ON A RUN",
    keys: [
      ["r", "re-run this alert with context and a chosen model"],
      ["f", "record your feedback on this investigation"],
      ["x", "cancel a running investigation"],
      ["F", "Agent stream: follow the tail, or stop following"],
    ],
  },
  {
    heading: "THE CONSOLE",
    keys: [
      ["c", "configuration and cost"],
      ["R", "re-read from disk now"],
      ["?", "this help"],
      ["q  Ctrl-C", "quit"],
    ],
    notes: ["The investigator is the sole writer of runs/. Your feedback goes to feedback/."],
  },
  {
    heading: "WHILE FILTERING",
    keys: [
      ["type", "narrow the list; the count in the pane title is matches / total"],
      ["↑ ↓", "move through the matches, without closing the input"],
      ["⏎", "keep the filter and go back to the normal keys"],
      ["⎋", "clear the filter"],
    ],
    notes: [
      "j and k are printable, so they narrow the query rather than moving — use the arrows. The " +
        "selection stays on whatever run it was on for as long as that run still matches, and " +
        "drops to the first match when it stops.",
    ],
  },
  {
    heading: "IN THE n / r / f OVERLAY",
    keys: [
      ["↑ ↓ ⇥", "move between fields, and through the model list"],
      ["type", "fill the focused field; on the model row it filters the list"],
      ["⏎", "accept the field and move on; on Cancel or Confirm it acts"],
      ["⎋", "close the overlay in one press, from anywhere in it"],
    ],
    notes: ["Confirm always starts on Cancel. Nothing is spent by a key you were already holding."],
  },
  {
    heading: "IMPACT",
    keys: [
      ["none", "attempted, and achieved nothing"],
      ["contained", "succeeded, then was stopped or reverted"],
      ["confirmed-compromise", "achieved something that matters"],
      ["unknown", "the available telemetry cannot say"],
    ],
    notes: [
      "The agent's own field, submitted alongside TP/FP. A brute force where every attempt failed " +
        "is a true positive with impact 'none'.",
    ],
  },
];

function helpLines(width: number): Line[] {
  const lines: Line[] = [];
  for (const section of HELP_SECTIONS) {
    lines.push("", [{ text: `  ${section.heading}`, tone: "heading", bold: true }]);
    const termWidth = Math.max(...section.keys.map(([term]) => term.length)) + 2;
    for (const [term, detail] of section.keys) {
      lines.push(...definitionRow(term, detail, width, termWidth));
    }
    for (const note of section.notes ?? []) lines.push("", ...prose(note, width, "dim"));
  }
  return lines;
}

/**
 * Everything about a run an analyst might type into the filter.
 *
 * The alert titles matter most — nobody remembers a run id — but the id, the model and the verdict
 * band are all things someone might be looking for, and matching over the lot costs nothing at
 * this scale.
 */
function resultHaystack(result: RunResult): string {
  return [
    result.alertId,
    result.alertTitle ?? "",
    result.alert?.severity ?? "",
    bandLabel(verdictBand(result.summary?.tpPercent)),
  ]
    .join(" ")
    .toLowerCase();
}

function runHaystack(run: RunArtifact): string {
  return [run.runId, run.model?.id ?? "", ...run.results.map(resultHaystack)]
    .join(" ")
    .toLowerCase();
}

/**
 * The key bar, fitted to the terminal rather than clipped by it.
 *
 * It was one fixed string 95 characters long, so anything narrower cut it from the right — and the
 * two hints on the right are `? help` and `q quit`. The bar was dropping the way out and the way to
 * the full key list exactly when the screen was too small to make sense of, which is when a reader
 * needs them most.
 *
 * Hints go by how recoverable they are, and then by how widely they apply. `?` and `q` cannot be
 * reached from anywhere else and never leave. `c` follows them: it works from every pane, it is
 * where spend is reported, and it was the one key on that footing missing from the bar — while
 * `n`, `r`, `f` and `x` were all listed despite each working in only one pane. Those four go first.
 */
const KEY_HINTS: { text: string; rank: number }[] = [
  { text: "1-4 pane", rank: 3 },
  { text: "j/k move", rank: 3 },
  { text: "n start", rank: 5 },
  { text: "r re-run", rank: 6 },
  { text: "f feedback", rank: 7 },
  { text: "x cancel", rank: 7 },
  { text: "/ filter", rank: 4 },
  { text: "c config", rank: 2 },
  { text: "? help", rank: 1 },
  { text: "q quit", rank: 1 },
];

function keyBarText(width: number): string {
  for (let rank = 7; rank >= 1; rank -= 1) {
    const text = ` ${KEY_HINTS.filter((hint) => hint.rank <= rank)
      .map((hint) => hint.text)
      .join("   ")}`;
    if (text.length <= width) return text;
  }
  return truncate(" ? help   q quit", width);
}

export interface AppOptions {
  runsDir: string;
  tracesDir: string;
  env: ConsoleEnv;
  /** Hide artifacts present at startup while retaining runs launched during this session. */
  fresh?: boolean;
  /**
   * Renderer to draw into. Omitted in production, where the app owns the terminal; supplied by
   * tests, which pass `createTestRenderer`'s so panes can be snapshot-tested with no terminal
   * attached (PRD-3 §12).
   */
  renderer?: CliRenderer;
  /** Overridden by tests so quitting does not take the test process with it. */
  exit?: (code: number) => void;
  /**
   * How the console drives the investigator (PRD-5 §5.3).
   *
   * Optional: with no control the console is exactly what PRD-3 built — a reader. Tests inject a
   * fake so a keypress can start a "run" with no provider, no model and no network.
   */
  control?: InvestigationControl;
}

export interface AppHandle {
  /** Stop polling and background indexing. Does not destroy an injected renderer. */
  stop(): void;
  /** Resolves once the initial run listing and first transcript have been read. */
  ready: Promise<void>;
}

interface State {
  runs: RunArtifact[];
  unreadable: UnreadableRun[];
  runIndex: number;
  resultIndex: number;
  tab: Tab;
  focus: Focus;
  screen: Screen;
  index?: TraceIndex;
  indexKey?: string;
  indexes: Map<string, TraceIndex>;
  growing: Set<string>;
  aggregate?: Aggregate;
  activityRows: ActivityRow[];
  activitySelected: number;
  detailOpen: boolean;
  follow: boolean;
  /** The alert under investigation, from the artifact and enriched from the transcript. */
  alertFacts?: AlertFacts;
  transcriptBlocks: TranscriptBlock[];
  transcriptSelected: number;
  /** Full text of the expanded transcript block, read back from disk on demand. */
  expandedText?: string;
  /** Scroll offsets for the two lists, carried so the window never re-centres under a keypress. */
  runScroll: number;
  alertScroll: number;
  /** The `/` filter: what was typed, which list it applies to, and whether it is still open. */
  filter: string;
  filterTarget: 1 | 2;
  filtering: boolean;
  /** A one-shot message for the key bar, cleared by the next keypress. */
  notice?: string;

  // ---- PRD-5: the queue, and driving the agent -------------------------------------------------
  /** The alert corpus. Fetched on entry and on `r`, never polled — the corpus barely changes. */
  alerts: QueueAlert[];
  /** Degraded reason, already phrased as the action that fixes it. */
  alertsError?: string;
  queueIndex: number;
  queueScroll: number;
  /** `s` — show only alerts that have ground truth behind them. */
  groundTruthOnly: boolean;
  /**
   * `a` — include alerts that already have a run.
   *
   * Off by default: once an investigation starts, the alert's place is [2], where the run is. A
   * queue that keeps showing it is asking the analyst to track the same item in two panes. Bring it
   * back with `bun run queue:reset`, which is the whole point of that command.
   */
  showCovered: boolean;
  /**
   * Which list [4] is detailing: the queue's alert, or the selected run.
   *
   * Not derived from `state.focus`. Pressing `4` focuses the pane so it can be scrolled — it must
   * not change what the pane is *about*, which is what happened when the branch read focus
   * directly: an analyst reading an alert pressed `4` to scroll it and landed on a finished run.
   */
  mainSource: "queue" | "run";
  /**
   * Authoritative input mode (PRD-5 §12.5).
   *
   * Never derived from renderer focus. `set visible` blurs only the renderable it is called on, so
   * a guard reading focus stays true after the overlay is hidden and swallows every key forever.
   */
  mode: "browse" | "compose";
  compose?: ComposeState;
  /**
   * Models this machine can actually run, fetched once at startup.
   *
   * Cached rather than fetched per render because the check is a credential probe per provider,
   * and because `composeLines` is called on every draw. Empty means no provider is configured —
   * which the overlay says out loud rather than offering an empty picker.
   */
  models: ModelChoice[];
  /** Distinguishes "the probe has not finished" from "nothing is runnable". */
  modelsLoaded: boolean;
  /** Runs started in this process, by runId — merged with `runs/` so a start renders once. */
  liveRuns: Map<string, LiveRun>;
  /** One-shot: select this run the moment it appears, rather than leaving the analyst's row put. */
  pendingRunId?: string;
  /**
   * Durable, unlike `notice`, which the next keypress clears (PRD-5 §5.1).
   *
   * Durable meant "survives keypresses long enough to be read", not "forever" — the first cut had
   * no expiry at all, so one started run replaced the key bar for the rest of the session. It now
   * carries a deadline: long enough that an async failure cannot be missed, short enough that the
   * keys come back on their own. The run poller redraws every second, so it clears itself.
   */
  status?: { text: string; failed: boolean; until: number };
}

type ComposeKind = "start" | "rerun" | "feedback";

interface ComposeState {
  kind: ComposeKind;
  alertId: string;
  alertTitle: string;
  /**
   * Which field has focus. `-1` is the confirm strip, which is where every overlay opens.
   *
   * Opening on the first *field* was tried and reverted: it made the common case — start this
   * alert on the configured model — cost four keystrokes instead of two, and it put an optional
   * free-text box under the cursor, which reads as something that must be filled before you may
   * proceed. The double-focus that motivated the move had a different cause and is fixed where it
   * belonged: the strip now marks its choice only while it holds focus.
   */
  field: number;
  context: string;
  /**
   * The chosen model, by value rather than by index.
   *
   * An index into the offered list cannot survive the filter: type two characters and index 3 is a
   * different model, silently. Holding the choice itself means the highlighted row and the model
   * that will run are the same thing by construction — which is the property worth having, because
   * the failure it prevents is spending money on a model the operator did not pick.
   */
  model?: ModelChoice;
  /** Type-to-filter over the offered models. Only meaningful while the model row has focus. */
  modelFilter: string;
  /** Window offset for the model list, carried so it does not re-centre under the cursor. */
  modelOffset: number;
  classificationIndex: number;
  comment: string;
  /** Confirm defaults to Cancel: a modal dismissed by a held key is theatre (PRD-5 §12.4). */
  confirm: boolean;
  runId?: string;
}

export async function runApp(options: AppOptions): Promise<AppHandle> {
  const { env, runsDir, tracesDir } = options;
  const owned = options.renderer === undefined;
  const renderer = options.renderer ?? (await createCliRenderer());
  const exit = options.exit ?? ((code: number) => process.exit(code));

  /**
   * Declared before anything can draw.
   *
   * `render()` guards on it: an async load — the alert corpus, a transcript, a control event — can
   * resolve after the renderer has been destroyed, and OpenTUI throws "TextBuffer is destroyed"
   * rather than ignoring it. In tests that surfaced as failures in *other* files, because a stray
   * interval outlives the app that created it.
   */
  let closed = false;
  let freshBaselineCaptured = false;
  const hiddenRunIds = new Set<string>();
  const hiddenUnreadablePaths = new Set<string>();

  const state: State = {
    runs: [],
    unreadable: [],
    runIndex: 0,
    resultIndex: 0,
    tab: "verdict",
    /**
     * The queue is what you open the console to look at — when there is one.
     *
     * Without a control there is no alert corpus to fetch, so [1] would open empty and [4] would
     * describe a selection that cannot exist. A read-only console opens on the runs it can actually
     * read (PRD-5 §12.2).
     */
    focus: options.control === undefined ? 2 : 1,
    screen: "dashboard",
    indexes: new Map(),
    growing: new Set(),
    activityRows: [],
    activitySelected: 0,
    detailOpen: false,
    follow: true,
    transcriptBlocks: [],
    transcriptSelected: 0,
    runScroll: 0,
    alertScroll: 0,
    filter: "",
    filterTarget: 2,
    filtering: false,
    alerts: [],
    queueIndex: 0,
    queueScroll: 0,
    groundTruthOnly: false,
    showCovered: false,
    mainSource: options.control === undefined ? "run" : "queue",
    mode: "browse",
    models: [],
    modelsLoaded: false,
    liveRuns: new Map(),
  };

  // ---- layout ------------------------------------------------------------------------------
  const screen = new BoxRenderable(renderer, {
    id: "screen",
    flexDirection: "column",
    flexGrow: 1,
  });
  renderer.root.add(screen);

  const header = new TextRenderable(renderer, { id: "header", height: 1, fg: COLOR.label });
  const content = new BoxRenderable(renderer, { id: "content", flexDirection: "row", flexGrow: 1 });
  const keyBar = new TextRenderable(renderer, { id: "keybar", height: 1, fg: COLOR.dim });
  screen.add(header);
  screen.add(content);
  screen.add(keyBar);

  const sidebar = new BoxRenderable(renderer, {
    id: "sidebar",
    width: SIDEBAR_MIN_WIDTH,
    flexDirection: "column",
  });
  const caseBox = new BoxRenderable(renderer, {
    id: "case",
    height: CASE_MAX_HEIGHT,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    title: "[3] Case",
    borderColor: COLOR.border,
    titleColor: COLOR.title,
  });
  const caseScroll = new ScrollBoxRenderable(renderer, { id: "case-scroll", flexGrow: 1 });
  const caseText = new TextRenderable(renderer, { id: "case-text", fg: COLOR.text });
  caseScroll.add(caseText);
  caseBox.add(caseScroll);

  const runsBox = new BoxRenderable(renderer, {
    id: "runs",
    flexGrow: 1,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    title: "[2] Runs",
    borderColor: COLOR.border,
    titleColor: COLOR.title,
  });
  const runsText = new TextRenderable(renderer, { id: "runs-text", fg: COLOR.text });
  runsBox.add(runsText);

  const alertsBox = new BoxRenderable(renderer, {
    id: "alerts",
    height: 4,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    title: "[1] Alerts",
    borderColor: COLOR.border,
    titleColor: COLOR.title,
  });
  const alertsText = new TextRenderable(renderer, { id: "alerts-text", fg: COLOR.text });
  alertsBox.add(alertsText);
  // Alerts, runs, then the case facts. The alert list leads because it is what the analyst is
  // actually looking at; the run it belongs to is context, and the facts are detail.
  sidebar.add(alertsBox);
  sidebar.add(runsBox);
  sidebar.add(caseBox);

  const mainBox = new BoxRenderable(renderer, {
    id: "main",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    title: "[4]",
    borderColor: COLOR.border,
    titleColor: COLOR.title,
  });
  // Outside the scroll box, so it stays put, and outside the box *title*, which is a plain string
  // that cannot show which tab is active (PRD-3 §9.2).
  const tabBar = new TextRenderable(renderer, { id: "tab-bar", height: 2, fg: COLOR.text });
  const mainScroll = new ScrollBoxRenderable(renderer, { id: "main-scroll", flexGrow: 1 });
  const mainText = new TextRenderable(renderer, { id: "main-text", fg: COLOR.text });
  mainScroll.add(mainText);
  mainBox.add(tabBar);
  mainBox.add(mainScroll);

  /**
   * The compose overlay: a bordered box floating over `[4]`, which is what §12.4 specified.
   *
   * The first cut rendered it *as* `[4]`'s body instead, so the pane it was supposed to cover
   * vanished underneath it and the modal inherited the pane's title. Absolute positioning inside
   * `mainBox` keeps the alert or run you were reading visible around the edges, and gives the box
   * its own border and title so there is never a question about what the keys are acting on.
   *
   * Nothing here calls `.focus()`. `state.mode` is the only thing that routes keys (§12.5), so the
   * library's non-recursive `set visible` blur has nothing to strand.
   */
  const composeBox = new BoxRenderable(renderer, {
    id: "compose",
    position: "absolute",
    top: 1,
    left: 0,
    right: 0,
    zIndex: 20,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.accent,
    titleColor: COLOR.accent,
  });
  const composeText = new TextRenderable(renderer, { id: "compose-text", fg: COLOR.text });
  composeBox.add(composeText);
  mainBox.add(composeBox);

  content.add(sidebar);
  content.add(mainBox);

  // ---- derived state -----------------------------------------------------------------------
  /** Selection indices address the filtered lists, so everything downstream reads these. */
  /** Every run this console knows about: on disk, plus the ones it started moments ago. */
  function allRuns(): RunArtifact[] {
    return [...liveOnlyRuns(), ...state.runs];
  }

  function visibleRuns(): RunArtifact[] {
    // In-process runs first: a run started here is known before its artifact reaches disk, and
    // `liveOnlyRuns` drops any whose file has since appeared so it renders once (PRD-5 §8).
    const all = allRuns();
    if (state.filter === "" || state.filterTarget !== 2) return all;
    const needle = state.filter.toLowerCase();
    return all.filter((run) => runHaystack(run).includes(needle));
  }

  /**
   * The selected run's alerts: finished ones, then the ones it is still working through.
   *
   * The pending rows are what let everything downstream address an alert *while* it is being
   * investigated — the transcript tail, the tab bar, pane [4]. Without them a single-alert run is
   * a row with nothing behind it for its whole lifetime (PRD-3 §13).
   */
  function allResults(): RunResult[] {
    return resultsWithPending(visibleRuns()[state.runIndex]);
  }

  /**
   * The selected run's alerts. Never filtered.
   *
   * This used to narrow on `filterTarget === 1`, from before PRD-5 §7 made pane [1] the alert
   * *queue* rather than a list of the selected run's alerts. Since then the two have shared one
   * needle while being different lists, and the result list is not drawn anywhere — it only feeds
   * `currentResult`, which is the alert pane [4] describes. So filtering the queue for something a
   * run's own alert did not match emptied this list, and [4] went blank for a run that was still
   * selected and still perfectly readable, with nothing on screen saying why.
   */
  function visibleResults(): RunResult[] {
    return allResults();
  }

  /**
   * The queue: every alert, folded against the runs already in memory (PRD-5 §4.2).
   *
   * Derived on every render rather than stored. The join is a map lookup per alert and the corpus
   * is ~150 rows, so recomputing costs nothing and cannot drift from the runs it describes — which
   * a cached queue would, silently, the moment a run finished.
   */
  function visibleQueue(): ReturnType<typeof queueRows> {
    const rows = queueRows(state.alerts, allRuns(), {
      groundTruthOnly: state.groundTruthOnly,
      // `attempted` stays: every run against it failed, so the work is outstanding rather than
      // done, and hiding a crashed investigation is the one outcome that silently loses work.
      outstandingOnly: !state.showCovered,
    });
    if (state.filter === "" || state.filterTarget !== 1) return rows;
    const needle = state.filter.toLowerCase();
    return rows.filter((row) =>
      `${row.alertId} ${row.title} ${row.severity} ${row.vendorStatus} ${row.groundTruth}`
        .toLowerCase()
        .includes(needle),
    );
  }

  /**
   * Why the queue is empty, which is three different situations.
   *
   * "Press r" is only true before the corpus arrives. Saying it when 154 alerts are loaded and the
   * filters have excluded all of them sends the analyst to reload data they already have.
   */
  function emptyQueueReason(): string {
    if (state.alerts.length === 0) {
      return control === undefined ? "no control — opened read-only" : "press R to load alerts";
    }
    if (state.filter !== "" && state.filterTarget === 1) return "no alert matches the filter";
    // Kept inside the 46-column pane: a wrapped hint is harder to read than a short one.
    if (state.groundTruthOnly && !state.showCovered) return "◆ all have runs — press a, or reset";
    if (state.groundTruthOnly) return "no alert has ground truth";
    if (!state.showCovered) return "nothing outstanding — press a for all";
    return "no alerts";
  }

  const currentQueueAlert = (): QueueAlert | undefined => {
    const row = visibleQueue()[state.queueIndex];
    if (row === undefined) return undefined;
    return state.alerts.find((alert) => alert.alertId === row.alertId);
  };

  const currentRun = (): RunArtifact | undefined => visibleRuns()[state.runIndex];
  const currentResult = (): RunResult | undefined => visibleResults()[state.resultIndex];

  /** Keep both selections inside their filtered lists after the filter or the data changes. */
  /**
   * Change the filter with the selection pinned to whatever it was pointing at.
   *
   * Every selection index in this console addresses a *filtered* list, so any change to the filter
   * changes what the index means. Left alone, the cursor stayed at row N of a list that was now a
   * different list: typing slid the selection from run to run a character at a time, and clearing
   * the filter with `⎋` dropped it onto whatever happened to sit at that offset in the full list.
   *
   * Pinning it keeps the selected run selected for as long as it still matches, drops to the first
   * match when it stops matching — the only other place a reader expects the cursor to be — and
   * reads a transcript only when the selection genuinely moved.
   */
  function withAnchoredSelection(change: () => void): void {
    const run = currentRun()?.runId;
    const alert = currentQueueAlert()?.alertId;

    change();

    if (state.filterTarget === 2) {
      const at = visibleRuns().findIndex((candidate) => candidate.runId === run);
      state.runIndex = at === -1 ? 0 : at;
    } else {
      const at = visibleQueue().findIndex((row) => row.alertId === alert);
      state.queueIndex = at === -1 ? 0 : at;
    }
    clampSelection();

    if (currentRun()?.runId !== run) {
      state.resultIndex = 0;
      void loadTrace();
    }
  }

  function clampSelection(): void {
    state.runIndex = Math.min(state.runIndex, Math.max(0, visibleRuns().length - 1));
    state.resultIndex = Math.min(state.resultIndex, Math.max(0, visibleResults().length - 1));
    state.queueIndex = Math.min(state.queueIndex, Math.max(0, visibleQueue().length - 1));
  }

  let tail: Stoppable | undefined;
  /**
   * Sequence number for transcript loads.
   *
   * Coalescing these was wrong: a second caller would join the first load, which had already
   * captured the *previous* selection, so moving down the list mid-load left `index`, `indexKey`
   * and `alertFacts` describing the alert above the one now on screen — and `applyRuns` only
   * retries when there is no index at all, so it never corrected itself. Each load now carries a
   * token and abandons itself the moment a newer one starts.
   */
  let loadSeq = 0;

  async function loadTrace(): Promise<void> {
    const token = ++loadSeq;
    const stale = (): boolean => token !== loadSeq;

    const run = currentRun();
    const result = currentResult();
    tail?.stop();
    tail = undefined;
    if (run === undefined || result === undefined) {
      state.index = undefined;
      state.indexKey = undefined;
      // Clear the case facts and redraw. Leaving them meant the previous alert's facts stayed on
      // screen under a selection that no longer pointed at it — latent while every run had a
      // result to select, reachable the moment a selection can address no run at all (PRD-5 §16,
      // increment 0).
      state.alertFacts = undefined;
      render();
      return;
    }
    const key = `${run.runId}-${result.alertId}`;
    state.alertFacts = alertFactsFromResult(result);
    state.transcriptSelected = 0;
    state.expandedText = undefined;

    const path = await resolveTracePath(run.runId, result.alertId, run.traceDir, tracesDir);
    if (stale()) return;
    if (path === undefined) {
      state.index = undefined;
      state.indexKey = key;
      render();
      return;
    }
    const cached = state.indexes.get(key);
    const index = cached ?? (await indexTrace(path));
    if (stale()) return;
    state.indexes.set(key, index);
    state.index = index;
    state.indexKey = key;

    // The transcript carries the alert verbatim — description, entities, remediation — and is the
    // only source of it for runs written before the artifact recorded any (PRD-3 §6.1).
    if (index.alertMessage !== undefined && state.alertFacts !== undefined) {
      const alertJson = await readAlert(path, index.alertMessage);
      if (stale()) return;
      if (alertJson !== undefined) {
        state.alertFacts = enrichWithAlertJson(state.alertFacts, alertJson);
      }
    }
    render();

    // Follow it if the run may still be writing.
    if (stale()) return;
    if (run.status === "running" || !index.complete) {
      tail = pollTrace(
        path,
        (update) => {
          // Render on transitions only. The tail ticks twice a second, and redrawing every tick
          // would recompute the transcript and fight the analyst's scroll position for nothing.
          if (update.grew) {
            state.index = update.index;
            state.indexes.set(key, update.index);
            state.growing.add(run.runId);
            render();
            return;
          }
          // A transcript that has stopped growing is evidence the run may have died; leaving the
          // flag set would keep a dead sweep pinned as active forever (PRD-3 §10.2).
          if (state.growing.delete(run.runId)) render();
        },
        undefined,
        index,
      );
    }
  }

  /** Rows a pane has at the current terminal size; zero means it is not drawn (see `layout`). */
  function paneRows(pane: Focus): number {
    const geometry = layout(renderer.width, renderer.terminalHeight);
    if (pane === 1) return geometry.alertsHeight;
    if (pane === 2) return geometry.runsHeight;
    if (pane === 3) return geometry.caseHeight;
    return 1;
  }

  // ---- rendering ---------------------------------------------------------------------------
  function render(): void {
    if (closed) return;
    const width = renderer.width;
    const height = renderer.terminalHeight;

    /**
     * Too small to draw, in one of two directions.
     *
     * There was only ever a width guard, so a short terminal did not degrade — the sidebar
     * overflowed and drew its bottom border across the key bar. Both directions now say the same
     * thing the same way, and neither wears a `[4]` title: this is not pane four, and labelling it
     * so invited the reader to press `1` to leave it.
     */
    const small = tooSmall(width, height);
    if (small !== undefined) {
      header.content = "";
      keyBar.content = "";
      sidebar.visible = false;
      caseText.content = "";
      mainBox.visible = true;
      mainBox.title = "";
      tabBar.visible = false;
      tabBar.height = 0;
      composeBox.visible = false;
      mainText.content = styled(
        small === "narrow"
          ? [
              "",
              [{ text: `  Terminal too narrow — ${width} columns.`, tone: "heading", bold: true }],
              [{ text: `  The console needs at least ${MIN_WIDTH}.`, tone: "dim" }],
            ]
          : [
              "",
              [{ text: `  Terminal too short — ${height} rows.`, tone: "heading", bold: true }],
              [{ text: `  The console needs at least ${minHeightFor(width)}.`, tone: "dim" }],
            ],
      );
      return;
    }

    const geometry = layout(width, height);
    const { narrow, sidebarWidth } = geometry;

    sidebar.visible = true;
    mainBox.visible = true;
    content.flexDirection = narrow ? "column" : "row";
    sidebar.width = narrow ? "100%" : sidebarWidth;
    /**
     * Narrow mode has to state the sidebar's height or it takes every row.
     *
     * Stacked, the sidebar and pane [4] are siblings in one column; the sidebar's children summed
     * to the whole budget, and `mainBox`, on `flexGrow`, was allotted nothing. Between 60 and 99
     * columns the console therefore had no reading surface at all — no verdict, no transcript, no
     * stream — and pressing `4` did not bring one back, because there were no rows to give it.
     */
    sidebar.height = narrow ? geometry.sidebarHeight : "100%";
    sidebar.flexGrow = narrow ? 0 : 1;
    // Narrow drops [3] Case, not [1]. The case facts are recoverable at any width by focusing [4],
    // which renders the same thing through `alertLines`; the queue is not recoverable at all, and
    // hiding it would also remove the only route to `n` (PRD-5 §12.3).
    caseBox.visible = geometry.caseHeight > 0;
    alertsBox.visible = geometry.alertsHeight > 0;
    runsBox.visible = geometry.runsHeight > 0;

    // What is on screen is a queue of investigations, not a description of this machine. Provider,
    // model, tracing and spend all moved to the `c` screen, which already carried them (PRD-3 §8.5).
    header.content = styled([
      [
        { text: "SOC ANALYST CONSOLE", tone: "heading", bold: true },
        {
          text: `${" ".repeat(4)}${state.runs.length} run${state.runs.length === 1 ? "" : "s"}`,
          tone: "label",
        },
        {
          text: state.unreadable.length === 0 ? "" : ` · ${state.unreadable.length} unreadable`,
          tone: "inconclusive",
        },
        { text: control === undefined ? " · read-only" : " · active", tone: "dim" },
      ],
    ]);

    const caseFacts =
      state.mainSource === "queue"
        ? (() => {
            const selected = currentQueueAlert();
            return selected === undefined ? undefined : alertFactsFromAlert(selected.resource);
          })()
        : state.alertFacts;
    const caseLines: Line[] =
      caseFacts === undefined
        ? [[{ text: " no alert recorded", tone: "dim" }]]
        : alertLines(caseFacts, sidebarWidth - 3);
    caseText.content = styled(caseLines);
    caseBox.title = truncate(
      `[3] Case${caseFacts === undefined ? "" : ` — ${caseFacts.alertId.slice(0, 8)}`}`,
      sidebarWidth - 4,
    );

    const listWidth = (narrow ? width : sidebarWidth) - 2;
    const runs = visibleRuns();

    // Heights are assigned rather than negotiated, so the scroll maths below is exact and the
    // sidebar cannot reflow while someone is moving through it. `layout` guarantees the three
    // never sum past the rows there are, which is the guarantee the old arithmetic lacked.
    const { caseHeight, alertsHeight, runsHeight } = geometry;
    caseBox.height = caseHeight;
    alertsBox.height = alertsHeight;
    runsBox.height = runsHeight;

    const runRowsAll = runRows(runs, Date.now(), state.growing, state.runIndex, listWidth);
    state.runScroll = scrollOffset(state.runScroll, state.runIndex, runs.length, runsHeight - 2);
    runsText.content = styled(windowed(runRowsAll, state.runScroll, runsHeight - 2));
    // The pending count lives here now. It describes a *run*, and [1] no longer shows one — it
    // shows the alert corpus, which belongs to no run at all (PRD-5 §7).
    const pending = pendingLine(currentRun());
    runsBox.title = truncate(
      `[2] Runs${filterSuffix(2, state.runs.length, runs.length)}${pending === undefined ? "" : ` —${pending.trimEnd()}`}${state.unreadable.length > 0 ? ` (${state.unreadable.length} unreadable)` : ""}`,
      sidebarWidth - 4,
    );

    // Present at every size the terminal can hold it. Hiding it for single-alert runs made `1-4` a
    // lie on almost every run in the corpus and left ⏎ walking to a pane that was not there; the
    // only thing that removes it now is a terminal with no rows to give it, which `layout` decides
    // and `focusablePanes` reports back to anyone who presses `1`.
    const rows = visibleQueue();
    /**
     * The title says what the pane holds, which is every alert — not only the un-run ones.
     *
     * It read "Alerts — no run" and showed alerts with completed runs marked `✓`, which is a
     * contradiction on its face. The un-run *count* is the useful number, so it goes in the title
     * as a count; the dedupe caveat it cannot honestly be shown without lives in `?` (PRD-5 §7).
     */
    const scope = [
      state.groundTruthOnly ? "◆" : undefined,
      state.showCovered ? "all" : "outstanding",
    ]
      .filter((part) => part !== undefined)
      .join(" ");
    alertsBox.title = truncate(
      `[1] Alerts ${scope} (${rows.length}/${state.alerts.length})${filterSuffix(1, state.alerts.length, rows.length)}`,
      sidebarWidth - 4,
    );
    const queueRowsAll = queueLines(rows, state.queueIndex, listWidth);
    state.queueScroll = scrollOffset(
      state.queueScroll,
      state.queueIndex,
      rows.length,
      alertsHeight - 2,
    );
    alertsText.content = styled(
      // Wrapped across the pane, not clipped to its first row. The pane is 20 rows of empty space
      // when the queue cannot load, and the one line in it was being cut mid-sentence — `start it
      // with \`bun run dev…` — so the fix the message exists to give was the part that got lost.
      state.alertsError !== undefined
        ? wrap(state.alertsError, listWidth - 2).map((line): Line => [
            { text: `  ${line}`, tone: "failed" },
          ])
        : queueRowsAll.length === 0
          ? [[{ text: `  ${emptyQueueReason()}`, tone: "dim" }]]
          : windowed(queueRowsAll, state.queueScroll, alertsHeight - 2),
    );

    for (const [box, focus] of [
      [alertsBox, 1],
      [runsBox, 2],
      [caseBox, 3],
      [mainBox, 4],
    ] as const) {
      box.borderColor = state.focus === focus ? COLOR.borderFocused : COLOR.border;
    }

    const boxWidth = narrow ? width : width - sidebarWidth;
    const bodyWidth = Math.max(20, boxWidth - 4);
    mainText.content = styled(mainBody(bodyWidth));

    // Tabs are hidden while composing: `[` and `]` would cycle a strip behind a modal, and the
    // strip describes a run the overlay may have nothing to do with.
    const onTabs =
      state.screen === "dashboard" &&
      state.mode !== "compose" &&
      // While [4] holds an alert there are no tabs — `[`/`]` would cycle a strip belonging to a
      // run that is not on screen.
      state.mainSource !== "queue" &&
      currentResult() !== undefined;
    tabBar.visible = onTabs;
    tabBar.height = onTabs ? 2 : 0;
    if (onTabs) tabBar.content = styled(tabBarLines(bodyWidth));

    // Budgeted against the *box*, not its text area, and against the corners the border draws.
    // Using the body width let a long alert title run over the top-right corner.
    const titleRoom = Math.max(8, boxWidth - 6);
    mainBox.title = truncate(mainTitle(), titleRoom);

    /**
     * The overlay is sized to its content, so a short form is a short box.
     *
     * Height is set rather than left to flex because the box is absolutely positioned: without an
     * explicit height it collapses to nothing. Capped at the pane so a long model list scrolls the
     * window (`modelListLines`) instead of pushing the confirm strip out of the terminal.
     */
    const composing = state.mode === "compose" && state.compose !== undefined;
    composeBox.visible = composing;
    if (composing && state.compose !== undefined) {
      const overlayWidth = Math.max(20, boxWidth - 8);
      const lines = composeLines(state.compose, overlayWidth);
      composeText.content = styled(lines);
      composeBox.height = Math.min(Math.max(6, lines.length + 2), Math.max(6, renderer.height - 6));
      composeBox.title = truncate(composeTitle(state.compose), Math.max(8, overlayWidth - 4));
    }

    mainScroll.stickyScroll = state.tab === "stream" && state.follow;
    mainScroll.stickyStart = "bottom";

    /**
     * Three states, in priority order: a one-shot notice, then the durable status, then the keys.
     *
     * `notice` is cleared by the very next keypress, which is right for "nothing to copy" and
     * wrong for "the run you started failed" — hence `status`, which persists until something
     * replaces it. It was being set in five places and rendered in none, so every one of those
     * messages was silently discarded (PRD-5 §5.1).
     */
    keyBar.content = styled([
      state.filtering
        ? [
            { text: `  filtering ${state.filterTarget === 1 ? "alerts" : "runs"}`, tone: "accent" },
            { text: "   ↑↓ pick a match   ⏎ keep the filter   ⎋ clear it", tone: "dim" },
          ]
        : state.notice !== undefined
          ? [{ text: truncate(state.notice, width), tone: "accent", bold: true }]
          : state.status !== undefined && Date.now() < state.status.until
            ? [
                {
                  text: truncate(state.status.text, width),
                  tone: state.status.failed ? "failed" : "running",
                },
              ]
            : [{ text: keyBarText(width), tone: "dim" }],
    ]);
  }

  /**
   * What the filter is doing, on the title of the list it is doing it to.
   *
   * The match count travels with it: a filter that hides everything looks identical to an empty
   * directory otherwise, and this is the one control in the console that can make runs disappear.
   */
  function filterSuffix(target: 1 | 2, total: number, shown: number): string {
    if (state.filter === "" && !(state.filtering && state.filterTarget === target)) return "";
    if (state.filterTarget !== target) return "";
    const caret = state.filtering ? "\u2588" : "";
    return `  /${state.filter}${caret} ${shown}/${total}`;
  }

  function mainTitle(): string {
    if (state.screen === "config") return "[4] Configuration";
    if (state.screen === "help") return "[4] Keys";
    if (state.mainSource === "queue") {
      const selected = currentQueueAlert();
      return selected === undefined
        ? "[4] Alert"
        : `[4] ${selected.alertId.slice(0, 8)} ${selected.title}`;
    }
    const result = currentResult();
    if (result === undefined) return "[4]";
    return `[4] ${result.alertId.slice(0, 8)} ${result.alertTitle ?? ""}`;
  }

  /**
   * The tab strip.
   *
   * A row of its own rather than a suffix on the pane title: the title is a plain string, so the
   * active tab could only be marked with punctuation, and at the far right of a long alert title
   * that is not something anyone notices.
   */
  function tabBarLines(width: number): Line[] {
    const spans = TABS.flatMap((tab, at) => [
      ...(at === 0 ? [] : [{ text: "  ·  ", tone: "dim" as const }]),
      tab === state.tab
        ? { text: TAB_LABEL[tab].toUpperCase(), tone: "accent" as const, bold: true }
        : { text: TAB_LABEL[tab], tone: "dim" as const },
    ]);
    return [
      [{ text: "  " }, ...spans],
      // Stopped at the reading measure, like the section rules below it. Run to the pane's own edge
      // it was the one horizontal line on a wide terminal that did not share a right margin with
      // the others, which reads as an oversight rather than as a different kind of divider.
      [{ text: `  ${"─".repeat(Math.max(0, measure(width) - 2))}`, tone: "dim" }],
    ];
  }

  function mainBody(paneWidth: number): Line[] {
    let width = paneWidth;
    /**
     * Nothing is drawn under an open overlay, and that is what makes the overlay theme-neutral.
     *
     * The box paints no background of its own. Two absolute colours were tried — `#1c1c1c` to sit
     * "a shade off" the terminal, then `#000000` to "match" it — and both are guesses about a
     * background this process cannot read: against a tinted theme each landed as a rectangle in
     * the wrong colour. Painting nothing means the terminal's own background shows through the
     * box, whatever it is, and the `accent` border alone says the box is there.
     *
     * That only works if there is nothing underneath to read through it, hence blanking here. The
     * cost is the alert text that used to remain visible around the modal — already worth little
     * once the box grew to the pane's full width, and worth less than an overlay that looks native
     * in every terminal.
     */
    if (state.mode === "compose") return [];
    if (state.screen === "help") return helpLines(measure(width));
    /**
     * The queue's selection owns [4] (PRD-5 §7).
     *
     * A queue alert belongs to no run, so the verdict tabs describe something else entirely. What
     * the analyst needs before pressing `n` is the alert itself — what fired, against whom, when,
     * and what the vendor says to do about it. Rendered from the API payload through the same
     * `alertLines` the case pane uses, so it says what the alert says and nothing more.
     */
    if (state.screen === "dashboard" && state.mainSource === "queue") {
      // The alert view is the detection's own prose, so it takes the reading measure too.
      width = measure(width);
      const selected = currentQueueAlert();
      if (selected === undefined) {
        return [
          "",
          [{ text: "  No alert selected.", tone: "heading", bold: true }],
          "",
          ...(state.alertsError === undefined
            ? [[{ text: `  ${emptyQueueReason()}`, tone: "dim" as const }]]
            : prose(state.alertsError, width, "failed")),
          "",
          [
            {
              text: "  s  ground truth only     a  include alerts that already have a run",
              tone: "dim" as const,
            },
          ],
        ];
      }
      const facts = alertFactsFromAlert(selected.resource);
      const lines: Line[] = ["", [{ text: `  ${facts.title}`, tone: "heading", bold: true }], ""];

      // The detection's own words. `alertLines` leaves the description out because it is built for
      // the 43-column case pane, where prose breaks mid-token; here there is width for a sentence,
      // and it is the single most useful thing the API returns before an agent has run.
      if (facts.description !== undefined && facts.description.trim() !== "") {
        lines.push([{ text: "  WHY THE ALERT FIRED", tone: "heading", bold: true }]);
        lines.push(...wrap(facts.description, width - 4).map((line) => `  ${line}`));
        lines.push("");
      }

      lines.push(...alertLines(facts, width));
      lines.push(...remediationLines(facts, width));
      lines.push("", [
        {
          text:
            selected.scenarioId === undefined
              ? "  n starts an investigation on this alert."
              : "  n starts an investigation. ◆ ground truth exists for this alert.",
          tone: "dim",
        },
      ]);
      return lines;
    }
    if (state.screen === "config") {
      const run = currentRun();
      return configBody(
        run,
        env,
        state.aggregate,
        run === undefined ? undefined : runTotals(run, state.indexes),
        width,
      );
    }

    if (state.runs.length === 0) {
      const text = measure(width);
      return [
        "",
        [{ text: "  No runs yet.", tone: "heading", bold: true }],
        "",
        [{ text: "  Produce one with:", tone: "label" }],
        "    bun run investigate --alert <id>",
        "",
        [{ text: "  Turn on transcripts to see tool calls and cost:", tone: "label" }],
        "    INVESTIGATOR_TRACE=true bun run investigate",
        ...(state.unreadable.length === 0
          ? []
          : [
              "",
              [
                {
                  text: `  ${plural(state.unreadable.length, "path")} could not be read:`,
                  tone: "failed" as const,
                },
              ],
              // A path plus its errno is routinely 150 characters and was left to soft-wrap, so
              // the one screen that reports a broken file looked broken itself.
              ...state.unreadable.flatMap((u) =>
                wrap(`${u.path} — ${u.issue}`, Math.max(8, text - 4)).map((line) => `    ${line}`),
              ),
            ]),
      ];
    }

    const result = currentResult();
    if (result === undefined) {
      const run = currentRun();
      const line = pendingLine(run);
      return [
        "",
        `  Run ${run?.runId ?? ""} has no finished alerts yet.`,
        ...(line === undefined ? [] : [line]),
      ];
    }

    // Waiting on a transcript, rather than never having had one: the run says it is tracing and
    // this alert is the one being investigated right now.
    const traced = currentRun()?.traceDir !== undefined;
    const waiting = traced && isPending(result);
    const activeRun = currentRun();
    const queryLanguage = (call: ToolCall): string | undefined =>
      queryLanguageForCall(activeRun, call);

    // An in-flight investigation has no verdict — the agent submits one call at the end — so the
    // Verdict tab reports progress instead of an empty assessment (PRD-3 §13).
    // Prose width is `measure`'s decision and nothing else's — see the note there on why there is
    // no cap. Everything on this screen takes the pane it is given.
    if (state.tab === "verdict") {
      return isPending(result)
        ? progressBody(state.alertFacts, state.index, traced, measure(width), queryLanguage)
        : verdictBody(result, state.alertFacts, measure(width));
    }

    if (state.tab === "transcript") {
      if (state.index === undefined) return noTranscriptLines(waiting, measure(width));
      state.transcriptBlocks = toTranscript(state.index, width, queryLanguage);
      // A tailing transcript grows underneath the selection; clamp rather than let it point past
      // the end of the conversation.
      state.transcriptSelected = Math.min(
        state.transcriptSelected,
        Math.max(0, state.transcriptBlocks.length - 1),
      );
      return transcriptLines(
        state.transcriptBlocks,
        state.transcriptSelected,
        width,
        state.expandedText,
      );
    }

    if (state.index === undefined) return noTranscriptLines(waiting, measure(width));

    if (state.tab === "stream") return streamBody(state.index, width, queryLanguage);

    const rendered = activityBody(state.index, width, state.activitySelected, queryLanguage);
    state.activityRows = rendered.selectable;
    state.activitySelected = Math.min(
      state.activitySelected,
      Math.max(0, state.activityRows.length - 1),
    );
    if (!state.detailOpen) return rendered.lines;
    const row = rendered.selectable[state.activitySelected];
    return row === undefined ? rendered.lines : callDetail(row, width);
  }

  /**
   * Load the full text behind the selected transcript block.
   *
   * The index keeps a bounded preview and a byte range; this is the on-demand half of that bargain
   * (PRD-3 §10.1), so a 24,000-character query result costs nothing until someone asks for it.
   */
  async function loadExpanded(): Promise<void> {
    const block = state.transcriptBlocks[state.transcriptSelected];
    const path = state.index?.path;
    if (block?.source === undefined || path === undefined) return;

    if (block.kind === "result") {
      state.expandedText = await readToolResult(path, block.source);
      render();
      return;
    }

    const event = await readEvent(path, block.source);
    const message = (event as { message?: { content?: unknown } } | undefined)?.message;
    const parts = Array.isArray(message?.content) ? message.content : [];
    const wanted = block.kind === "reasoning" ? "thinking" : "text";
    const text = parts
      .map((part: unknown) => {
        const record = part as { type?: string; thinking?: string; text?: string };
        if (record.type !== wanted) return "";
        return (wanted === "thinking" ? record.thinking : record.text) ?? "";
      })
      .filter((value: string) => value !== "")
      .join("\n\n");

    state.expandedText = text === "" ? "(nothing recorded for this part)" : text;
    render();
  }

  // ---- driving the agent (PRD-5 §8) ----------------------------------------------------------
  const control = options.control;

  /**
   * Merge in-process runs with what is on disk.
   *
   * A run started here appears in `control.live()` immediately and in `runs/` a second later via
   * `pollRuns`. Keyed by runId so it renders once, not twice (PRD-5 §8).
   */
  function liveOnlyRuns(): RunArtifact[] {
    const onDisk = new Set(state.runs.map((run) => run.runId));
    return [...state.liveRuns.values()]
      .filter((live) => !onDisk.has(live.runId))
      .map((live) => ({
        runId: live.runId,
        startedAt: live.startedAt,
        completedAt: live.startedAt,
        status: "running",
        alertCount: 1,
        plannedAlerts: [
          {
            alertId: live.alertId,
            ...(live.alertTitle === undefined ? {} : { alertTitle: live.alertTitle }),
          },
        ],
        results: [],
      })) as RunArtifact[];
  }

  /**
   * Each action belongs to one subject, and refuses rather than retargeting.
   *
   * `n` acts on the queue's alert; `r` and `f` act on the selected run. None of them used to check,
   * so pressing the feedback key while reading an un-run alert in [1] recorded a verdict against
   * whatever run happened to be selected in [2] — filed silently against a different
   * investigation. Refusing with a message that names the right pane is the whole fix.
   */
  function openCompose(kind: ComposeKind): void {
    const wantsRun = kind !== "start";

    if (wantsRun && state.mainSource !== "run") {
      state.notice =
        kind === "rerun"
          ? " r re-runs an investigation — select one in [2] first"
          : " f records your feedback on an investigation — select one in [2] first";
      render();
      return;
    }
    if (!wantsRun && state.mainSource !== "queue") {
      state.notice = " n starts an investigation on an alert — select one in [1], or r to re-run";
      render();
      return;
    }

    const alert = kind === "start" ? currentQueueAlert() : undefined;
    const result = kind === "start" ? undefined : currentResult();

    // Feedback is a judgement on a finished investigation. On one still running there is nothing
    // yet to agree or disagree with, and `agentAssessment` would freeze an empty verdict.
    if (kind === "feedback" && result !== undefined && isPending(result)) {
      state.notice = " this investigation is still running — no verdict to record yet";
      render();
      return;
    }

    const alertId = alert?.alertId ?? result?.alertId;
    const alertTitle = alert?.title ?? result?.alertTitle ?? "(unnamed alert)";
    if (alertId === undefined) {
      state.notice =
        kind === "start" ? " no alert selected in [1]" : " no investigation selected in [2]";
      render();
      return;
    }
    if (control === undefined) {
      state.notice = " this console was opened read-only — no control was supplied";
      render();
      return;
    }
    /**
     * The picker opens on the model this console is configured for, not on the first offered one.
     *
     * Defaulting to the head of the list meant confirming without touching the field silently
     * switched provider — and against one with no credential, the run failed before it started.
     * Re-running "the same alert, same configuration" is half of what this flow is for; it has to
     * actually default to that. Falling back to the first offer keeps the field non-empty when the
     * configured model is not among the curated set.
     */
    const configured =
      state.models.find(
        (model) =>
          model.provider === env.INVESTIGATOR_PROVIDER && model.id === env.INVESTIGATOR_MODEL,
      ) ?? state.models[0];

    // Re-running defaults to the model that produced the run being re-run, not to the console's
    // env — "same alert, one thing changed" is only true if the thing you did not change is held.
    const previous = kind === "rerun" ? currentRun()?.model : undefined;
    const seed =
      previous === undefined
        ? configured
        : (state.models.find(
            (model) => model.provider === previous.provider && model.id === previous.id,
          ) ?? configured);

    state.mode = "compose";
    state.compose = {
      kind,
      alertId,
      alertTitle,
      field: -1,
      context: "",
      ...(seed === undefined ? {} : { model: seed }),
      modelFilter: "",
      modelOffset: 0,
      /**
       * Feedback opens on what the run concluded, not on the first of four.
       *
       * It was hard-coded to index 0 — `TruePositive` — whatever the run had said, so opening `f`
       * on an investigation the agent called a false positive and pressing Save without touching
       * the row recorded that the analyst thought it was a true positive. On the one form whose
       * job is capturing disagreement, the default was an opinion nobody had expressed.
       *
       * Opening on the agent's own verdict makes agreeing one keypress and disagreeing a
       * deliberate one, which is the right way round. An inconclusive or unscored run opens on
       * `Undetermined`: a run that reached no conclusion cannot pre-fill one.
       */
      classificationIndex: Math.max(
        0,
        CLASSIFICATIONS.indexOf(
          classificationForBand(
            verdictBand(currentResult()?.summary?.tpPercent),
          ) as (typeof CLASSIFICATIONS)[number],
        ),
      ),
      comment: "",
      confirm: false,
    };
    render();
  }

  /**
   * The models on offer right now, narrowed by whatever has been typed on the model row.
   *
   * Matched over `provider/id` so "openai" and "5.6" both work, and so a filter that matches
   * nothing returns nothing rather than silently falling back to the full list — an operator who
   * typed a name that does not exist needs to see that, not to be handed a different model.
   */
  function filteredModels(compose: ComposeState): ModelChoice[] {
    const needle = compose.modelFilter.trim().toLowerCase();
    if (needle === "") return state.models;
    return state.models.filter((model) =>
      `${model.provider}/${model.id}`.toLowerCase().includes(needle),
    );
  }

  /** Where the cursor sits in the filtered list. The chosen model *is* the cursor (see `model`). */
  function modelCursor(compose: ComposeState): number {
    const list = filteredModels(compose);
    const at = list.findIndex(
      (model) => model.provider === compose.model?.provider && model.id === compose.model.id,
    );
    return at === -1 ? 0 : at;
  }

  /**
   * Fields, then the confirm strip, as one ring.
   *
   * `-1` is the strip and sorts last, so `↓` off the final field lands on Confirm/Cancel and `↑`
   * off the first field reaches it from the other side. One ring rather than a clamp, because a
   * traversal that silently stops is indistinguishable from a dropped keypress.
   */
  function moveComposeField(compose: ComposeState, delta: number): void {
    const count = fieldCount(compose.kind);
    const at = compose.field === -1 ? count : compose.field;
    const next = (at + delta + (count + 1)) % (count + 1);
    compose.field = next === count ? -1 : next;
    // Entering the model row: put the window where the cursor already is, so the list opens
    // showing the selected model rather than scrolled to the top with the selection off-screen.
    if (compose.field === modelField(compose.kind)) {
      compose.modelOffset = scrollOffset(
        compose.modelOffset,
        modelCursor(compose),
        filteredModels(compose).length,
        MODEL_LIST_HEIGHT,
      );
    }
    render();
  }

  /**
   * Printable keys and backspace, routed to whichever text the focused row owns.
   *
   * The model row's text is its *filter*, not a value — so typing there narrows the list, and the
   * selection follows the narrowing rather than being left pointing at a row no longer on offer.
   * Without that follow, filtering to a single entry and confirming would run whatever was chosen
   * before the filter was typed.
   */
  function editComposeText(compose: ComposeState, edit: (text: string) => string): void {
    if (compose.kind === "feedback") {
      if (compose.field === 1) compose.comment = edit(compose.comment);
      render();
      return;
    }
    if (compose.field === 0) {
      compose.context = edit(compose.context);
      render();
      return;
    }
    if (compose.field === modelField(compose.kind)) {
      compose.modelFilter = edit(compose.modelFilter);
      const list = filteredModels(compose);
      const stillOffered = list.some(
        (model) => model.provider === compose.model?.provider && model.id === compose.model.id,
      );
      if (!stillOffered && list[0] !== undefined) compose.model = list[0];
      compose.modelOffset = scrollOffset(
        compose.modelOffset,
        modelCursor(compose),
        list.length,
        MODEL_LIST_HEIGHT,
      );
    }
    render();
  }

  /**
   * The only place compose is left (PRD-5 §12.5).
   *
   * `state.mode` is authoritative and is cleared here, never inferred from renderer focus — the
   * library's `set visible` blurs only the renderable it is called on, so a focus-derived guard
   * survives the overlay being hidden and eats every subsequent key.
   */
  function closeCompose(): void {
    state.mode = "browse";
    state.compose = undefined;
    render();
  }

  function confirmCompose(): void {
    const compose = state.compose;
    if (compose === undefined || control === undefined) return closeCompose();
    if (!compose.confirm) return closeCompose();

    if (compose.kind === "feedback") {
      void recordFeedback(compose);
      return;
    }

    const runId = Bun.randomUUIDv7();
    const chosen = compose.model;
    const context = compose.context.trim();
    const parentRunId = currentRun()?.runId;

    control.start({
      runId,
      alertId: compose.alertId,
      alertTitle: compose.alertTitle,
      ...(chosen === undefined ? {} : { model: chosen }),
      ...(context === "" ? {} : { analystContext: context }),
      ...(compose.kind === "rerun" && parentRunId !== undefined
        ? { derivedFrom: { runId: parentRunId, alertId: compose.alertId } }
        : {}),
    });

    // Take the control's live view immediately rather than waiting for `run_started` to arrive.
    // The console just asked for this run synchronously; making it visible depend on an event it
    // does not control means a control implementation that forgets to emit renders nothing, and
    // the analyst cannot then select, cancel or re-run the run they just started.
    for (const live of control.live()) state.liveRuns.set(live.runId, live);

    // Select the new run when it appears rather than letting the analyst's row shift under them.
    state.pendingRunId = runId;
    state.mainSource = "run";
    setStatus(` started ${runId.slice(0, 8)} on ${truncate(compose.alertTitle, 48)}`);
    closeCompose();
  }

  async function recordFeedback(compose: ComposeState): Promise<void> {
    const { writeFeedback } = await import("../drive/feedback.ts");
    const run = currentRun();
    const result = currentResult();
    if (run === undefined || result === undefined) return closeCompose();
    try {
      const path = await writeFeedback(env.FEEDBACK_DIR, {
        schemaVersion: 1,
        runId: run.runId,
        alertId: result.alertId,
        at: new Date().toISOString(),
        classification: CLASSIFICATIONS[compose.classificationIndex] ?? "Undetermined",
        ...(compose.comment.trim() === "" ? {} : { comment: compose.comment.trim() }),
        agentAssessment: {
          ...(result.summary?.tpPercent === undefined
            ? {}
            : { tpPercent: result.summary.tpPercent }),
          ...(run.model?.id === undefined ? {} : { model: run.model.id }),
        },
      });
      setStatus(` recorded — ${path}`);
    } catch (error) {
      setStatus(
        ` could not record: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    closeCompose();
  }

  /** Informational messages fade; failures linger, because they are the ones easy to miss. */
  const STATUS_MS = 8_000;
  const STATUS_FAILED_MS = 45_000;

  function setStatus(text: string, failed = false): void {
    state.status = {
      text,
      failed,
      until: Date.now() + (failed ? STATUS_FAILED_MS : STATUS_MS),
    };
  }

  /**
   * Cancel, but only something that is actually running.
   *
   * This checked that a run was *selected* and never that it was live, so `x` on an investigation
   * that finished a fortnight ago called `control.cancel` and reported " cancelling 01a01960…".
   * Nothing was cancelled. `x cancel` is on the key bar from every screen, so it is easy to press
   * by accident, and an operator interface claiming an action it did not take is the one failure
   * that costs it trust in everything else it says.
   *
   * The run list already decides liveness for its own glyph; this asks the same question of the
   * same function rather than inventing a second answer.
   */
  function cancelSelectedRun(): void {
    const run = currentRun();
    if (control === undefined || run === undefined) {
      state.notice = " nothing to cancel — select a running investigation in [2]";
      render();
      return;
    }

    const liveness = classifyRun({
      run,
      now: Date.now(),
      ...(state.growing.has(run.runId) ? { traceGrowing: true } : {}),
    });
    if (liveness !== "running" && liveness !== "stale") {
      // Naming the state is the point: "nothing to cancel" alone reads as a console that did not
      // understand the keypress rather than as a run that is already over.
      state.notice = ` ${run.runId.slice(0, 8)} is ${RUN_STATE_WORD[liveness]} — nothing to cancel`;
      render();
      return;
    }

    control.cancel(run.runId);
    setStatus(` cancelling ${run.runId.slice(0, 8)}…`);
    render();
  }

  // ---- input -------------------------------------------------------------------------------
  function moveSelection(delta: number): void {
    // Config and help take over pane [4] entirely, so j/k belong to what is on screen. Without
    // this they moved the run selection behind the overlay, and leaving it reselected a different
    // investigation than the one the analyst had been looking at.
    if (state.screen !== "dashboard") {
      mainScroll.scrollBy(delta * 2);
      render();
      return;
    }

    if (state.focus === 2) {
      const next = Math.min(
        Math.max(0, visibleRuns().length - 1),
        Math.max(0, state.runIndex + delta),
      );
      if (next === state.runIndex) return;
      state.runIndex = next;
      state.resultIndex = 0;
      state.detailOpen = false;
      state.mainSource = "run";
      caseScroll.scrollTo(0);
      void loadTrace();
    } else if (state.focus === 1) {
      // The queue addresses alerts that belong to no run, so there is no transcript to load. Calling
      // `loadTrace()` here would throw away the transcript of whatever run is selected in [2], or
      // leave [4] showing a stale investigation while [1] points somewhere else (PRD-5 §7).
      const count = visibleQueue().length;
      const next = Math.min(Math.max(0, state.queueIndex + delta), Math.max(0, count - 1));
      if (next === state.queueIndex) return;
      state.queueIndex = next;
      state.mainSource = "queue";
      caseScroll.scrollTo(0);
    } else if (state.focus === 3) {
      caseScroll.scrollBy(delta * 2);
    } else if (state.focus === 4) {
      if (state.tab === "transcript") {
        state.transcriptSelected = Math.min(
          Math.max(0, state.transcriptSelected + delta),
          Math.max(0, state.transcriptBlocks.length - 1),
        );
        state.expandedText = undefined;
      } else if (state.tab === "activity" && !state.detailOpen) {
        state.activitySelected = Math.min(
          Math.max(0, state.activitySelected + delta),
          Math.max(0, state.activityRows.length - 1),
        );
      } else {
        mainScroll.scrollBy(delta * 2);
      }
    }
    render();
  }

  const onKey = (key: KeyEvent): void => {
    const name = key.name;
    state.notice = undefined;

    if (key.ctrl && name === "c") {
      key.stopPropagation();
      shutdown(0);
      return;
    }

    /**
     * Compose owns every key while it is open, and `⎋` always leaves in one press.
     *
     * Checked on `state.mode`, never on renderer focus — the whole point of §12.5. `⎋` is handled
     * before any field so there is no state in which the overlay cannot be dismissed.
     */
    if (state.mode === "compose") {
      key.stopPropagation();
      const compose = state.compose;
      if (compose === undefined) {
        closeCompose();
        return;
      }
      if (name === "escape") {
        closeCompose();
        return;
      }
      /**
       * `⏎` acts on the focused row; only the confirm strip's `⏎` confirms.
       *
       * It used to call `confirmCompose()` from anywhere, and `confirm` defaults to Cancel — so
       * pressing it while typing context fell straight through to `closeCompose()` and discarded
       * everything typed, with no prompt and no way back. Advancing instead means no keystroke
       * inside the overlay can destroy work, which is worth the deviation from §12.4's flat
       * "⏎ confirms".
       */
      if (name === "return") {
        if (compose.field === -1) confirmCompose();
        else moveComposeField(compose, 1);
        return;
      }
      const traversal = composeTraversalKey(key);
      if (traversal !== undefined) {
        moveComposeField(compose, traversal === "shift+tab" ? -1 : 1);
        return;
      }
      /**
       * `↑`/`↓` walk the whole overlay, entering and leaving the model list on the way.
       *
       * The model row is a list whenever it has focus, so vertical movement has to mean two things
       * without a mode: inside the list it moves the cursor, and at either end it hands focus to
       * the next row. Anything else would need an explicit expand key, which is one more thing to
       * discover in the overlay whose whole defect was undiscoverable keys.
       */
      if (name === "up" || name === "down") {
        const delta = name === "down" ? 1 : -1;
        if (compose.field === modelField(compose.kind)) {
          const list = filteredModels(compose);
          const next = modelCursor(compose) + delta;
          if (next < 0 || next >= list.length) moveComposeField(compose, delta);
          else {
            const picked = list[next];
            if (picked !== undefined) compose.model = picked;
            compose.modelOffset = scrollOffset(
              compose.modelOffset,
              next,
              list.length,
              MODEL_LIST_HEIGHT,
            );
            render();
          }
        } else moveComposeField(compose, delta);
        return;
      }
      // `←`/`→` belong to the confirm strip and to the four-way verdict, which are the only two
      // horizontal choices. The model row deliberately does not answer to them: one mechanism for
      // choosing a model, not two that can disagree about which is selected.
      if (name === "left" || name === "right") {
        if (compose.field === -1) compose.confirm = name === "right";
        else if (compose.kind === "feedback" && compose.field === 0) {
          compose.classificationIndex =
            (compose.classificationIndex + (name === "right" ? 1 : CLASSIFICATIONS.length - 1)) %
            CLASSIFICATIONS.length;
        }
        render();
        return;
      }
      if (name === "backspace") {
        editComposeText(compose, (text) => text.slice(0, -1));
        return;
      }
      if (key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
        editComposeText(compose, (text) => text + key.sequence);
      }
      return;
    }

    // The filter is the console's only text input, so while it is open it takes every printable
    // key — including `q`, which would otherwise quit halfway through typing "query" (PRD-3 §9.7).
    if (state.filtering) {
      key.stopPropagation();
      /**
       * Move through the matches without closing the input.
       *
       * There was no way to. `↑`/`↓` fell through every branch and did nothing at all, and `j`/`k`
       * are printable, so reaching for them appended them to the query — `/multiple` became
       * `/multiplej` and the match count dropped to zero. The only route to a result was `⏎` and
       * then `j`, which nothing on screen said, and `⎋` — the other key a reader reaches for when
       * they have finished typing — throws the query away rather than keeping it.
       *
       * `Ctrl-N`/`Ctrl-P` do the same thing, for anyone whose hands expect a readline.
       */
      const step =
        name === "down" || (key.ctrl && name === "n")
          ? 1
          : name === "up" || (key.ctrl && name === "p")
            ? -1
            : 0;
      if (step !== 0) {
        moveSelection(step);
        render();
        return;
      }

      withAnchoredSelection(() => {
        if (name === "escape") {
          state.filter = "";
          state.filtering = false;
        } else if (name === "return") {
          state.filtering = false;
        } else if (name === "backspace") {
          state.filter = state.filter.slice(0, -1);
        } else if (key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
          state.filter += key.sequence;
        }
      });
      render();
      return;
    }

    if (name === "q") {
      key.stopPropagation();
      shutdown(0);
      return;
    }

    if (name === "/") {
      key.stopPropagation();
      // Filtering pane [4] or the case pane means nothing, so `/` there filters the run list —
      // which is what someone reaching for it almost always wants.
      state.filterTarget = state.focus === 1 ? 1 : 2;
      state.focus = state.filterTarget;
      state.screen = "dashboard";
      state.filter = "";
      state.filtering = true;
      focusPane();
      render();
      return;
    }

    if (name === "y") {
      key.stopPropagation();
      void copyFocused();
      return;
    }

    // Panel-level keys are consumed here so they never reach a focused list (PRD-3 §9.7).
    if (["1", "2", "3", "4"].includes(name)) {
      key.stopPropagation();
      const wanted = Number(name) as Focus;
      /**
       * A pane that is not on screen does not take focus silently.
       *
       * `[3] Case` is dropped when the panes stack and `[1] Alerts` when the terminal is too short
       * to hold it, so `1-4 pane` on the key bar is not true at every size. Focus used to move to
       * the missing pane anyway: the keys went somewhere invisible and the console looked frozen.
       */
      const room = paneRows(wanted);
      if (room === 0) {
        state.notice =
          wanted === 3
            ? " [3] Case is hidden at this width — its facts are in [4]"
            : ` [${wanted}] is hidden — the terminal is too short for it`;
        render();
        return;
      }
      state.focus = wanted;
      // Only the two list panes change what [4] is detailing. `3` and `4` move focus so their pane
      // can be scrolled, and leave the subject alone.
      if (name === "1") {
        state.mainSource = "queue";
        caseScroll.scrollTo(0);
      }
      if (name === "2") {
        state.mainSource = "run";
        caseScroll.scrollTo(0);
      }
      state.screen = "dashboard";
      focusPane();
      render();
      return;
    }

    switch (name) {
      case "j":
      case "down":
        key.stopPropagation();
        moveSelection(1);
        return;
      case "k":
      case "up":
        key.stopPropagation();
        moveSelection(-1);
        return;
      // `G` reaches us as `g` with `shift` set, so a separate `case "G"` was unreachable and both
      // keys jumped to the top — leaving no way at all to reach the end of a 44-run list or a
      // 154-alert queue, while `?` advertised "first / last".
      case "g":
        key.stopPropagation();
        moveSelection(key.shift ? 1_000_000 : -1_000_000);
        return;
      // `[` and `]` rather than ⇥. Tab is the terminal's own focus key and reads as "move focus",
      // which is what 1-4 do here; brackets read as "the next one of these", which is what this is.
      case "[":
      case "]":
        key.stopPropagation();
        state.screen = "dashboard";
        state.tab =
          TABS[(TABS.indexOf(state.tab) + (name === "[" ? TABS.length - 1 : 1)) % TABS.length] ??
          "verdict";
        state.detailOpen = false;
        mainScroll.scrollTo(0);
        render();
        return;
      case "c":
        key.stopPropagation();
        state.screen = state.screen === "config" ? "dashboard" : "config";
        render();
        return;
      case "?":
        key.stopPropagation();
        state.screen = state.screen === "help" ? "dashboard" : "help";
        render();
        return;
      case "F":
        key.stopPropagation();
        state.follow = !state.follow;
        render();
        return;
      /**
       * `R` re-reads from disk; `r` re-runs.
       *
       * `r` meant refresh through PRD-3 and PRD-5, and §12.1 forbids rebinding a key an analyst
       * already uses. It is rebound anyway, deliberately: re-running is the action reached often
       * enough to deserve the unshifted key, and both pollers already re-read on their own, so a
       * manual refresh is a rare convenience. What makes the swap safe is not the spacing but the
       * confirm strip — a stray `r` opens an overlay sitting on Cancel and spends nothing.
       */
      case "R":
        key.stopPropagation();
        if (state.focus === 1) void loadAlerts();
        else void refresh();
        return;
      case "a":
        key.stopPropagation();
        state.showCovered = !state.showCovered;
        state.queueIndex = 0;
        state.queueScroll = 0;
        render();
        return;
      case "s":
        // Filter the queue to alerts that have ground truth behind them — the fourteen worth
        // running twice, which is the loop this whole PRD exists to make possible (PRD-5 §7).
        key.stopPropagation();
        state.groundTruthOnly = !state.groundTruthOnly;
        state.queueIndex = 0;
        state.queueScroll = 0;
        render();
        return;
      case "n":
        key.stopPropagation();
        openCompose("start");
        return;
      case "r":
        key.stopPropagation();
        openCompose("rerun");
        return;
      /**
       * `f`, which §10 ruled out for sitting one shift-key from `F` (follow).
       *
       * That objection does not survive `r`/`R` above: the same adjacency now exists on the key
       * that spends money, and holding the rule here while breaking it there would be incoherent.
       * The property that actually makes the keymap safe is that every consequential action sits
       * behind a strip defaulting to Cancel — `f` for `F` opens a modal that writes nothing, `F`
       * for `f` toggles a view. Neither loses anything. `f` also matches what it writes:
       * `feedback/`, holding an `AnalystFeedback`.
       */
      case "f":
        key.stopPropagation();
        openCompose("feedback");
        return;
      case "x":
        // Cancel. Deliberately not `c`, which is already the configuration screen — rebinding a key
        // an analyst already uses is not a thing this PRD gets to do quietly (PRD-5 §12.1).
        key.stopPropagation();
        cancelSelectedRun();
        return;
      case "return":
        key.stopPropagation();
        // Only expansion. Walking panes with ⏎ was confusing — the number keys already do that,
        // and 1-4 is unambiguous in a way "inwards" is not. What is left is the one thing with no
        // other route: the arguments behind a call, and the full text behind a transcript block.
        if (state.tab === "activity") state.detailOpen = true;
        else if (state.tab === "transcript") void loadExpanded();
        render();
        return;
      case "escape":
        key.stopPropagation();
        if (state.expandedText !== undefined) state.expandedText = undefined;
        else if (state.detailOpen) state.detailOpen = false;
        else if (state.screen !== "dashboard") state.screen = "dashboard";
        else if (state.filter !== "") {
          withAnchoredSelection(() => {
            state.filter = "";
          });
        } else state.focus = 2;
        focusPane();
        render();
        return;
      default:
        break;
    }
  };

  /**
   * Focus is now purely our own state.
   *
   * The lists were `SelectRenderable`s that held real widget focus, and keeping that in step with
   * `state.focus` needed care — blurring one and not the other left two panes drawing a selection.
   * Drawing the rows ourselves removes the second source of truth entirely.
   */
  function focusPane(): void {
    render();
  }

  /**
   * Copy the focused pane.
   *
   * OSC 52 rather than a host clipboard binary, so this works over SSH — which is where a console
   * like this actually runs. On an open call detail it copies the arguments alone, because the
   * thing worth pasting there is the source query: "queries used, for reproducibility" is a required field
   * in an escalation write-up, and retyping a query out of a terminal is how it gets omitted.
   */
  async function copyFocused(): Promise<void> {
    const width = Math.max(
      20,
      renderer.width - layout(renderer.width, renderer.terminalHeight).sidebarWidth - 4,
    );
    let text: string;
    let what: string;

    if (state.focus === 3) {
      text = state.alertFacts === undefined ? "" : linesText(alertLines(state.alertFacts, 120));
      what = "case facts";
    } else if (state.focus === 1 || state.focus === 2) {
      // [1] is the queue, so `y` there copies the queue. It copied the selected run's alerts,
      // which is the pane [1] stopped being at PRD-5 §7.
      text =
        state.focus === 2
          ? linesText(runRows(visibleRuns(), Date.now(), state.growing, -1, 120))
          : linesText(queueLines(visibleQueue(), -1, 118));
      what = state.focus === 2 ? "run list" : "alert queue";
    } else if (state.detailOpen && state.tab === "activity") {
      const row = state.activityRows[state.activitySelected];
      text = row === undefined ? "" : callArgsText(row);
      what = row?.kind === "call" && row.toolName === "query_security_data" ? "query" : "arguments";
    } else {
      text = linesText(mainBody(width));
      what = state.screen === "dashboard" ? state.tab : state.screen;
    }

    if (text.trim() === "") {
      state.notice = " nothing to copy from this pane";
      render();
      return;
    }

    const copied = renderer.copyToClipboardOSC52(text);
    state.notice = copied
      ? ` copied ${what} — ${text.length} characters`
      : ` this terminal refused the copy (OSC 52 unsupported)`;
    render();
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  function stop(): void {
    if (closed) return;
    closed = true;
    tail?.stop();
    runsPoll.stop();
    unsubscribeControl?.();
    // In-process runs cannot outlive the console, so quitting cancels them rather than pretending
    // otherwise. Spawn would survive; this deliberately does not (PRD-5 §5.1).
    control?.shutdown();
  }

  function shutdown(code: number): void {
    stop();
    if (owned) renderer.destroy();
    exit(code);
  }

  /**
   * The keys that work on the row that has focus, rather than every key the overlay knows.
   *
   * The overlay's original defect was a hint naming `⇥` in a placeholder that disappeared as soon
   * as anything was typed, so the one route to the model field was invisible exactly when it was
   * needed. This line is unconditional and changes with focus.
   */
  function composeHint(compose: ComposeState): string {
    if (compose.field === -1) return "← → choose   ⏎ act   ↑ ⇥ fields   ⎋ close";
    if (compose.field === modelField(compose.kind))
      return "↑ ↓ move   type to filter   ⏎ accept   ⎋ close";
    if (compose.kind === "feedback" && compose.field === 0)
      return "← → choose   ↑ ↓ ⇥ move   ⏎ accept   ⎋ close";
    return "type to fill   ↑ ↓ ⇥ move   ⏎ accept   ⎋ close";
  }

  /**
   * The model list, windowed, shown only while the model row has focus.
   *
   * Focus *is* the expansion: there is no separate key to open it, because the overlay's whole
   * problem was keys nobody could find. Collapsing it when focus leaves keeps the confirm strip on
   * screen in a short terminal, which matters more than seeing the catalogue while typing context.
   */
  function modelListLines(compose: ComposeState): Line[] {
    const list = filteredModels(compose);
    if (list.length === 0) {
      return [
        [
          { text: "              " },
          {
            text:
              state.models.length === 0
                ? "no provider credential configured"
                : `nothing matches "${compose.modelFilter.trim()}"`,
            tone: "failed",
          },
        ],
      ];
    }

    const cursor = modelCursor(compose);
    const offset = scrollOffset(compose.modelOffset, cursor, list.length, MODEL_LIST_HEIGHT);
    const rows: Line[] = list.map((model, at) => [
      { text: "              " },
      { text: at === cursor ? "▸ " : "  ", tone: "accent" as const },
      {
        text: `${model.provider}/${model.id}`,
        ...(at === cursor ? { bg: "selected" as const } : { tone: "dim" as const }),
      },
    ]);

    const shown = windowed(rows, offset, MODEL_LIST_HEIGHT);
    const more = list.length > MODEL_LIST_HEIGHT || compose.modelFilter.trim() !== "";
    return more
      ? [
          ...shown,
          [
            { text: "              " },
            {
              text: `  ${cursor + 1} of ${list.length}${
                compose.modelFilter.trim() === "" ? "" : ` matching "${compose.modelFilter.trim()}"`
              }`,
              tone: "dim" as const,
            },
          ],
        ]
      : shown;
  }

  /**
   * The compose overlay's contents. The box it floats in is built once, up with the panes.
   *
   * `Screen` stays `dashboard | config | help` — this is a mode, not a screen (§12.4).
   */
  function composeLines(compose: ComposeState, width: number): Line[] {
    const lines: Line[] = [];
    lines.push("");
    lines.push([
      { text: "  alert  ", tone: "label" },
      { text: truncate(compose.alertTitle, Math.max(10, width - 12)) },
    ]);
    lines.push([
      { text: "  id     ", tone: "label" },
      { text: compose.alertId, tone: "dim" },
    ]);

    /**
     * `start` and `rerun` are the same spend, so they carry the same warnings.
     *
     * This block was gated on `start` alone. A re-run makes an identical provider call and showed
     * none of it — no tool list, no "this calls a paid provider", no duplicate-entity warning —
     * so the action an analyst presses repeatedly was the quiet one and the action they press once
     * was the loud one. If anything the warning belongs more on `r`.
     */
    if (compose.kind === "start" || compose.kind === "rerun") {
      /**
       * Whether the chosen model can actually run, checked against the startup credential probe.
       *
       * Confirming a paid action against a model there is no key for, and learning about it from a
       * failed artifact, is the failure this exists to prevent (PRD-5 §9).
       */
      const runnable = !state.modelsLoaded || state.models.length > 0;
      /**
       * What the agent will be able to do, not where its data lives.
       *
       * This row was the Sentinel URL (§8). An operator about to spend money cannot act on
       * `http://localhost:8787` — and the `c` screen already carries it, alongside the Brave key —
       * whereas the capability surface is what decides whether the run can answer the question.
       * Named by the harness through `listTools()` so a sixth tool appears here without an edit.
       */
      const tools = control?.listTools() ?? [];
      for (const [at, line] of wrap(tools.join(" · "), Math.max(20, width - 12)).entries()) {
        lines.push([
          { text: at === 0 ? "  tools  " : "         ", tone: "label" },
          { text: line, tone: "dim" },
        ]);
      }
      // Web research degrades silently: the tools stay registered and simply stop finding
      // anything, which is indistinguishable from "the web had nothing" in the transcript.
      if (env.BRAVE_API_KEY === undefined) {
        lines.push([
          { text: "         " },
          { text: "web research is unconfigured — BRAVE_API_KEY is not set", tone: "inconclusive" },
        ]);
      }
      lines.push(
        "",
        runnable
          ? [{ text: "  This calls a paid provider.", tone: "inconclusive" }]
          : [
              {
                text: "  No provider credential configured — this run would fail.",
                tone: "failed",
              },
            ],
      );

      const selected = state.alerts.find((alert) => alert.alertId === compose.alertId);
      const duplicates =
        selected === undefined ? undefined : duplicateSpend(selected, state.alerts, allRuns());
      if (duplicates !== undefined) {
        lines.push([
          { text: "  warning ", tone: "label" },
          {
            text:
              `${duplicates.otherAlerts} other alert${duplicates.otherAlerts === 1 ? "" : "s"} ` +
              `${duplicates.otherAlerts === 1 ? "shares" : "share"} this entity within ±1s; ` +
              `${duplicates.withRun} already ` +
              `${duplicates.withRun === 1 ? "has" : "have"} a run.`,
            tone: "inconclusive",
          },
        ]);
      }
    }

    if (compose.kind === "start" || compose.kind === "rerun") {
      const chosen = compose.model;
      const focusedOnModel = compose.field === modelField(compose.kind);
      lines.push(
        "",
        [
          fieldMark(compose, 0),
          // Padded to the longer of the two labels so the values line up in one column. "context"
          // alone read as though it were the alert's context rather than something you add.
          { text: "additional context  ", tone: "label" },
          {
            text: compose.context === "" ? "(optional)" : compose.context,
            tone: compose.context === "" ? "dim" : undefined,
          },
        ],
        [
          fieldMark(compose, 1),
          { text: "model               ", tone: "label" },
          chosen === undefined
            ? {
                text: "no provider credential configured — this run would fail",
                tone: "failed",
              }
            : { text: `${chosen.provider}/${chosen.id}` },
          {
            text:
              chosen === undefined || focusedOnModel ? "" : `   (${state.models.length} offered)`,
            tone: "dim",
          },
          // What was typed, in the same `/needle█` shape the pane filters already use. Without it
          // the narrowing is visible but its cause is not, which is the hidden-`⇥` defect again.
          {
            text:
              focusedOnModel && compose.modelFilter !== ""
                ? `   /${compose.modelFilter}\u2588`
                : "",
            tone: "accent",
          },
        ],
      );
      if (focusedOnModel) lines.push(...modelListLines(compose));
      /**
       * A first run carrying context is not a baseline, and the operator should learn that here.
       *
       * `evaluate` skips any run with `analystContext` (AC18) and coverage marks the alert `✓·`
       * (§4.5), so steering the *first* investigation of an alert leaves it looking investigated
       * with nothing scoreable behind it. Cheap to say now; invisible later.
       */
      if (compose.kind === "start" && compose.context.trim() !== "") {
        lines.push("", [
          { text: "  ⚠ ", tone: "inconclusive" },
          {
            text: "Not a baseline: evaluate will skip this run, and [1] will mark it ✓·",
            tone: "inconclusive",
          },
        ]);
      }
    }

    if (compose.kind === "feedback") {
      /**
       * What the agent concluded, on the row where you agree or disagree with it.
       *
       * The form asks whether the agent got it right and did not say what the agent had said, so
       * the fact the whole judgement turns on was one keypress behind the analyst. It is also what
       * makes the pre-filled verdict legible: a default that mirrors the run only reads as a
       * default if the run's own answer is on screen beside it.
       */
      const agent = verdictBand(currentResult()?.summary?.tpPercent);

      // A run with no verdict did not *say* anything, so it is reported as silence rather than as
      // a fifth opinion called "unscored".
      const said =
        agent === "unknown"
          ? "this run recorded no verdict"
          : `agent said ${bandLabel(agent).toLowerCase()}`;
      const chosen = classificationLabel(
        CLASSIFICATIONS[compose.classificationIndex] ?? "Undetermined",
      );
      // Beside the choice if there is room, under it if there is not. As one unbreakable row it
      // soft-wrapped to column 0 and ran beneath the overlay's own border on a narrow terminal.
      const inline = `    verdict  ${chosen}   ← →      ${said}`.length <= width;

      lines.push(
        "",
        [
          fieldMark(compose, 0),
          { text: "verdict  ", tone: "label" },
          { text: chosen },
          { text: "   ← →", tone: "dim" },
          ...(inline ? [{ text: `      ${said}`, tone: bandTone(agent) }] : []),
        ],
        ...(inline
          ? []
          : [[{ text: `${" ".repeat(COMMENT_GUTTER)}${said}`, tone: bandTone(agent) }] as Line]),
        [
          fieldMark(compose, 1),
          { text: "comment  ", tone: "label" },
          {
            text:
              compose.comment === "" ? "(what the agent should know next time)" : compose.comment,
            tone: compose.comment === "" ? "dim" : undefined,
          },
        ],
        /**
         * What the record is for, as the comment field's own description.
         *
         * It was two free-standing lines under the form — one saying what feedback is for, one
         * saying where the file lands and what it does not spend — which read as a footnote about
         * the console rather than as help with the field being filled in. Hung under `comment` at
         * the value column it is what it always was: the answer to "why am I typing this".
         *
         * The register is the analyst's: what they write shapes what the agent does with the next
         * alert of this kind, which is the reason to spend thirty seconds on it.
         */
        ...wrap(
          "Feeds future investigations of alerts like this one.",
          Math.max(20, width - COMMENT_GUTTER - 2),
        ).map((line): Line => [{ text: `${" ".repeat(COMMENT_GUTTER)}${line}`, tone: "dim" }]),
      );
    }

    // The strip marks its choice only while it holds focus. Painting a highlighted `Cancel` at all
    // times put a second thing on screen that looked focused, next to the row that actually was.
    const onStrip = compose.field === -1;
    lines.push("", [
      fieldMark(compose, -1),
      {
        text: "  Cancel  ",
        ...(onStrip && !compose.confirm ? { bg: "selected" as const } : { tone: "dim" as const }),
      },
      { text: "  " },
      {
        text: `  ${confirmVerb(compose.kind)}  `,
        ...(onStrip && compose.confirm ? { bg: "selected" as const } : { tone: "dim" as const }),
      },
    ]);
    lines.push("", [{ text: `  ${composeHint(compose)}`, tone: "dim" }]);
    return lines;
  }

  async function loadModels(): Promise<void> {
    if (control === undefined) return;
    try {
      state.models = await control.listModels();
    } catch {
      state.models = [];
    }
    state.modelsLoaded = true;
    render();
  }

  async function loadAlerts(): Promise<void> {
    if (control === undefined) return;
    const snapshot = await readAlerts(
      {
        listAlerts: () => control.listAlerts(),
        getAlert: () => Promise.reject(new Error("unused")),
      },
      env.BENCHMARK_MAP_PATH,
      env.SENTINEL_CONNECTOR,
    );
    state.alerts = snapshot.alerts;
    if (snapshot.error === undefined) delete state.alertsError;
    else state.alertsError = snapshot.error;
    clampSelection();
    render();
  }

  async function refresh(): Promise<void> {
    const { readRuns } = await import("../data/runs.ts");
    applyRuns(await readRuns(runsDir));
  }

  function applyRuns(snapshot: { runs: RunArtifact[]; unreadable: UnreadableRun[] }): void {
    const previous = currentRun()?.runId;
    if (options.fresh === true && !freshBaselineCaptured) {
      for (const run of snapshot.runs) hiddenRunIds.add(run.runId);
      for (const unreadable of snapshot.unreadable) hiddenUnreadablePaths.add(unreadable.path);
      freshBaselineCaptured = true;
    }
    state.runs = snapshot.runs.filter((run) => !hiddenRunIds.has(run.runId));
    state.unreadable = snapshot.unreadable.filter(
      (unreadable) => !hiddenUnreadablePaths.has(unreadable.path),
    );
    if (state.pendingRunId !== undefined) {
      // One-shot. `applyRuns` preserves selection by runId on every poll, so without this a run the
      // analyst just started appears without being selected and shifts their row down (PRD-5 §8).
      const at = visibleRuns().findIndex((run) => run.runId === state.pendingRunId);
      if (at !== -1) {
        state.runIndex = at;
        state.focus = 2;
        delete state.pendingRunId;
        state.resultIndex = 0;
        void loadTrace();
      }
    } else if (previous !== undefined) {
      /**
       * Re-find the selection in the list it is an index into, which is the *visible* one.
       *
       * `state.runIndex` addresses `visibleRuns()` — filtered, and with in-process runs prepended.
       * This looked the run back up in `state.runs`, the unfiltered on-disk list, and wrote that
       * position back. So every poll tick, once a second, the selection moved to whatever run
       * happened to sit at the same offset in the other list: with a filter open the selection
       * walked the corpus a row a second, and with a sweep running it was off by the number of
       * live runs. That is what made the filter look like it did nothing — the row it selected was
       * being overwritten a second later.
       *
       * A run that has dropped out of view keeps the index rather than resetting to the top: it is
       * usually a filter keystroke mid-word, and jumping to row zero on each character is the same
       * bug in a smaller form.
       */
      const at = visibleRuns().findIndex((run) => run.runId === previous);
      if (at !== -1) state.runIndex = at;
    }
    clampSelection();
    // Retry while there is still no transcript. During a live sweep the artifact is flushed
    // before the next alert's transcript exists, so a single attempt at selection time would
    // never find one (PRD-3 §10.2). Costs one existence check per poll.
    if (state.index === undefined) void loadTrace();
    render();
  }

  const runsPoll = pollRuns(runsDir, applyRuns);

  /**
   * Follow in-process runs (PRD-5 §5.3).
   *
   * The console never touches Pi's event type — `ControlEvent` is the investigator's own
   * vocabulary, mapped at the boundary, which is what keeps `harness.ts` the only Pi importer.
   */
  const unsubscribeControl = control?.subscribe((event) => {
    if (closed) return;
    switch (event.type) {
      case "run_started":
      case "turn":
      case "tool_call":
      case "assistant_text": {
        for (const live of control.live()) state.liveRuns.set(live.runId, live);
        break;
      }
      case "run_completed": {
        state.liveRuns.delete(event.runId);
        void refresh();
        break;
      }
      case "run_cancelled": {
        state.liveRuns.delete(event.runId);
        setStatus(` cancelled ${event.runId.slice(0, 8)}`);
        void refresh();
        break;
      }
      case "run_failed": {
        state.liveRuns.delete(event.runId);
        // Durable, not a `notice`: the next keypress clears those, and a failed start is the one
        // thing an analyst must not miss (PRD-5 §5.1).
        setStatus(` run ${event.runId.slice(0, 8)} failed — ${event.error.message}`, true);
        void refresh();
        break;
      }
      default:
        break;
    }
    render();
  });

  renderer.keyInput.prependListener("keypress", onKey);
  renderer.on("resize", render);
  renderer.once("destroy", () => renderer.keyInput.off("keypress", onKey));

  // The terminal must come back on every path, including a crash (PRD-3 §9.9).
  if (owned) {
    process.on("SIGINT", () => shutdown(130));
    process.on("SIGTERM", () => shutdown(143));
    const crash = (error: unknown): void => {
      stop();
      renderer.destroy();
      console.error(error);
      process.exit(1);
    };
    process.on("unhandledRejection", (error: unknown) => {
      if (control?.containUnhandledRejection?.(error) === true) return;
      crash(error);
    });
    process.on("uncaughtException", crash);
  }

  const { readRuns } = await import("../data/runs.ts");
  applyRuns(await readRuns(runsDir));
  // Once, not on a timer: the corpus only changes on `bun run data:bootstrap` (PRD-5 §7).
  void loadAlerts();
  void loadModels();
  const ready = loadTrace().then(() => {
    focusPane();
    render();
    return undefined;
  });

  // Aggregates need every transcript, so they fill in behind the UI (PRD-3 §10).
  void indexAll(state.runs, tracesDir, (indexes, done, total) => {
    if (closed) return;
    for (const index of indexes) state.indexes.set(`${index.runId}-${index.alertId}`, index);
    state.aggregate = { ...aggregate(indexes, total), complete: done >= total };
    render();
  });

  return { stop, ready };
}
