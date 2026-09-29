import { join } from "node:path";

/**
 * Which alerts already have a run artifact (PRD-10 §4.2 step 3).
 *
 * Read once at startup, not per cycle: the loop owns the set for its lifetime and adds to it as
 * runs complete. Half of D10's "no cursor, no watermark file" claim rests on this — the other half
 * being the sliding window — because an artifact that already exists is state the system kept
 * without anyone designing a store for it.
 *
 * Reads the same non-recursive `*.json` glob the console does (`data/runs.ts`), so `runs/.archive/`
 * is *not* seen: an archived run has been deliberately taken out of the queue, and `queue:reset`
 * exists to put its alert back. An unreadable or half-written artifact is skipped rather than
 * fatal — one bad file must not stop the loop from seeing the other four hundred.
 */
export async function readSeenAlertIds(runsDir: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const glob = new Bun.Glob("*.json");

  /**
   * The whole scan is guarded, not just `glob.scan()`.
   *
   * `scan` returns an async iterable and does no work; the `ENOENT` for a missing directory is
   * thrown when it is *iterated*. Guarding only the call left a fresh clone — or any run pointed at
   * a `RUNS_DIR` that does not exist yet — crashing on startup before the first poll, which a smoke
   * test found and no unit test would have.
   */
  try {
    for await (const name of glob.scan({ cwd: runsDir })) {
      try {
        const parsed = (await Bun.file(join(runsDir, name)).json()) as {
          results?: { alertId?: string }[];
          plannedAlerts?: { alertId?: string }[];
        };
        // Planned alerts count as seen alongside finished ones: a run interrupted before reaching
        // an alert still claimed it, and re-investigating it would duplicate the spend that
        // `queue:reset` exists to make deliberate.
        for (const entry of [...(parsed.results ?? []), ...(parsed.plannedAlerts ?? [])]) {
          if (entry.alertId !== undefined) seen.add(entry.alertId);
        }
      } catch {
        // Unreadable or partially written; not selectable, not fatal.
      }
    }
  } catch {
    // No runs directory yet. A first run against a fresh clone is not an error.
  }

  return seen;
}
