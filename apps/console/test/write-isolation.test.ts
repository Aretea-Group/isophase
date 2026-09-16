import { describe, expect, test } from "bun:test";

/**
 * What the console may do, checked by scanning rather than by trust (PRD-5 §14, PRD-9 §4.1 D6).
 *
 * PRD-3's guarantee was "read-only". PRD-5 narrowed it to "no write primitive except in `drive/**`"
 * when the console gained analyst-feedback capture. PRD-9 removed that capture, and with it the
 * only thing in `apps/console/src` that wrote to disk — so the claim returns to its stronger form,
 * with no seam to except:
 *
 *   `apps/console/src` contains no filesystem write primitive at all, and no network primitive
 *   except in `data/alerts.ts`.
 *
 * These pass against the console as it stands and go red on the first write anyone adds — which is
 * the point. A write then has to be argued for in a diff rather than slipped into an existing seam.
 */

const ROOT = "apps/console/src";

/** Excluded per-pattern, never globally: this is the one file allowed to reach the network. */
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

  test("no filesystem write primitive anywhere in console source", () => {
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
      .filter((file) => patterns.some((pattern) => pattern.test(file.code)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  test("the drive/ write seam is gone, not merely unused", () => {
    // PRD-9 AC1. An empty `drive/` left on disk would let the next write land back in a directory
    // this file used to exempt, without the exemption ever reappearing in a diff.
    expect(files.filter((file) => file.path.includes("/drive/")).map((file) => file.path)).toEqual(
      [],
    );
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
    // `SecurityDataSource` also exposes query and schema access. Handing `data/` the whole source
    // would compile ad-hoc security queries into the console, which PRD-3 §14 excludes by name.
    const alerts = files.find((file) => file.path.includes(NETWORK_SEAM));
    expect(alerts).toBeDefined();
    expect(alerts?.raw).toContain('Pick<SecurityDataSource, "listAlerts" | "getAlert">');
    expect(alerts?.code).not.toContain(".query(");
  });
});
