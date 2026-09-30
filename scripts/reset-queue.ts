#!/usr/bin/env bun
/**
 * Returns alerts to the queue by archiving the runs that cover them (PRD-5 §11).
 *
 * The queue is derived — "alerts with no run" is `listAlerts()` folded against `runs/` — so putting
 * an alert back means removing its run artifacts. Doing that by hand means finding a UUID filename
 * first, which is enough friction to stop anyone running the same scenario twice.
 *
 * **Archive, not delete, by default.** A run costs real money to reproduce. The console uses a
 * *non-recursive* glob — `apps/console/src/data/runs.ts` is `new Bun.Glob("*.json")` over the runs
 * directory — so a rename into `runs/.archive/` takes the run out of the queue, which is the point.
 *
 * `scripts/evaluate-runs.ts` deliberately no longer shares that behaviour: it reads the archive too
 * (PRD-6 §6.9, ADR 008 §8). Taking an alert back into the queue is a console operation and must not
 * silently delete a measurement — three passes of PRD-6 read three different answers from the same
 * two models because it did.
 *
 * It lives in `scripts/` for two reasons, and only one is that it is a dev tool: `--scenarios`
 * resolves through the generated benchmark map, and building that map reads `fixtures/scenarios/`,
 * which is the answer key. `scripts/` is the one tree exempt from both ground-truth guards.
 *
 *   bun run queue:reset --alert <systemAlertId>
 *   bun run queue:reset --run <runId>
 *   bun run queue:reset --scenarios
 *   bun run queue:reset --all --yes
 *   bun run queue:reset --restore --alert <id>
 *   bun run queue:reset --purge --run <id> --yes
 *   bun run queue:reset --dry-run --all
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { type BenchmarkMapEntry, buildBenchmarkMap } from "./generate-benchmark-map.ts";

const ARCHIVE_DIR = ".archive";

export interface ResetArgs {
  alertIds: string[];
  runIds: string[];
  scenarios: boolean;
  all: boolean;
  yes: boolean;
  restore: boolean;
  purge: boolean;
  dryRun: boolean;
  runsDir: string;
  tracesDir: string;
}

function value(flag: string, next: string | undefined): string {
  if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return next;
}

export function parseArgs(argv: string[]): ResetArgs {
  const args: ResetArgs = {
    alertIds: [],
    runIds: [],
    scenarios: false,
    all: false,
    yes: false,
    restore: false,
    purge: false,
    dryRun: false,
    runsDir: process.env["RUNS_DIR"] ?? "runs",
    tracesDir: process.env["INVESTIGATOR_TRACE_DIR"] ?? "runs/traces",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case "--alert":
        args.alertIds.push(value(arg, argv[index + 1]));
        index += 1;
        break;
      case "--run":
        args.runIds.push(value(arg, argv[index + 1]));
        index += 1;
        break;
      case "--scenarios":
        args.scenarios = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--restore":
        args.restore = true;
        break;
      case "--purge":
        args.purge = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}".`);
    }
  }

  if (args.restore && args.purge) throw new Error("--restore and --purge are mutually exclusive.");
  if (!args.all && !args.scenarios && args.alertIds.length === 0 && args.runIds.length === 0) {
    throw new Error("Nothing selected. Pass --alert, --run, --scenarios or --all.");
  }
  if (args.all && !args.yes && !args.dryRun) {
    throw new Error("--all rewrites every run in the directory. Add --yes to confirm.");
  }
  // Archiving is reversible and purging is not. A run artifact is a measurement bought with real
  // money against a model that exposes no seed, so it cannot be re-derived — only bought again
  // (PRD-6 §5.6, ADR 008 §8). Previously only `--all` asked.
  if (args.purge && !args.yes && !args.dryRun) {
    throw new Error("--purge destroys run artifacts permanently. Add --yes to confirm.");
  }
  return args;
}

/**
 * Resolve a path and refuse anything outside its root.
 *
 * A reset command that can be pointed at an arbitrary directory is a delete command. Every path
 * this script touches goes through here, including ones assembled from ids read out of artifacts.
 */
