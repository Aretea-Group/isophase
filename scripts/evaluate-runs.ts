#!/usr/bin/env bun
/**
 * Scores investigation runs against the hidden scenario ground truth.
 *
 * This is evaluation tooling, and it lives in `scripts/` for a reason: it reads
 * `fixtures/scenarios/`, which PRD-2 §20 keeps strictly out of the agent's reach. Nothing under
 * `apps/investigator/**` may import this file, and the oxlint boundary rule already exempts
 * `scripts/**` from the Mock Sentinel import restriction so the join can happen here.
 *
 * PRD-2 §23 defers formal regression infrastructure and asks only that run artifacts make later
 * comparison straightforward. This is the smallest thing that cashes that in — the alternative,
 * which we used once, is scoring by hand and calling the result an improvement.
 *
 *   bun run evaluate                 # score every run
 *   bun run evaluate --run <id>      # score one run
 *   bun run evaluate --compare a b   # diff two runs
 */
import { loadScenarios, type Scenario } from "../apps/mock-sentinel/src/scenarios/scenarios.ts";

/**
 * Bands for calling a TP percentage "the right direction".
 *
 * Deliberately generous. PRD-2 §23 says the trajectory must not be graded and different valid
 * investigations reach different numbers; what is being measured is whether the agent leaned the
 * correct way, not whether it hit a target. The inconclusive band is the interesting one — it is
 * the only case where a *confident* answer in either direction is wrong.
 */
const TRUE_POSITIVE_MIN = 60;
const FALSE_POSITIVE_MAX = 40;
const INCONCLUSIVE_BAND: readonly [number, number] = [30, 70];

interface RunResult {
  alertId: string;
  alertTitle?: string;
  status: "completed" | "failed";
  durationMs?: number;
  summary?: {
    tpPercent: number;
    fpPercent: number;
    /** Absent on runs written before the impact field was added. */
    impact?: string;
    researchDone?: string[];
  };
  error?: { name: string; message: string };
}

interface RunFile {
  runId: string;
  startedAt: string;
  model?: { provider: string; id: string };
  /** Present when an analyst supplied a premise — a steered run (PRD-5 §4.5). */
  config?: { analystContext?: string };
  results: RunResult[];
}

interface Scored {
  scenario: string;
  runId: string;
  model: string;
  verdict: Scenario["verdict"];
  expectedImpact: Scenario["impact"];
  tpPercent: number;
  actualImpact?: string;
  directionOk: boolean;
  /** Undefined when the run predates the impact field — unscored, not wrong. */
  impactOk?: boolean;
  durationMs: number;
}

function directionCorrect(verdict: Scenario["verdict"], tpPercent: number): boolean {
  switch (verdict) {
    case "true-positive":
      return tpPercent >= TRUE_POSITIVE_MIN;
    case "false-positive":
      return tpPercent <= FALSE_POSITIVE_MAX;
    case "inconclusive":
      return tpPercent >= INCONCLUSIVE_BAND[0] && tpPercent <= INCONCLUSIVE_BAND[1];
  }
}

async function loadRuns(dir: string): Promise<RunFile[]> {
  const glob = new Bun.Glob("*.json");
  const runs: RunFile[] = [];
  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    try {
      runs.push((await Bun.file(file).json()) as RunFile);
    } catch {
      console.warn(`[evaluate] skipping unreadable run file: ${file}`);
    }
  }
  return runs.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function score(runs: RunFile[], scenarios: Scenario[]): Scored[] {
  const byAlert = new Map(scenarios.map((s) => [s.startingAlertId, s]));
  const scored: Scored[] = [];

  for (const run of runs) {
    /**
     * Skip steered runs (PRD-5 §4.5).
     *
     * Three lines, no flag, and deliberately not the design. `latestPerScenario` is last-wins on
     * `${model}::${scenario}`, so without this the first re-run carrying "this host is a scanner"
     * silently replaces the honest row for that scenario — corrupting the answer key PRD-4 exists
     * to make trustworthy. Showing both rows side by side is the right answer and is roadmap §9,
     * whose first task is to delete this skip and key on baseline-versus-steered instead.
     */
    if (run.config?.analystContext !== undefined && run.config.analystContext !== "") continue;

    for (const result of run.results) {
      const scenario = byAlert.get(result.alertId);
      // Alerts without ground truth are not failures, they are simply unscoreable — 140 of the
      // 154 alerts are in that position.
      if (!scenario || result.status !== "completed" || !result.summary) continue;

      const actualImpact = result.summary.impact;
      scored.push({
        scenario: scenario.id,
        runId: run.runId,
        model: run.model?.id ?? "unknown",
        verdict: scenario.verdict,
        expectedImpact: scenario.impact,
        tpPercent: result.summary.tpPercent,
        ...(actualImpact === undefined ? {} : { actualImpact }),
        directionOk: directionCorrect(scenario.verdict, result.summary.tpPercent),
        ...(actualImpact === undefined ? {} : { impactOk: actualImpact === scenario.impact }),
        durationMs: result.durationMs ?? 0,
      });
    }
  }
  return scored;
}

