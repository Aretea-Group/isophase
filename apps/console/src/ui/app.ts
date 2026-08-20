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
import { indexTrace, type TraceIndex } from "../data/trace-index.ts";
import type { ConsoleEnv } from "../env.ts";
import type { ActivityRow } from "../view/activity.ts";
import {
  alertFactsFromAlert,
  alertFactsFromResult,
  alertLines,
  enrichWithAlertJson,
  remediationLines,
  type AlertFacts,
} from "../view/alert.ts";
import { duplicateSpend, queueRows } from "../view/coverage.ts";
import { bandLabel, linesText, truncate, verdictBand, wrap, type Line } from "../view/format.ts";
import { isPending, resultsWithPending } from "../view/run-list.ts";
import { toTranscript, transcriptLines, type TranscriptBlock } from "../view/transcript.ts";
import {
  pendingLine,
  queueLines,
  resultRows,
  runRows,
  scrollOffset,
  windowed,
} from "./panes/lists.ts";
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
const SIDEBAR_WIDTH = 46;
/**
 * Sidebar geometry.
 *
 * The case pane is a **fixed** height. Sizing it to its contents looked tidier and was wrong: every
 * alert has a different amount to say, so moving down the run list resized pane [1], which resized
 * pane [2] underneath it, and the list appeared to jump under the analyst's own keypress. A pane
 * that changes size while you are navigating past it is worse than one with a blank row in it.
 */
const CASE_MAX_HEIGHT = 20;
const CASE_MIN_HEIGHT = 8;
/** The four classifications, in the order the overlay cycles them (PRD-5 §10). */
const CLASSIFICATIONS = [
  "TruePositive",
  "BenignPositive",
  "FalsePositive",
  "Undetermined",
] as const;

/**
 * How many fields each overlay has, so Tab cycles without falling off the end.
 *
 * Tab traversal is ours: OpenTUI 0.5.4 ships no `focusNext`, `focusPrevious` or `tabIndex` at all
 * (PRD-5 §12.5), so this is the single place that knows the shape of each form.
 */
function fieldCount(kind: ComposeKind): number {
  switch (kind) {
    // Start takes the same inputs as extend — a premise and a model. Offering them only on a
    // re-run meant the first investigation of an alert could not be steered or re-pointed without
    // running it once with the defaults first, which is a strange thing to make someone do.
    case "start":
      return 2;
    case "extend":
      return 2;
    case "classification":
      return 2;
  }
}

/** Public contract for the two terminal inputs that perform compose traversal. */
export const COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS = ["tab", "shift+tab"] as const;

function composeTraversalKey(
  key: KeyEvent,
): (typeof COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS)[number] | undefined {
  if (key.name !== "tab") return undefined;
  return key.shift ? "shift+tab" : "tab";
}

const QUEUE_MAX_HEIGHT = 18;
const QUEUE_MIN_HEIGHT = 6;
const RUNS_MIN_HEIGHT = 6;
/** Below this the two columns collapse; below `MIN_WIDTH` nothing is drawn (PRD-3 §9.6). */
const NARROW_WIDTH = 100;
const MIN_WIDTH = 60;

/**
 * Why the transcript tabs have nothing to show.
 *
 * Two different absences, and telling an analyst the wrong one is worse than saying nothing: a
 * traced run that has only just started has no transcript *yet*, and reporting that as "tracing
 * was off" describes a configuration the run does not have (PRD-3 §11).
 */
function noTranscriptLines(waiting: boolean): string[] {
  if (waiting) {
    return [
      "",
      "  Waiting for this investigation's transcript.",
      "",
      "  Tracing is on for this run, so the file appears as soon as the agent",
      "  writes its first event; this pane picks it up within a second and",
      "  follows it from there.",
    ];
  }
  return [
    "",
    "  No transcript for this investigation.",
    "",
    "  Tracing was off when this run happened (INVESTIGATOR_TRACE=false),",
    "  so its tool calls, reasoning, KQL and token usage were never written down.",
    "",
    "  Future runs record them with:",
    "    INVESTIGATOR_TRACE=true bun run investigate",
  ];
}