export function within(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const target = resolve(join(base, ...segments));
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to touch "${target}" — outside ${base}.`);
  }
  return target;
}

interface RunFile {
  path: string;
  runId: string;
  alertIds: string[];
  /**
   * The alerts this run actually *answered* — a completed result carrying a summary.
   *
   * Distinct from `alertIds`, which includes planned-but-unreached alerts and is what selection
   * matches on. This is what a purge destroys, and saying so in draws rather than in files is the
   * difference between "removing 1 run" and "removing 3 measurements" (PRD-6 §6.9).
   */
  drawAlertIds: string[];
}

async function readRunFiles(directory: string): Promise<RunFile[]> {
  const files: RunFile[] = [];
  const glob = new Bun.Glob("*.json");
  for await (const name of glob.scan({ cwd: directory })) {
    const path = join(directory, name);
    try {
      const parsed = (await Bun.file(path).json()) as {
        runId?: string;
        results?: { alertId?: string; status?: string; summary?: unknown }[];
        plannedAlerts?: { alertId?: string }[];
      };
      const runId = parsed.runId ?? name.replace(/\.json$/, "");
      const alertIds = [...(parsed.results ?? []), ...(parsed.plannedAlerts ?? [])]
        .map((entry) => entry.alertId)
        .filter((id): id is string => id !== undefined);
      const drawAlertIds = (parsed.results ?? [])
        .filter((entry) => entry.status === "completed" && entry.summary !== undefined)
        .map((entry) => entry.alertId)
        .filter((id): id is string => id !== undefined);
      files.push({ path, runId, alertIds: [...new Set(alertIds)], drawAlertIds });
    } catch {
      // An unreadable artifact is not a reason to abandon the reset; it is simply not selectable.
    }
  }
  return files;
}

export function select(files: RunFile[], args: ResetArgs, scenarioAlerts: Set<string>): RunFile[] {
  if (args.all) return files;
  const wantedAlerts = new Set([...args.alertIds, ...(args.scenarios ? scenarioAlerts : [])]);
  const wantedRuns = new Set(args.runIds);
  return files.filter(
    (file) =>
      wantedRuns.has(file.runId) || file.alertIds.some((alertId) => wantedAlerts.has(alertId)),
  );
}

async function moveFile(from: string, to: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(join(to, ".."), { recursive: true });
  await rename(from, to);
}

export async function resetQueue(
  args: ResetArgs,
  log: (message: string) => void = console.info,
): Promise<void> {
  const runsDir = resolve(args.runsDir);
  const tracesDir = resolve(args.tracesDir);
  const runsArchive = within(runsDir, ARCHIVE_DIR);
  const tracesArchive = within(tracesDir, ARCHIVE_DIR);

  // Needed for `--scenarios` selection, and for `--purge` to state what it is about to destroy.
  const benchmark =
    args.scenarios || args.purge ? await buildBenchmarkMap() : ([] as BenchmarkMapEntry[]);
  const scenarioAlerts = new Set(args.scenarios ? benchmark.map((entry) => entry.alertId) : []);
  const scenarioOfAlert = new Map(benchmark.map((entry) => [entry.alertId, entry.scenarioId]));

  // Restore reads out of the archive; everything else reads the live directory.
  const source = args.restore ? runsArchive : runsDir;
  const files = await readRunFiles(source).catch(() => []);
  const selected = select(files, args, scenarioAlerts);

  if (selected.length === 0) {
    log("[queue:reset] nothing matched.");
    return;
  }

  const verb = args.restore ? "restore" : args.purge ? "purge" : "archive";
  // Sequential on purpose: these are renames within one directory, parallelism buys nothing, and
  // one line of progress per run is the whole point of the output.
  /* eslint-disable no-await-in-loop */
  for (const file of selected) {
    const target = args.restore
      ? within(runsDir, `${file.runId}.json`)
      : within(runsArchive, `${file.runId}.json`);

    if (args.purge) {
      if (!args.dryRun) await rm(file.path, { force: true });
    } else {
      await moveFile(file.path, target, args.dryRun);
    }

    // Transcripts travel with their run, or the console tails a file whose artifact is gone.
    const traceGlob = new Bun.Glob(`${file.runId}-*.jsonl`);
    const traceSource = args.restore ? tracesArchive : tracesDir;
    try {
      for await (const name of traceGlob.scan({ cwd: traceSource })) {
        const from = within(traceSource, name);
        if (args.purge) {
          if (!args.dryRun) await rm(from, { force: true });
        } else {
          await moveFile(from, within(args.restore ? tracesDir : tracesArchive, name), args.dryRun);
        }
      }
    } catch {
      // No transcripts for this run; tracing is off by default.
    }

    log(
      `[queue:reset] ${args.dryRun ? "would " : ""}${verb} ${file.runId} — ${file.alertIds.length} alert(s)`,
    );
  }

  /* eslint-enable no-await-in-loop */

  if (args.purge) {
    // Files are the unit a reader is looking at; draws are the unit that costs money to replace.
    const draws = selected.flatMap((file) =>
      file.drawAlertIds.filter((alertId) => scenarioOfAlert.has(alertId)),
    );
    const affected = new Set(draws.map((alertId) => scenarioOfAlert.get(alertId)));
    log(
      `[queue:reset] ${args.dryRun ? "purging" : "purged"} ${selected.length} run(s) ` +
        `${args.dryRun ? "would remove" : "removed"} ${draws.length} scoreable draw(s) ` +
        `across ${affected.size} scenario(s).` +
        (draws.length === 0 ? "" : " A draw cannot be re-derived — only bought again."),
    );
    return;
  }

  log(
    `[queue:reset] ${args.dryRun ? "would affect" : "affected"} ${selected.length} run(s). ` +
      (args.restore ? "" : "Their alerts are back in the queue."),
  );
}

async function main(): Promise<void> {
  await resetQueue(parseArgs(Bun.argv.slice(2)));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[queue:reset] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
