#!/usr/bin/env bun
/**
 * Returns alerts to the queue by archiving the runs that cover them (PRD-5 §11).
 *
 * The queue is derived — "alerts with no run" is `listAlerts()` folded against `runs/` — so putting
 * an alert back means removing its run artifacts. Doing that by hand means finding a UUID filename
 * first, which is enough friction to stop anyone running the same scenario twice.
 *
 * **Archive, not delete, by default.** A run costs real money to reproduce. Both readers use a
 * *non-recursive* glob — `apps/console/src/data/runs.ts` and `scripts/evaluate-runs.ts` are each
 * `new Bun.Glob("*.json")` over the runs directory — so a rename into `runs/.archive/` removes a
 * run from the console *and* from the evaluation report with no code change in either.
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
 *   bun run queue:reset --purge --run <id>
 *   bun run queue:reset --include-feedback --run <id>
 *   bun run queue:reset --dry-run --all
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { AnalystFeedback } from "../apps/console/src/drive/feedback.ts";
import { buildBenchmarkMap } from "./generate-benchmark-map.ts";

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
  includeFeedback: boolean;
  runsDir: string;
  tracesDir: string;
  feedbackDir: string;
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
    includeFeedback: false,
    runsDir: process.env["RUNS_DIR"] ?? "runs",
    tracesDir: process.env["INVESTIGATOR_TRACE_DIR"] ?? "runs/traces",
    feedbackDir: process.env["FEEDBACK_DIR"] ?? "feedback",
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
      case "--include-feedback":
        args.includeFeedback = true;
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
}

interface FeedbackFile {
  path: string;
  name: string;
  runId: string;
}

async function readRunFiles(directory: string): Promise<RunFile[]> {
  const files: RunFile[] = [];
  const glob = new Bun.Glob("*.json");
  for await (const name of glob.scan({ cwd: directory })) {
    const path = join(directory, name);
    try {
      const parsed = (await Bun.file(path).json()) as {
        runId?: string;
        results?: { alertId?: string }[];
        plannedAlerts?: { alertId?: string }[];
      };
      const runId = parsed.runId ?? name.replace(/\.json$/, "");
      const alertIds = [...(parsed.results ?? []), ...(parsed.plannedAlerts ?? [])]
        .map((entry) => entry.alertId)
        .filter((id): id is string => id !== undefined);
      files.push({ path, runId, alertIds: [...new Set(alertIds)] });
    } catch {
      // An unreadable artifact is not a reason to abandon the reset; it is simply not selectable.
    }
  }
  return files;
}

async function readFeedbackFiles(directory: string): Promise<FeedbackFile[]> {
  const files: FeedbackFile[] = [];
  const glob = new Bun.Glob("*.json");
  for await (const name of glob.scan({ cwd: directory })) {
    const path = within(directory, name);
    try {
      const parsed = AnalystFeedback.safeParse(await Bun.file(path).json());
      if (!parsed.success) continue;
      files.push({ path, name, runId: parsed.data.runId });
    } catch {
      // Malformed feedback is never moved based on a filename guess.
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
  const feedbackDir = resolve(args.feedbackDir);
  const runsArchive = within(runsDir, ARCHIVE_DIR);
  const tracesArchive = within(tracesDir, ARCHIVE_DIR);
  const feedbackArchive = within(feedbackDir, ARCHIVE_DIR);

  const scenarioAlerts = new Set(
    args.scenarios ? (await buildBenchmarkMap()).map((entry) => entry.alertId) : [],
  );

  // Restore reads out of the archive; everything else reads the live directory.
  const source = args.restore ? runsArchive : runsDir;
  const files = await readRunFiles(source).catch(() => []);
  const selected = select(files, args, scenarioAlerts);

  if (selected.length === 0) {
    log("[queue:reset] nothing matched.");
    return;
  }

  const selectedRunIds = new Set(selected.map((file) => file.runId));
  const feedbackSource = args.restore ? feedbackArchive : feedbackDir;
  const feedbackFiles = args.includeFeedback
    ? (await readFeedbackFiles(feedbackSource).catch(() => [])).filter((file) =>
        selectedRunIds.has(file.runId),
      )
    : [];

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

  for (const file of feedbackFiles) {
    const target = args.restore
      ? within(feedbackDir, file.name)
      : within(feedbackArchive, file.name);
    if (args.purge) {
      if (!args.dryRun) await rm(file.path, { force: true });
    } else {
      await moveFile(file.path, target, args.dryRun);
    }
  }

  /* eslint-enable no-await-in-loop */

  log(
    `[queue:reset] ${args.dryRun ? "would affect" : "affected"} ${selected.length} run(s). ` +
      `${feedbackFiles.length} feedback record(s). ` +
      (args.restore || args.purge ? "" : "Their alerts are back in the queue."),
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