function helpLines(): string[] {
  return [
    "",
    "  1 2 3 4     focus Alerts, Runs, Case, Main",
    "  j k ↓ ↑     move within the focused panel",
    "  g G         first / last",
    "  ⏎           expand the selected call, or load a transcript block in full",
    "  ⎋           back, or clear the filter",
    "  [ ]         previous / next tab — Verdict · Agent stream · Activity · Transcript",
    "  /           filter the focused list",
    "  y           copy the focused pane — on a call, the exact KQL",
    "  s           queue: only alerts with ground truth",
    "  a           queue: also show alerts that already have a run",
    "",
    "  In [1] Alerts, the left glyph is what has been tried against it:",
    "    (blank)  nothing yet          ●  a run has it now",
    "    ✓        investigated         ✗  every run against it failed",
    "    ✓·       only ever run with analyst context supplied",
    "  ◆ marks an alert with ground truth behind it — the id is deliberately not shown,",
    "  because most scenario names give the verdict away.",
    "  Counts do not fold duplicates: 107 of the 151 alerts are two vendor views of 54",
    "  events, so the outstanding-work number overstates by roughly fifty.",
    "",
    "  n           queue: start an investigation on the selection",
    "  e           runs: re-run with analyst context and a chosen model",
    "  d           runs: record a classification",
    "  x           runs: cancel a running investigation",
    "  c           configuration and cost",
    "  F           Agent stream: toggle follow",
    "  r           re-read from disk now",
    "  ?           this help",
    "  q  Ctrl-C   quit",
    "",
    "  IMPACT is the agent's own field, submitted alongside TP/FP:",
    "    none                  attempted, and achieved nothing",
    "    contained             succeeded, then was stopped or reverted",
    "    confirmed-compromise  achieved something that matters",
    "    unknown               the available telemetry cannot say",
    "  A brute force where every attempt failed is a true positive, impact 'none'.",
    "",
    "  The investigator is the sole writer of runs/. Classifications go to feedback/.",
  ];
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

const KEY_BAR =
  " 1-4 pane   j/k move   n start   x cancel   e extend   d classify   / filter   ? help   q quit";

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

type ComposeKind = "start" | "extend" | "classification";

interface ComposeState {
  kind: ComposeKind;
  alertId: string;
  alertTitle: string;
  /** Which field has focus. -1 is the confirm strip, which is where every overlay opens. */
  field: number;
  premise: string;
  modelIndex: number;
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
  const keyBar = new TextRenderable(renderer, {
    id: "keybar",
    height: 1,
    fg: COLOR.dim,
    content: KEY_BAR,
  });
  screen.add(header);
  screen.add(content);
  screen.add(keyBar);

  const sidebar = new BoxRenderable(renderer, {
    id: "sidebar",
    width: SIDEBAR_WIDTH,
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
    minHeight: RUNS_MIN_HEIGHT,
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

  function visibleResults(): RunResult[] {
    const results = allResults();
    if (state.filter === "" || state.filterTarget !== 1) return results;
    const needle = state.filter.toLowerCase();
    return results.filter((result) => resultHaystack(result).includes(needle));
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
      return control === undefined ? "no control — opened read-only" : "press r to load alerts";
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

  // ---- rendering ---------------------------------------------------------------------------
  function render(): void {
    if (closed) return;
    const width = renderer.width;
    const narrow = width < NARROW_WIDTH;

    if (width < MIN_WIDTH) {
      header.content = "";
      keyBar.content = "";
      sidebar.visible = false;
      mainBox.visible = false;
      caseText.content = "";
      mainText.content = `\n  Terminal too narrow — ${width} columns.\n  The console needs at least ${MIN_WIDTH}.\n`;
      mainBox.visible = true;
      return;
    }

    sidebar.visible = true;
    mainBox.visible = true;
    content.flexDirection = narrow ? "column" : "row";
    sidebar.width = narrow ? "100%" : SIDEBAR_WIDTH;
    // Narrow drops [3] Case, not [1]. The case facts are recoverable at any width by focusing [4],
    // which renders the same thing through `alertLines`; the queue is not recoverable at all, and
    // hiding it would also remove the only route to `n` (PRD-5 §12.3).
    caseBox.visible = !narrow;

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
        { text: control === undefined ? " · read-only" : " · can start runs", tone: "dim" },
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
        : alertLines(caseFacts, SIDEBAR_WIDTH - 3);
    caseText.content = styled(caseLines);
    caseBox.title = truncate(
      `[3] Case${caseFacts === undefined ? "" : ` — ${caseFacts.alertId.slice(0, 8)}`}`,
      SIDEBAR_WIDTH - 4,
    );

    const listWidth = (narrow ? width : SIDEBAR_WIDTH) - 2;
    const runs = visibleRuns();

    // Heights are assigned rather than negotiated, so the scroll maths below is exact and the
    // sidebar cannot reflow while someone is moving through it.
    const sidebarRows = Math.max(0, renderer.terminalHeight - 2);
    // A share of the terminal, not of the alert. This changes only when the window is resized, so
    // the run list underneath stays put while an analyst moves through it.
    const caseHeight = Math.min(
      CASE_MAX_HEIGHT,
      Math.max(CASE_MIN_HEIGHT, Math.floor(sidebarRows * 0.3)),
    );
    // A fixed share, not content-sized. The queue is 150 rows where the old pane was one, and a
    // pane that resizes while you navigate past it moves the list under your own keypress
    // (PRD-5 §12.2).
    const alertsHeight = Math.min(
      QUEUE_MAX_HEIGHT,
      Math.max(QUEUE_MIN_HEIGHT, Math.floor(sidebarRows * (narrow ? 0.5 : 0.35))),
    );
    // The runs pane takes what is left and never less than its floor — it is the pane that must
    // keep working when the terminal is short, since it is how a run is reached at all.
    const runsHeight = Math.max(
      RUNS_MIN_HEIGHT,
      sidebarRows - (narrow ? 0 : caseHeight) - alertsHeight,
    );
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
      SIDEBAR_WIDTH - 4,
    );

    // A one-row list wastes the pane, and pane [1] now carries the alert's facts in every case —
    // so the list only earns its place when there is more than one alert, or when a sweep is still
    // running and the pending count is the only progress indicator (PRD-3 §8.1, §11).
    // Always present. Hiding it for single-alert runs made `1-4` a lie on almost every run in the
    // corpus and left ⏎ walking to a pane that was not there.
    alertsBox.visible = true;
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
      SIDEBAR_WIDTH - 4,
    );
    const queueRowsAll = queueLines(rows, state.queueIndex, listWidth);
    state.queueScroll = scrollOffset(
      state.queueScroll,
      state.queueIndex,
      rows.length,
      alertsHeight - 2,
    );
    alertsText.content = styled(
      state.alertsError !== undefined
        ? [[{ text: `  ${truncate(state.alertsError, listWidth - 2)}`, tone: "failed" }]]
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

    const boxWidth = narrow ? width : width - SIDEBAR_WIDTH;
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
      state.notice !== undefined
        ? [{ text: truncate(state.notice, width), tone: "accent", bold: true }]
        : state.status !== undefined && Date.now() < state.status.until
          ? [
              {
                text: truncate(state.status.text, width),
                tone: state.status.failed ? "failed" : "running",
              },
            ]
          : [{ text: truncate(KEY_BAR, width), tone: "dim" }],
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
    // Compose owns the pane while it is open. Leaving the selected run's title above a modal reads
    // as though the overlay belongs to that run, which for `n` on a queue alert it does not.
    if (state.mode === "compose" && state.compose !== undefined) {
      const kind = state.compose.kind;
      return kind === "start"
        ? "[4] Start an investigation"
        : kind === "extend"
          ? "[4] Re-run with analyst context"
          : "[4] Record a classification";
    }
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
      [{ text: "  " + "─".repeat(Math.max(0, width - 2)), tone: "dim" }],
    ];
  }

  function mainBody(width: number): Line[] {
    // Compose outranks every screen: it is modal, and the analyst is mid-action.
    if (state.mode === "compose" && state.compose !== undefined) {
      return composeLines(state.compose, width);
    }
    if (state.screen === "help") return helpLines();
    /**
     * The queue's selection owns [4] (PRD-5 §7).
     *
     * A queue alert belongs to no run, so the verdict tabs describe something else entirely. What
     * the analyst needs before pressing `n` is the alert itself — what fired, against whom, when,
     * and what the vendor says to do about it. Rendered from the API payload through the same
     * `alertLines` the case pane uses, so it says what the alert says and nothing more.
     */
    if (state.screen === "dashboard" && state.mainSource === "queue") {
      const selected = currentQueueAlert();
      if (selected === undefined) {
        return [
          "",
          [{ text: "  No alert selected.", tone: "heading", bold: true }],
          "",
          state.alertsError === undefined
            ? [{ text: `  ${emptyQueueReason()}`, tone: "dim" as const }]
            : [{ text: `  ${state.alertsError}`, tone: "failed" as const }],
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
      return [
        "",
        "  No runs yet.",
        "",
        "  Produce one with:",
        "    bun run investigate --alert <id>",
        "",
        "  Turn on transcripts to see tool calls and cost:",
        "    INVESTIGATOR_TRACE=true bun run investigate",
        ...(state.unreadable.length === 0
          ? []
          : [
              "",
              `  ${state.unreadable.length} path(s) could not be read:`,
              ...state.unreadable.map((u) => `    ${u.path} — ${u.issue}`),
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

    // An in-flight investigation has no verdict — the agent submits one call at the end — so the
    // Verdict tab reports progress instead of an empty assessment (PRD-3 §13).
    if (state.tab === "verdict") {
      return isPending(result)
        ? progressBody(state.alertFacts, state.index, traced, width)
        : verdictBody(result, state.alertFacts, width);
    }

    if (state.tab === "transcript") {
      if (state.index === undefined) return noTranscriptLines(waiting);
      state.transcriptBlocks = toTranscript(state.index, width);
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

    if (state.index === undefined) return noTranscriptLines(waiting);

    if (state.tab === "stream") return streamBody(state.index, width);

    const rendered = activityBody(state.index, width, state.activitySelected);
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
   * `n` acts on the queue's alert; `e` and `d` act on the selected run. None of them used to check,
   * so pressing `d` while reading an un-run alert in [1] recorded a classification against whatever
   * run happened to be selected in [2] — a verdict silently filed against a different
   * investigation. Refusing with a message that names the right pane is the whole fix.
   */
  function openCompose(kind: ComposeKind): void {
    const wantsRun = kind !== "start";

    if (wantsRun && state.mainSource !== "run") {
      state.notice =
        kind === "extend"
          ? " e re-runs an investigation — select one in [2] first"
          : " d records your verdict on an investigation — select one in [2] first";
      render();
      return;
    }
    if (!wantsRun && state.mainSource !== "queue") {
      state.notice = " n starts an investigation on an alert — select one in [1], or e to re-run";
      render();
      return;
    }

    const alert = kind === "start" ? currentQueueAlert() : undefined;
    const result = kind === "start" ? undefined : currentResult();

    // A classification is a judgement on a finished investigation. On one still running there is
    // nothing yet to agree or disagree with, and `agentAssessment` would freeze an empty verdict.
    if (kind === "classification" && result !== undefined && isPending(result)) {
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
     * The picker opens on the model this console is configured for, not on index 0.
     *
     * `listModels()` returns every registered provider's catalogue sorted alphabetically, so index
     * 0 is an Anthropic model regardless of configuration. Defaulting there meant pressing `e` and
     * confirming silently switched provider — and against a provider with no credential
     * configured, the run failed before it started. Re-running "the same alert, same
     * configuration" is half of what this flow is for; it has to actually default to that.
     */
    const configured = state.models.findIndex(
      (model) =>
        model.provider === env.INVESTIGATOR_PROVIDER && model.id === env.INVESTIGATOR_MODEL,
    );

    state.mode = "compose";
    state.compose = {
      kind,
      alertId,
      alertTitle,
      field: -1,
      premise: "",
      modelIndex: configured === -1 ? 0 : configured,
      classificationIndex: 0,
      comment: "",
      confirm: false,
    };
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

    if (compose.kind === "classification") {
      void recordClassification(compose);
      return;
    }

    const runId = Bun.randomUUIDv7();
    const chosen = state.models[compose.modelIndex];
    const premise = compose.premise.trim();
    const parentRunId = currentRun()?.runId;

    control.start({
      runId,
      alertId: compose.alertId,
      alertTitle: compose.alertTitle,
      ...(chosen === undefined ? {} : { model: chosen }),
      ...(premise === "" ? {} : { analystContext: premise }),
      ...(compose.kind === "extend" && parentRunId !== undefined
        ? { derivedFrom: { runId: parentRunId, alertId: compose.alertId } }
        : {}),
    });

    // Take the control's live view immediately rather than waiting for `run_started` to arrive.
    // The console just asked for this run synchronously; making it visible depend on an event it
    // does not control means a control implementation that forgets to emit renders nothing, and
    // the analyst cannot then select, cancel or extend the run they just started.
    for (const live of control.live()) state.liveRuns.set(live.runId, live);

    // Select the new run when it appears rather than letting the analyst's row shift under them.
    state.pendingRunId = runId;
    state.mainSource = "run";
    setStatus(` started ${runId.slice(0, 8)} on ${truncate(compose.alertTitle, 48)}`);
    closeCompose();
  }

  async function recordClassification(compose: ComposeState): Promise<void> {
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

  function cancelSelectedRun(): void {
    const run = currentRun();
    if (control === undefined || run === undefined) {
      state.notice = " nothing to cancel";
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
      if (name === "return") {
        confirmCompose();
        return;
      }
      const traversal = composeTraversalKey(key);
      if (traversal !== undefined) {
        const count = fieldCount(compose.kind);
        compose.field =
          traversal === "shift+tab"
            ? compose.field <= -1
              ? count - 1
              : compose.field - 1
            : compose.field >= count - 1
              ? -1
              : compose.field + 1;
        render();
        return;
      }
      if (name === "left" || name === "right") {
        if (compose.field === -1) compose.confirm = name === "right";
        else if (compose.kind !== "classification" && compose.field === 1) {
          const total = state.models.length;
          if (total === 0) return;
          compose.modelIndex =
            (compose.modelIndex + (name === "right" ? 1 : total - 1)) % Math.max(1, total);
        } else if (compose.kind === "classification" && compose.field === 0) {
          compose.classificationIndex =
            (compose.classificationIndex + (name === "right" ? 1 : CLASSIFICATIONS.length - 1)) %
            CLASSIFICATIONS.length;
        }
        render();
        return;
      }
      if (name === "backspace") {
        if (compose.kind !== "classification" && compose.field === 0) {
          compose.premise = compose.premise.slice(0, -1);
        } else if (compose.kind === "classification" && compose.field === 1) {
          compose.comment = compose.comment.slice(0, -1);
        }
        render();
        return;
      }
      if (key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
        if (compose.kind !== "classification" && compose.field === 0)
          compose.premise += key.sequence;
        else if (compose.kind === "classification" && compose.field === 1) {
          compose.comment += key.sequence;
        }
        render();
      }
      return;
    }

    // The filter is the console's only text input, so while it is open it takes every printable
    // key — including `q`, which would otherwise quit halfway through typing "query" (PRD-3 §9.7).
    if (state.filtering) {
      key.stopPropagation();
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
      clampSelection();
      void loadTrace();
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
      state.focus = Number(name) as Focus;
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
      case "g":
        key.stopPropagation();
        moveSelection(-1_000_000);
        return;
      case "G":
        key.stopPropagation();
        moveSelection(1_000_000);
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
      case "r":
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
      case "e":
        key.stopPropagation();
        openCompose("extend");
        return;
      case "d":
        key.stopPropagation();
        openCompose("classification");
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
          state.filter = "";
          clampSelection();
          void loadTrace();
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
   * thing worth pasting there is the KQL: "queries used, for reproducibility" is a required field
   * in an escalation write-up, and retyping a query out of a terminal is how it gets omitted.
   */
  async function copyFocused(): Promise<void> {
    const width = Math.max(20, renderer.width - SIDEBAR_WIDTH - 4);
    let text: string;
    let what: string;

    if (state.focus === 3) {
      text = state.alertFacts === undefined ? "" : linesText(alertLines(state.alertFacts, 120));
      what = "case facts";
    } else if (state.focus === 1 || state.focus === 2) {
      text =
        state.focus === 2
          ? linesText(runRows(visibleRuns(), Date.now(), state.growing, -1, 120))
          : linesText(resultRows(visibleResults(), -1, 120));
      what = state.focus === 2 ? "run list" : "alert list";
    } else if (state.detailOpen && state.tab === "activity") {
      const row = state.activityRows[state.activitySelected];
      text = row === undefined ? "" : callArgsText(row);
      what = row?.kind === "call" && row.toolName === "query_security_data" ? "KQL" : "arguments";
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
   * The compose overlay, drawn into the main pane rather than as a floating Box.
   *
   * `Screen` stays `dashboard | config | help` — this is a mode, not a screen, and drawing it here
   * means it inherits the pane's width and the existing scroll handling for free.
   */
  function composeLines(compose: ComposeState, width: number): Line[] {
    const lines: Line[] = [];
    lines.push("");
    lines.push([
      { text: "  alert  ", tone: "label" },
      { text: truncate(compose.alertTitle, width - 12) },
    ]);
    lines.push([
      { text: "  id     ", tone: "label" },
      { text: compose.alertId, tone: "dim" },
    ]);

    if (compose.kind === "start") {
      /**
       * Whether the chosen model can actually run, checked against the startup credential probe.
       *
       * Confirming a paid action against a model there is no key for, and learning about it from a
       * failed artifact, is the failure this exists to prevent (PRD-5 §9).
       */
      const runnable = !state.modelsLoaded || state.models.length > 0;
      lines.push(
        [{ text: "  data   ", tone: "label" }, { text: env.SENTINEL_BASE_URL }],
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

    if (compose.kind === "start" || compose.kind === "extend") {
      const chosen = state.models[compose.modelIndex];
      lines.push(
        "",
        [
          { text: compose.field === 0 ? "  ▶ " : "    ", tone: "accent" },
          { text: "premise  ", tone: "label" },
          {
            text: compose.premise === "" ? "(type; ⇥ switches field)" : compose.premise,
            tone: compose.premise === "" ? "dim" : undefined,
          },
        ],
        [
          { text: compose.field === 1 ? "  ▶ " : "    ", tone: "accent" },
          { text: "model    ", tone: "label" },
          chosen === undefined
            ? {
                text: "no provider credential configured — this run would fail",
                tone: "failed",
              }
            : { text: `${chosen.provider}/${chosen.id}` },
          {
            text: chosen === undefined ? "" : `   ← →  (${state.models.length} available)`,
            tone: "dim",
          },
        ],
        "",
        [
          {
            text: "  A premise is context to work with, never a verdict. It is recorded on the run.",
            tone: "dim",
          },
        ],
      );
    }

    if (compose.kind === "classification") {
      lines.push(
        "",
        [
          { text: compose.field === 0 ? "  ▶ " : "    ", tone: "accent" },
          { text: "verdict  ", tone: "label" },
          { text: CLASSIFICATIONS[compose.classificationIndex] ?? "Undetermined" },
          { text: "   ← →", tone: "dim" },
        ],
        [
          { text: compose.field === 1 ? "  ▶ " : "    ", tone: "accent" },
          { text: "comment  ", tone: "label" },
          {
            text: compose.comment === "" ? "(type; ⇥ switches field)" : compose.comment,
            tone: compose.comment === "" ? "dim" : undefined,
          },
        ],
      );
    }

    lines.push("", [
      { text: compose.field === -1 ? "  ▶ " : "    ", tone: "accent" },
      { text: "  Cancel  ", ...(compose.confirm ? {} : { bg: "selected" as const }) },
      { text: "  " },
      { text: "  Confirm  ", ...(compose.confirm ? { bg: "selected" as const } : {}) },
      { text: "   ← →  ⏎ act  ⎋ close", tone: "dim" },
    ]);
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
      const at = state.runs.findIndex((run) => run.runId === previous);
      state.runIndex = at === -1 ? 0 : at;
    }
    state.runIndex = Math.min(state.runIndex, Math.max(0, state.runs.length - 1));
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
