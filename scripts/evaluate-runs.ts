#!/usr/bin/env bun
/**
 * Scores investigation runs against the hidden scenario ground truth (PRD-6).
 *
 * This is evaluation tooling, and it lives in `scripts/` for a reason: it reads
 * `fixtures/scenarios/`, which PRD-2 §20 keeps strictly out of the agent's reach. Nothing under
 * `apps/investigator/**` may import this file, and the oxlint boundary rule already exempts
 * `scripts/**` from the Mock Sentinel import restriction so the join can happen here.
 *
 * **No scored artifact is ever written** (PRD-6 §5.5, ADR 008 §2). Given `p` — the agent's own
 * `tpPercent`, already on the artifact — and a score, `t = p ± √score`, and with `t` drawn from
 * `{0, 0.5, 1}` that recovers the verdict exactly. A scored file is the answer key in a new coat,
 * and neither ground-truth guard would catch a runtime read of one. This command prints.
 *
 *   bun run evaluate                       # every condition
 *   bun run evaluate --run <id>            # one run
 *   bun run evaluate --compare a b         # two runs, or two condition ids
 *   bun run evaluate --gaps [--json]       # what is missing before the corpus can answer anything
 *   bun run evaluate --gaps --condition a41f --condition 9c2e     # ...for the ones being rebuilt
 *   bun run evaluate --runs <dir>          # score a different set (implies <dir>/.archive)
 *   bun run evaluate --exclude-archive     # score only what the console would see
 */
import { join } from "node:path";

import { InvestigationRun } from "../apps/investigator/src/contracts/run.ts";
import { loadScenarios, type Scenario } from "../apps/mock-sentinel/src/scenarios/scenarios.ts";
import { fieldDiff, labelsFor } from "./evaluate/condition.ts";
import {
  buildReport,
  type BuiltReport,
  type Cell,
  type ConditionReport,
  gapsFor,
  READY_AT,
  runSetFingerprint,
} from "./evaluate/report.ts";
import {
  BANDS,
  baseRate,
  bestBlindConstant,
  blindConstant,
  LEGACY_BANDS,
  noiseFloor,
  referenceBrier,
  signTest,
  skill,
  type Verdict,
} from "./evaluate/scoring.ts";

const ARCHIVE_DIR = ".archive";
/** The constant printed in the baseline row. Held fixed so the row is comparable release to release. */
const BLIND_EXEMPLAR = 65;

interface LoadedRuns {
  runs: InvestigationRun[];
  skipped: { file: string; reason: string }[];
  duplicates: string[];
  directories: string[];
}

/**
 * Read every run that has ever been recorded (PRD-6 §6.9, ADR 008 §8).
 *
 * **The archive is scored.** `queue:reset` renames an artifact into `runs/.archive/` to take its
 * alert out of the *queue*, and it works precisely because both readers glob non-recursively — so a
 * console operation silently deleted a measurement from the benchmark. Three passes of PRD-6 read
 * three different terra-versus-luna answers from the same two models because of it. The console
 * side of that archive is correct and unchanged; this side was never decided.
 *
 * Validated rather than cast (**D9**): a JSON-valid artifact of the wrong shape used to throw out
 * of the sort or the scoring loop and take every valid run with it.
 */
