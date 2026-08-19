import { readRuns, type RunsSnapshot } from "./runs.ts";
import { indexTrace, type TraceIndex } from "./trace-index.ts";

/**
 * Filesystem polling.
 *
 * Deliberately polling rather than `fs.watch`: the console's correctness should not depend on how
 * a platform coalesces append notifications, and there is nothing to gain from the subscription at
 * this scale (PRD-3 §10.2).
 */
export interface Stoppable {
  stop(): void;
}

export const RUNS_INTERVAL_MS = 1_000;
export const TRACE_INTERVAL_MS = 500;

function repeat(intervalMs: number, tick: () => Promise<void>): Stoppable {
  let stopped = false;
  let running = false;

  const timer = setInterval(() => {
    // Skip rather than queue: a slow pass must not build a backlog of overlapping reads.
    if (stopped || running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function pollRuns(
  directory: string,
  onSnapshot: (snapshot: RunsSnapshot) => void,
  intervalMs = RUNS_INTERVAL_MS,
): Stoppable {
  return repeat(intervalMs, async () => {
    onSnapshot(await readRuns(directory));
  });
}

export interface TraceUpdate {
  index: TraceIndex;
  /** The file grew since the previous pass — the liveness signal for `classifyRun`. */
  grew: boolean;
}

/**
 * Follow one transcript, re-indexing only the bytes appended since the last pass.
 *
 * `indexTrace` resumes from `nextOffset` and holds back a trailing partial line, so a file being
 * appended to by the investigator is safe to read at any moment (PRD-3 §10).
 */
export function pollTrace(
  path: string,
  onUpdate: (update: TraceUpdate) => void,
  intervalMs = TRACE_INTERVAL_MS,
  initial?: TraceIndex,
): Stoppable {
  let index = initial;

  return repeat(intervalMs, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const size = file.size;
    const from = index?.nextOffset ?? 0;
    if (index !== undefined && size <= from) {
      onUpdate({ index, grew: false });
      return;
    }
    index = await indexTrace(path, index);
    onUpdate({ index, grew: true });
  });
}
