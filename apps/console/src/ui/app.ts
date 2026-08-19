import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import { pollRuns, pollTrace, type Stoppable } from "../data/poll.ts";
import type { RunArtifact, RunResult, UnreadableRun } from "../data/runs.ts";
import { aggregate, indexAll, resolveTracePath, runTotals, type Aggregate } from "../data/stats.ts";
import { readAlert, readEvent, readToolResult } from "../data/trace-detail.ts";
import { indexTrace, type TraceIndex } from "../data/trace-index.ts";
import type { ConsoleEnv } from "../env.ts";
import type { ActivityRow } from "../view/activity.ts";
import {
  alertFactsFromResult,
  alertLines,
  enrichWithAlertJson,
  type AlertFacts,
} from "../view/alert.ts";
import { bandLabel, linesText, truncate, verdictBand, type Line } from "../view/format.ts";
import { isPending, resultsWithPending } from "../view/run-list.ts";
import { toTranscript, transcriptLines, type TranscriptBlock } from "../view/transcript.ts";
import { pendingLine, resultRows, runRows, scrollOffset, windowed } from "./panes/lists.ts";
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

const TABS: Tab[] = ["verdict", "activity", "transcript", "stream"];
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
const ALERTS_MAX_HEIGHT = 9;
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
    "  [ ]         previous / next tab — Verdict · Activity · Transcript · Stream",
    "  /           filter the focused list",
    "  y           copy the focused pane — on a call, the exact KQL",
    "  c           configuration and cost",
    "  F           Stream: toggle follow",
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
    "  The console is read-only. Nothing here writes to runs/.",
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
  " 1-4 pane   j/k move   [ ] tab   ⏎ expand   / filter   y copy   c config   ? help   q quit";

export interface AppOptions {
  runsDir: string;
  tracesDir: string;
  env: ConsoleEnv;
  /**
   * Renderer to draw into. Omitted in production, where the app owns the terminal; supplied by
   * tests, which pass `createTestRenderer`'s so panes can be snapshot-tested with no terminal
   * attached (PRD-3 §12).
   */
  renderer?: CliRenderer;
  /** Overridden by tests so quitting does not take the test process with it. */
  exit?: (code: number) => void;
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
}