async function loadRuns(runsDir: string, includeArchive: boolean): Promise<LoadedRuns> {
  const directories = includeArchive ? [runsDir, join(runsDir, ARCHIVE_DIR)] : [runsDir];
  const byId = new Map<string, InvestigationRun>();
  const skipped: { file: string; reason: string }[] = [];
  const duplicates: string[] = [];
  const glob = new Bun.Glob("*.json");

  for (const directory of directories) {
    // A run set with nothing archived is the normal case on a fresh clone, and `scan` throws on a
    // missing directory rather than yielding nothing. Reading the archive must never be able to
    // stop the live runs being scored.
    let files: string[];
    try {
      // eslint-disable-next-line no-await-in-loop -- two directories, read in a defined order
      files = await Array.fromAsync(glob.scan({ cwd: directory, absolute: true }));
    } catch {
      continue;
    }

    for (const file of files) {
      let raw: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- one file at a time is the whole loop
        raw = await Bun.file(file).json();
      } catch {
        skipped.push({ file, reason: "unreadable or not JSON" });
        continue;
      }
      const parsed = InvestigationRun.safeParse(raw);
      if (!parsed.success) {
        skipped.push({
          file,
          reason: parsed.error.issues[0]?.message ?? "does not match the schema",
        });
        continue;
      }
      // Live wins: a `--restore` that copied rather than moved must not double-count a draw.
      if (byId.has(parsed.data.runId)) {
        duplicates.push(parsed.data.runId);
        continue;
      }
      byId.set(parsed.data.runId, parsed.data);
    }
  }

  return {
    runs: [...byId.values()].toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)),
    skipped,
    duplicates,
    directories,
  };
}

