import { describe, expect, test } from "bun:test";

/**
 * What the console may do, checked by scanning rather than by trust (PRD-5 §14).
 *
 * PRD-3's guarantee was "read-only", which a scan could confirm by finding no write primitive
 * anywhere. PRD-5 gives the console a write path, so the replacement is narrower and stronger than
 * "it only writes through the investigator" — no source scan can reason about which *path* a write
 * targets, but it can reason about which *directory* the primitive lives in:
 *
 *   `apps/console/src` contains no filesystem write primitive except in `drive/**`, and no network
 *   primitive except in `data/alerts.ts`.
 *
 * These pass against the console as it stands and go red on the first write anyone adds outside the
 * seam — which is the point. The seam then has to be named in a diff rather than assumed.
 */

const ROOT = "apps/console/src";

/** Excluded per-pattern, never globally: these are the two files allowed to do each thing. */
const WRITE_SEAM = "/drive/";
const NETWORK_SEAM = "/data/alerts.ts";

interface SourceFile {
  path: string;
  raw: string;
  code: string;
}

/**
 * Comments and string literals stripped.
 *
 * A call-shape scan must not fire on prose describing the pattern it forbids, or this file could
 * not document itself — and `ui/panes/main.ts` contains a template literal with `fetch(` in it.
 * Import checks still run against raw text, where a name in a comment is still worth catching.
 */
function stripNonCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''");
}

const files: SourceFile[] = await Promise.all(
  Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: ROOT })).map(async (name) => {
    const path = `${ROOT}/${name}`;
    const raw = await Bun.file(path).text();
    return { path: `/${name}`, raw, code: stripNonCode(raw) };
  }),
);

describe("console write isolation", () => {
  test("the scan covers a non-trivial number of files", () => {
    // Guards the guard: a glob that matched nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(10);
  });

  test("no filesystem write primitive outside drive/", () => {
    const patterns = [
      /Bun\.write\s*\(/,
      /\bwriteFile(?:Sync)?\s*\(/,
      /\bappendFile(?:Sync)?\s*\(/,
      /\bmkdir(?:Sync)?\s*\(/,
      /\brename(?:Sync)?\s*\(/,
      /\brm(?:Sync)?\s*\(/,
      /\bunlink(?:Sync)?\s*\(/,
    ];
    const offenders = files
      .filter((file) => !file.path.includes(WRITE_SEAM))
      .filter((file) => patterns.some((pattern) => pattern.test(file.code)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("no subprocess spawn anywhere", () => {
    // Not seam-excluded: PRD-5 executes in-process, so nothing in the console spawns at all.
    const patterns = [/Bun\.spawn/, /\bspawn(?:Sync)?\s*\(/, /\bexecFile\s*\(/, /child_process/];
    const offenders = files
      .filter((file) => patterns.some((pattern) => pattern.test(file.code)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("no network primitive outside data/alerts.ts", () => {
    const patterns = [/(?<![.\w])fetch\s*\(/, /new WebSocket/, /XMLHttpRequest/];
    const offenders = files
      .filter((file) => !file.path.includes(NETWORK_SEAM))
      .filter((file) => patterns.some((pattern) => pattern.test(file.code)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("nothing writes under runs/", () => {
    // The investigator remains the sole writer of run artifacts and transcripts. `drive/` is the
    // one directory that can write at all, so it is the one directory this has to hold for.
    // Against code, not prose: `drive/feedback.ts` explains at length *why* it writes outside
    // `runs/`, and a raw-text scan would flag the documentation of the rule it enforces.
    const seam = files.filter((file) => file.path.includes(WRITE_SEAM));
    expect(seam.length).toBeGreaterThan(0);
    const offenders = seam.filter((file) => /runs\//.test(file.code)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("no provider credential is named in console source", () => {
    const patterns = [/OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /GOOGLE_/, /GEMINI_API_KEY/];
    const offenders = files
      .filter((file) => patterns.some((pattern) => pattern.test(file.raw)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("the console reaches the investigator only through the control surface", () => {
    /**
     * PRD-5 §5.5 lists `control.ts` as the console-facing export, and this keeps it that way.
     *
     * An earlier cut had `index.ts` importing `BraveSearchClient` and `HttpWebFetchClient` to hand
     * to the control — which quietly made the console the thing that constructs the *agent's own
     * tool clients*. That is a much wider seam than "the console can start a run", and it is the
     * kind of widening that happens one convenient import at a time rather than in a decision.
     */
    const imports = files.flatMap((file) =>
      [...file.raw.matchAll(/from\s+"(@soc\/investigator[^"]*)"/g)].map((match) => ({
        path: file.path,
        specifier: match[1] ?? "",
      })),
    );
    expect(imports.length).toBeGreaterThan(0);
    // `./model` is permitted for the `ModelChoice` type alone — it is erased at build time and
    // carries no runtime dependency. Anything else must go through the control surface.
    const allowed = new Set(["@soc/investigator/control", "@soc/investigator/model"]);
    const wrong = imports.filter((entry) => !allowed.has(entry.specifier));
    expect(wrong).toEqual([]);
  });

  test("the alert reader is narrowed to two methods", () => {
    // `SentinelClient` also exposes `query(kql)` and `getSchema()`. Handing `data/` the whole
    // client would compile ad-hoc KQL into the console, which PRD-3 §14 excludes by name.
    const alerts = files.find((file) => file.path.includes(NETWORK_SEAM));
    expect(alerts).toBeDefined();
    expect(alerts?.raw).toContain('Pick<SentinelClient, "listAlerts" | "getAlert">');
    expect(alerts?.code).not.toContain(".query(");
  });
});