export async function runApp(options: AppOptions): Promise<AppHandle> {
  const { env, runsDir, tracesDir } = options;
  const owned = options.renderer === undefined;
  const renderer = options.renderer ?? (await createCliRenderer());
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const state: State = {
    runs: [],
    unreadable: [],
    runIndex: 0,
    resultIndex: 0,
    tab: "verdict",
    focus: 2,
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
  const caseText = new TextRenderable(renderer, { id: "case-text", fg: COLOR.text });
  caseBox.add(caseText);

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
    title: "[1] Alerts in run",
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
  function visibleRuns(): RunArtifact[] {
    if (state.filter === "" || state.filterTarget !== 2) return state.runs;
    const needle = state.filter.toLowerCase();
    return state.runs.filter((run) => runHaystack(run).includes(needle));
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

  const currentRun = (): RunArtifact | undefined => visibleRuns()[state.runIndex];
  const currentResult = (): RunResult | undefined => visibleResults()[state.resultIndex];

  /** Keep both selections inside their filtered lists after the filter or the data changes. */
  function clampSelection(): void {
    state.runIndex = Math.min(state.runIndex, Math.max(0, visibleRuns().length - 1));
    state.resultIndex = Math.min(state.resultIndex, Math.max(0, visibleResults().length - 1));
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
    caseBox.visible = !narrow;

    const run = currentRun();
    const pending = pendingLine(run);

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
        { text: " · read-only", tone: "dim" },
      ],
    ]);

    const caseLines: Line[] =
      state.alertFacts === undefined
        ? [[{ text: " no alert recorded", tone: "dim" }]]
        : alertLines(state.alertFacts, SIDEBAR_WIDTH - 3);
    caseText.content = styled(caseLines);
    caseBox.title = truncate(
      `[3] Case${state.alertFacts === undefined ? "" : ` — ${state.alertFacts.alertId.slice(0, 8)}`}`,
      SIDEBAR_WIDTH - 4,
    );

    const listWidth = (narrow ? width : SIDEBAR_WIDTH) - 2;
    const runs = visibleRuns();
    const results = visibleResults();

    // Heights are assigned rather than negotiated, so the scroll maths below is exact and the
    // sidebar cannot reflow while someone is moving through it.
    const sidebarRows = Math.max(0, renderer.terminalHeight - 2);
    // A share of the terminal, not of the alert. This changes only when the window is resized, so
    // the run list underneath stays put while an analyst moves through it.
    const caseHeight = Math.min(
      CASE_MAX_HEIGHT,
      Math.max(CASE_MIN_HEIGHT, Math.floor(sidebarRows * 0.5)),
    );
    const alertsHeight = narrow ? 0 : Math.min(ALERTS_MAX_HEIGHT, Math.max(3, results.length + 2));
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
    runsBox.title = truncate(
      `[2] Runs${filterSuffix(2, state.runs.length, runs.length)}${state.unreadable.length > 0 ? ` (${state.unreadable.length} unreadable)` : ""}`,
      SIDEBAR_WIDTH - 4,
    );

    // A one-row list wastes the pane, and pane [1] now carries the alert's facts in every case —
    // so the list only earns its place when there is more than one alert, or when a sweep is still
    // running and the pending count is the only progress indicator (PRD-3 §8.1, §11).
    // Always present. Hiding it for single-alert runs made `1-4` a lie on almost every run in the
    // corpus and left ⏎ walking to a pane that was not there.
    const held = allResults().length;
    const many = held > 1;
    alertsBox.visible = !narrow;
    alertsBox.title = truncate(
      `${many ? "[1] Alerts" : "[1] Alert"}${filterSuffix(1, held, results.length)}${pending === undefined ? "" : ` —${pending.trimEnd()}`}`,
      SIDEBAR_WIDTH - 4,
    );
    const alertRowsAll = resultRows(results, state.resultIndex, listWidth);
    state.alertScroll = scrollOffset(
      state.alertScroll,
      state.resultIndex,
      results.length,
      alertsHeight - 2,
    );
    alertsText.content = styled(
      alertRowsAll.length === 0
        ? [[{ text: "  no alerts recorded yet", tone: "dim" }]]
        : windowed(alertRowsAll, state.alertScroll, alertsHeight - 2),
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

    const onTabs = state.screen === "dashboard" && currentResult() !== undefined;
    tabBar.visible = onTabs;
    tabBar.height = onTabs ? 2 : 0;
    if (onTabs) tabBar.content = styled(tabBarLines(bodyWidth));

    // Budgeted against the *box*, not its text area, and against the corners the border draws.
    // Using the body width let a long alert title run over the top-right corner.
    const titleRoom = Math.max(8, boxWidth - 6);
    mainBox.title = truncate(mainTitle(), titleRoom);

    mainScroll.stickyScroll = state.tab === "stream" && state.follow;
    mainScroll.stickyStart = "bottom";

    keyBar.content = styled([
      state.notice === undefined
        ? [{ text: truncate(KEY_BAR, width), tone: "dim" }]
        : [{ text: truncate(state.notice, width), tone: "accent", bold: true }],
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
        ? { text: tab.toUpperCase(), tone: "accent" as const, bold: true }
        : { text: tab, tone: "dim" as const },
    ]);
    return [
      [{ text: "  " }, ...spans],
      [{ text: "  " + "─".repeat(Math.max(0, width - 2)), tone: "dim" }],
    ];
  }

  function mainBody(width: number): Line[] {
    if (state.screen === "help") return helpLines();
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
      void loadTrace();
    } else if (state.focus === 1) {
      const count = visibleResults().length;
      const next = Math.min(Math.max(0, state.resultIndex + delta), Math.max(0, count - 1));
      if (next === state.resultIndex) return;
      state.resultIndex = next;
      state.detailOpen = false;
      void loadTrace();
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
        void refresh();
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
  let closed = false;
  function stop(): void {
    if (closed) return;
    closed = true;
    tail?.stop();
    runsPoll.stop();
  }

  function shutdown(code: number): void {
    stop();
    if (owned) renderer.destroy();
    exit(code);
  }

  async function refresh(): Promise<void> {
    const { readRuns } = await import("../data/runs.ts");
    applyRuns(await readRuns(runsDir));
  }

  function applyRuns(snapshot: { runs: RunArtifact[]; unreadable: UnreadableRun[] }): void {
    const previous = currentRun()?.runId;
    state.runs = snapshot.runs;
    state.unreadable = snapshot.unreadable;
    if (previous !== undefined) {
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

  renderer.keyInput.prependListener("keypress", onKey);
  renderer.on("resize", render);
  renderer.once("destroy", () => renderer.keyInput.off("keypress", onKey));

  // The terminal must come back on every path, including a crash (PRD-3 §9.9).
  if (owned) {
    process.on("SIGINT", () => shutdown(130));
    process.on("SIGTERM", () => shutdown(143));
    process.on("uncaughtException", (error: unknown) => {
      stop();
      renderer.destroy();
      console.error(error);
      process.exit(1);
    });
  }

  const { readRuns } = await import("../data/runs.ts");
  applyRuns(await readRuns(runsDir));
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