/** Keep only the most recent scoring of each scenario, per model. */
function latestPerScenario(scored: Scored[]): Scored[] {
  const seen = new Map<string, Scored>();
  for (const row of scored) seen.set(`${row.model}::${row.scenario}`, row);
  return [...seen.values()].toSorted(
    (a, b) => a.model.localeCompare(b.model) || a.scenario.localeCompare(b.scenario),
  );
}

function report(rows: Scored[]): void {
  if (rows.length === 0) {
    console.info("[evaluate] no scored results — run an investigation against a scenario alert.");
    return;
  }

  const byModel = new Map<string, Scored[]>();
  for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);

  for (const [model, modelRows] of byModel) {
    console.info(`\n${model}`);
    console.info("=".repeat(96));
    console.info(
      `${"scenario".padEnd(30)}${"truth".padEnd(15)}${"TP".padStart(5)}  ${"dir".padEnd(6)}${"impact (expected → actual)".padEnd(34)}time`,
    );
    console.info("-".repeat(96));

    for (const row of modelRows) {
      const impact =
        row.actualImpact === undefined
          ? "— not reported"
          : `${row.expectedImpact} → ${row.actualImpact} ${row.impactOk === true ? "✓" : "✗"}`;
      console.info(
        `${row.scenario.padEnd(30)}${row.verdict.padEnd(15)}${`${row.tpPercent}%`.padStart(5)}  ` +
          `${(row.directionOk ? "PASS" : "FAIL").padEnd(6)}${impact.padEnd(34)}` +
          `${(row.durationMs / 1000).toFixed(1)}s`,
      );
    }

    const dir = modelRows.filter((r) => r.directionOk).length;
    const impactScored = modelRows.filter((r) => r.impactOk !== undefined);
    const impactOk = impactScored.filter((r) => r.impactOk === true).length;
    const meanMs = modelRows.reduce((sum, r) => sum + r.durationMs, 0) / modelRows.length;

    console.info("-".repeat(96));
    console.info(
      `direction ${dir}/${modelRows.length}` +
        (impactScored.length === 0
          ? "   impact not reported by this run"
          : `   impact ${impactOk}/${impactScored.length}`) +
        `   mean ${(meanMs / 1000).toFixed(1)}s`,
    );
  }
  console.info("");
}

function cell(row: Scored | undefined): string {
  return row === undefined
    ? "—".padEnd(14)
    : `${row.tpPercent}% ${row.directionOk ? "PASS" : "FAIL"}`.padEnd(14);
}

function compare(scored: Scored[], runA: string, runB: string): void {
  const pick = (id: string) =>
    new Map(scored.filter((r) => r.runId === id).map((r) => [r.scenario, r]));
  const a = pick(runA);
  const b = pick(runB);
  const scenarios = [...new Set([...a.keys(), ...b.keys()])].toSorted();

  if (scenarios.length === 0) {
    console.info(`[evaluate] neither ${runA} nor ${runB} scored any scenario.`);
    return;
  }

  console.info(
    `\n${"scenario".padEnd(30)}${runA.slice(0, 8).padEnd(14)}${runB.slice(0, 8).padEnd(14)}change`,
  );
  console.info("-".repeat(80));
  for (const id of scenarios) {
    const left = a.get(id);
    const right = b.get(id);
    let change = "";
    if (left && right && left.directionOk !== right.directionOk) {
      change = right.directionOk ? "FIXED" : "REGRESSED";
    }
    console.info(`${id.padEnd(30)}${cell(left)}${cell(right)}${change}`);
  }
  console.info("");
}

const argv = Bun.argv.slice(2);
const runsDir = Bun.env["RUNS_DIR"] ?? "runs";
const [scenarios, runs] = await Promise.all([loadScenarios(), loadRuns(runsDir)]);

if (runs.length === 0) {
  console.error(`[evaluate] no run artifacts in ${runsDir}/`);
  process.exit(1);
}

const scored = score(runs, scenarios);
const compareIndex = argv.indexOf("--compare");
const runIndex = argv.indexOf("--run");

if (compareIndex !== -1) {
  const a = argv[compareIndex + 1];
  const b = argv[compareIndex + 2];
  if (a === undefined || b === undefined) {
    console.error("[evaluate] --compare needs two run ids");
    process.exit(1);
  }
  compare(scored, a, b);
} else if (runIndex !== -1) {
  const id = argv[runIndex + 1];
  if (id === undefined) {
    console.error("[evaluate] --run needs a run id");
    process.exit(1);
  }
  report(scored.filter((r) => r.runId === id));
} else {
  report(latestPerScenario(scored));
}