function isVerdict(value: string): value is Verdict {
  return value === "true-positive" || value === "false-positive" || value === "inconclusive";
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function signed(value: number, digits = 3): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function drawList(cell: Cell): string {
  return cell.draws
    .map((draw) => (draw.status === "failed" ? "✗" : String(draw.tpPercent ?? "?")))
    .join(", ");
}

function printHeader(loaded: LoadedRuns, scenarios: Scenario[], scoredRunIds: string[]): void {
  const counts = loaded.directories.map((directory) => directory).join(", ");
  console.info(
    `RUN SET  ${loaded.runs.length} artifacts (${counts})  ` +
      `fingerprint ${runSetFingerprint(scoredRunIds)}  ·  ${scenarios.length} scenarios`,
  );
  console.info(
    `BANDS    partition: FP <= ${BANDS.falsePositiveMax} · inconclusive ` +
      `${BANDS.inconclusiveMin}-${BANDS.inconclusiveMax} · TP >= ${BANDS.truePositiveMin}` +
      `      (legacy bands shown as band⁰)`,
  );
  for (const duplicate of new Set(loaded.duplicates)) {
    console.warn(`[evaluate] run ${duplicate} appears in more than one directory — counted once`);
  }
  for (const skip of loaded.skipped) {
    console.warn(`[evaluate] skipping ${skip.file} — ${skip.reason}`);
  }
}

function printConditions(report: BuiltReport, labels: Map<string, string>, total: number): void {
  console.info("\nCONDITIONS");
  for (const condition of report.conditions) {
    const ready = condition.cells.filter((cell) => cell.draws.length >= READY_AT).length;
    const failures =
      condition.runLevelFailures.length === 0
        ? ""
        : `  no draws (${condition.runLevelFailures.length} run(s) failed: ` +
          `${[...new Set(condition.runLevelFailures.map((failure) => failure.errorName))].join(", ")})`;
    console.info(
      `  ${condition.condition.id}  ${pad(labels.get(condition.condition.id) ?? "", 70)} ` +
        `covered ${String(condition.covered).padStart(2)}/${total}  ` +
        `n>=${READY_AT} ${ready}/${condition.covered}${failures}`,
    );
  }
}

function printCondition(condition: ConditionReport, label: string, total: number): void {
  console.info(`\n${condition.condition.id}  ${label}`);
  console.info(
    `${pad("scenario", 31)}${pad("truth", 15)}${pad("n", 3)}${pad("draws", 16)}` +
      `${pad("med", 5)}${pad("spread", 8)}${pad("band", 6)}${pad("band⁰", 7)}` +
      `${pad("score", 7)}${pad("bias²+var", 14)}${pad("impact", 8)}${pad("turns", 7)}` +
      `${pad("$", 8)}s`,
  );
  console.info("-".repeat(140));

  for (const cell of condition.cells) {
    const turns = cell.draws.filter((draw) => draw.turns !== undefined);
    const costs = cell.draws.filter((draw) => draw.costUsd !== undefined);
    const meanDuration =
      cell.draws.reduce((sum, draw) => sum + draw.durationMs, 0) / cell.draws.length;
    console.info(
      pad(cell.scenarioId, 31) +
        pad(cell.verdict, 15) +
        pad(String(cell.draws.length), 3) +
        pad(drawList(cell), 16) +
        pad(cell.score.median.toFixed(0), 5) +
        pad(cell.score.spread === 0 ? "—" : String(cell.score.spread), 8) +
        pad(cell.bandPass ? "PASS" : "FAIL", 6) +
        pad(cell.legacyBandPass ? "PASS" : "FAIL", 7) +
        pad(cell.score.score.toFixed(3), 7) +
        pad(`${cell.score.bias2.toFixed(3)}+${cell.score.variance.toFixed(3)}`, 14) +
        pad(cell.impactScored === 0 ? "—" : `${cell.impactOk}/${cell.impactScored}`, 8) +
        pad(
          turns.length === 0
            ? "—"
            : (turns.reduce((sum, draw) => sum + (draw.turns ?? 0), 0) / turns.length).toFixed(0),
          7,
        ) +
        pad(
          costs.length === 0
            ? "—"
            : costs.reduce((sum, draw) => sum + (draw.costUsd ?? 0), 0).toFixed(2),
          8,
        ) +
        (meanDuration / 1000).toFixed(1),
    );
  }

  console.info("-".repeat(140));
  const floor = noiseFloor(condition.cells.map((cell) => cell.score));
  console.info(
    `skill ${signed(condition.skill)} (ref over ${condition.covered} covered) · ` +
      `covered ${condition.covered}/${total} · draws ${condition.draws} · ` +
      `failed ${condition.failedDraws} · band-dir ${condition.bandDirection}/${condition.covered} · ` +
      `band⁰-dir ${condition.legacyBandDirection}/${condition.covered} · ` +
      `mean ${(condition.meanDurationMs / 1000).toFixed(1)}s` +
      (condition.totalCostUsd === undefined ? "" : ` · $${condition.totalCostUsd.toFixed(2)}`) +
      (floor === undefined ? "" : ` · noise floor ${floor.toFixed(3)}`),
  );

  const short = condition.cells.filter((cell) => cell.draws.length < READY_AT).length;
  if (short > 0) {
    console.info(`insufficient data: ${short} of ${condition.cells.length} cells at n<${READY_AT}`);
  }
  for (const failure of condition.runLevelFailures) {
    console.info(`run-level failure: ${failure.runId} — ${failure.errorName}`);
  }
}

/**
 * The baseline row, printed under every report (PRD-6 §6.10).
 *
 * A stub answering one constant to every alert and issuing no query scored 12/14 under the old
 * overlapping bands — beating both measured models. It cannot beat the partition, and it can never
 * show positive skill: the skill-optimal constant *is* the base rate, where skill is exactly zero
 * by construction. That is what makes this a floor rather than a target.
 */
function printBlindConstant(verdicts: Verdict[], rate: number): void {
  const reference = referenceBrier(verdicts, rate);
  const p = BLIND_EXEMPLAR / 100;
  const brier =
    verdicts.reduce((sum, verdict) => {
      const t = verdict === "true-positive" ? 1 : verdict === "false-positive" ? 0 : 0.5;
      return sum + (p - t) ** 2;
    }, 0) / verdicts.length;
  const best = bestBlindConstant(verdicts, BANDS);
  console.info(
    `blind constant tp=${BLIND_EXEMPLAR}: band ${blindConstant(verdicts, BLIND_EXEMPLAR, BANDS)}/${verdicts.length}` +
      ` · band⁰ ${blindConstant(verdicts, BLIND_EXEMPLAR, LEGACY_BANDS)}/${verdicts.length}` +
      ` · skill ${signed(skill(brier, reference))}` +
      `   (best constant under the partition: tp=${best.percent} → ${best.passed}/${verdicts.length})`,
  );
}

/**
 * Compare two runs or two conditions on the scenarios they share (PRD-6 §6.5, **D8**).
 *
 * The old version filtered on `runId` and never read the model, so comparing terra against luna
 * printed `FIXED`/`REGRESSED` as though one had improved on the other — and labelled its columns
 * with 8-char id prefixes, of which 16 of 40 runs shared one with another run.
 */
function compare(
  report: BuiltReport,
  labels: Map<string, string>,
  a: string,
  b: string,
  rate: number,
): void {
  const resolve = (
    id: string,
  ): { title: string; conditionId?: string; cells: Map<string, Cell> } | undefined => {
    const condition = report.conditions.find((entry) => entry.condition.id === id);
    if (condition) {
      return {
        title: `${id}  ${labels.get(id) ?? ""}`,
        conditionId: id,
        cells: new Map(condition.cells.map((cell) => [cell.scenarioId, cell])),
      };
    }
    const draws = report.drawsByRun.get(id);
    if (draws === undefined || draws.length === 0) return undefined;
    const owner = report.conditions.find((entry) => entry.condition.id === draws[0]?.conditionId);
    const cells = new Map<string, Cell>();
    for (const cell of owner?.cells ?? []) {
      const mine = cell.draws.filter((draw) => draw.runId === id);
      if (mine.length > 0) cells.set(cell.scenarioId, { ...cell, draws: mine });
    }
    return {
      title: `${id}  ${labels.get(owner?.condition.id ?? "") ?? ""}`,
      ...(owner === undefined ? {} : { conditionId: owner.condition.id }),
      cells,
    };
  };

  const left = resolve(a);
  const right = resolve(b);
  if (!left || !right) {
    console.error(`[evaluate] ${!left ? a : b} is not a run id or a condition id in this set.`);
    process.exit(1);
  }

  console.info(`\nA  ${left.title}`);
  console.info(`B  ${right.title}`);

  if (left.conditionId !== undefined && right.conditionId !== undefined) {
    const first = report.conditionsById.get(left.conditionId);
    const second = report.conditionsById.get(right.conditionId);
    if (first && second) {
      const diff = fieldDiff(first, second);
      console.info(
        diff.length === 0
          ? "\nsame condition — this is a repeat, not a comparison"
          : `\nwhat differs: ${diff.map((entry) => `${entry.field} ${entry.a} → ${entry.b}`).join(", ")}`,
      );
    }
  }

  // Shared scenarios only. Comparing over the union rewards whichever side happened to run more.
  const shared = [...left.cells.keys()].filter((id) => right.cells.has(id)).toSorted();
  if (shared.length === 0) {
    console.info("\nno shared scenarios — nothing to compare.");
    return;
  }

  console.info(
    `\n${pad("scenario", 31)}${pad("truth", 15)}${pad("A draws", 16)}${pad("score", 8)}` +
      `${pad("B draws", 16)}${pad("score", 8)}winner`,
  );
  console.info("-".repeat(100));

  let up = 0;
  let down = 0;
  let ties = 0;
  let brierA = 0;
  let brierB = 0;
  let reference = 0;

  for (const id of shared) {
    const cellA = left.cells.get(id);
    const cellB = right.cells.get(id);
    if (!cellA || !cellB) continue;
    brierA += cellA.score.score;
    brierB += cellB.score.score;
    reference += (rate - cellA.target) ** 2;
    const winner =
      Math.abs(cellA.score.score - cellB.score.score) < 1e-9
        ? ((ties += 1), "tie")
        : cellA.score.score < cellB.score.score
          ? ((up += 1), "A")
          : ((down += 1), "B");
    console.info(
      pad(id, 31) +
        pad(cellA.verdict, 15) +
        pad(drawList(cellA), 16) +
        pad(cellA.score.score.toFixed(3), 8) +
        pad(drawList(cellB), 16) +
        pad(cellB.score.score.toFixed(3), 8) +
        winner,
    );
  }

  brierA /= shared.length;
  brierB /= shared.length;
  reference /= shared.length;
  const skillA = skill(brierA, reference);
  const skillB = skill(brierB, reference);
  const floor = noiseFloor(
    [...left.cells.values(), ...right.cells.values()].map((cell) => cell.score),
  );
  const delta = Math.abs(skillA - skillB);

  console.info("-".repeat(100));
  console.info(
    `A skill ${signed(skillA)} · B skill ${signed(skillB)} · ` +
      `wins A ${up}, B ${down}, ties ${ties} · ` +
      `exact two-sided sign test p = ${signTest(up, down).toFixed(3)}`,
  );
  console.info(
    floor !== undefined && delta < floor
      ? `no measurable difference — Δskill ${delta.toFixed(3)} is inside this pair's noise floor ${floor.toFixed(3)}`
      : floor === undefined
        ? `Δskill ${delta.toFixed(3)}, and neither side has a repeat, so there is no measured noise floor to judge it against`
        : `Δskill ${delta.toFixed(3)} against a noise floor of ${floor.toFixed(3)}`,
  );
  console.info("");
}

/**
 * One run, on its own (PRD-6 §6.5).
 *
 * Rendered as its condition's table narrowed to this run's draws, and labelled with the condition
 * it belongs to — a run id alone says nothing about what produced it, which is the whole reason the
 * old `--run` output could not be compared with anything.
 */
function printRun(
  report: BuiltReport,
  labels: Map<string, string>,
  runId: string,
  total: number,
): void {
  const draws = report.drawsByRun.get(runId);
  if (draws === undefined || draws.length === 0) {
    const failure = report.conditions
      .flatMap((condition) => condition.runLevelFailures)
      .find((entry) => entry.runId === runId);
    console.error(
      failure === undefined
        ? `[evaluate] ${runId} produced no scoreable draw — it may not exist, or its alerts have no ground truth.`
        : `[evaluate] ${runId} failed before investigating anything — ${failure.errorName}.`,
    );
    process.exit(1);
  }

  const conditionId = draws[0]?.conditionId ?? "";
  const owner = report.conditions.find((entry) => entry.condition.id === conditionId);
  if (owner === undefined) return;

  const cells = owner.cells
    .map((cell) => ({ ...cell, draws: cell.draws.filter((draw) => draw.runId === runId) }))
    .filter((cell) => cell.draws.length > 0);

  printCondition(
    { ...owner, cells, covered: cells.length, draws: draws.length },
    `${labels.get(conditionId) ?? ""}   (run ${runId})`,
    total,
  );
  console.info("");
}

function printGaps(
  report: BuiltReport,
  scenarios: Scenario[],
  labels: Map<string, string>,
  asJson: boolean,
  only: string[],
): void {
  // Unfiltered, this totals every condition on disk — including the pre-config generations nobody
  // would ever backfill. That is a true number and a useless one: a work list has to be a list of
  // work somebody intends to do, so `--condition` names the ones being re-baselined (§6.12).
  const all = gapsFor(report, scenarios, labels);
  const gaps = only.length === 0 ? all : all.filter((gap) => only.includes(gap.conditionId));
  if (asJson) {
    console.info(
      JSON.stringify(
        { readyAt: READY_AT, conditions: only, total: gaps.reduce((n, g) => n + g.need, 0), gaps },
        null,
        2,
      ),
    );
    return;
  }
  if (gaps.length === 0) {
    console.info(`[evaluate] every condition has ${READY_AT} draws in every scenario.`);
    return;
  }
  const byCondition = new Map<string, typeof gaps>();
  for (const gap of gaps) {
    byCondition.set(gap.conditionId, [...(byCondition.get(gap.conditionId) ?? []), gap]);
  }
  console.info(`\nGAPS to n=${READY_AT}`);
  for (const [conditionId, entries] of byCondition) {
    const need = entries.reduce((sum, gap) => sum + gap.need, 0);
    console.info(`\n  ${conditionId}  ${labels.get(conditionId) ?? ""}   ${need} investigation(s)`);
    for (const gap of entries) {
      console.info(`    ${pad(gap.scenarioId, 34)}have ${gap.have}  need ${gap.need}`);
    }
  }
  console.info(
    `\ntotal: ${gaps.reduce((sum, gap) => sum + gap.need, 0)} investigation(s) across ` +
      `${byCondition.size} condition(s)` +
      (only.length === 0
        ? ` — every condition on disk. Narrow with --condition <id> to the ones being re-baselined.`
        : ""),
  );
  console.info("");
}

const argv = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const runsDir = flag("--runs") ?? Bun.env["RUNS_DIR"] ?? "runs";
const includeArchive = !argv.includes("--exclude-archive");
const [scenarios, loaded] = await Promise.all([loadScenarios(), loadRuns(runsDir, includeArchive)]);

if (loaded.runs.length === 0) {
  console.error(`[evaluate] no run artifacts in ${loaded.directories.join(" or ")}`);
  process.exit(1);
}

const verdicts = scenarios.map((scenario) => scenario.verdict).filter(isVerdict);
const rate = baseRate(verdicts);
const report = buildReport({ runs: loaded.runs, scenarios, baseRate: rate });
const labels = labelsFor([...report.conditionsById.values()]);
const scoredRunIds = report.conditions.flatMap((condition) => condition.runIds);

/**
 * The one exit-code gate (PRD-6 §6.5, **D7**).
 *
 * A corpus change that orphans every run used to be indistinguishable from a typo'd run id: both
 * printed `no scored results` and exited 0. There is deliberately no gate on the *score* — at n=1
 * the smallest credible skill delta is large, and a benchmark that cries wolf gets disabled.
 */
if (report.buckets.scored === 0 && report.buckets.failed === 0) {
  console.error(
    `[evaluate] ${loaded.runs.length} run(s) read and none joined to a scenario.\n` +
      `           Unjoined alert ids: ${report.unjoinedAlertIds.slice(0, 10).join(", ")}` +
      `${report.unjoinedAlertIds.length > 10 ? ` (+${report.unjoinedAlertIds.length - 10} more)` : ""}\n` +
      `           A rule edit re-pins a scenario's content-addressed alert id (ADR 004), which orphans every run for it.`,
  );
  process.exit(1);
}

if (argv.includes("--gaps")) {
  const only = argv.flatMap((arg, index) => (arg === "--condition" ? [argv[index + 1] ?? ""] : []));
  printGaps(
    report,
    scenarios,
    labels,
    argv.includes("--json"),
    only.filter((id) => id !== ""),
  );
} else {
  const compareIndex = argv.indexOf("--compare");
  const runId = flag("--run");

  printHeader(loaded, scenarios, scoredRunIds);

  if (compareIndex !== -1) {
    const a = argv[compareIndex + 1];
    const b = argv[compareIndex + 2];
    if (a === undefined || b === undefined) {
      console.error("[evaluate] --compare needs two run or condition ids");
      process.exit(1);
    }
    compare(report, labels, a, b, rate);
  } else if (runId !== undefined) {
    printRun(report, labels, runId, scenarios.length);
  } else {
    printConditions(report, labels, scenarios.length);
    for (const condition of report.conditions) {
      if (condition.cells.length === 0) continue;
      printCondition(condition, labels.get(condition.condition.id) ?? "", scenarios.length);
    }
    console.info("");
    printBlindConstant(verdicts, rate);
    console.info(
      `buckets: scored ${report.buckets.scored} · failed ${report.buckets.failed} · ` +
        `no-summary ${report.buckets.noSummary} · no-ground-truth ${report.buckets.noGroundTruth}\n`,
    );
  }
}
