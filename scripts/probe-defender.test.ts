import { describe, expect, test } from "bun:test";

import {
  parseArgs,
  probeOutputDir,
  probeStamp,
  Recorder,
  ThrottledError,
  Transport,
} from "./probe-defender.ts";

/**
 * The half of PRD-8 AC14 that is testable without a tenant.
 *
 * The probe reads a live Microsoft Defender tenant, so everything it writes must stay inside the
 * ignored `.data/` root (PRD-8 §4.1 D10, ADR 009 §5). The other half of AC14 — that
 * `ground-truth-isolation.test.ts` still passes with the probe in scope — is asserted there rather
 * than here, because that test owns the scan.
 */
describe("probe output paths", () => {
  const stamp = probeStamp(new Date("2026-08-25T09:41:07.123Z"));

  test("the default location is inside .data/", () => {
    expect(probeOutputDir(stamp)).toBe(`.data/defender-probe/${stamp}`);
  });

  test("the stamp is filesystem-safe, sorts chronologically and names no tenant", () => {
    expect(stamp).toBe("2026-08-25T09-41-07-123");
    expect(stamp).not.toContain(":");
    expect(probeStamp(new Date("2026-08-25T09:41:08.000Z")) > stamp).toBeTrue();
  });

  test("an override inside .data/ is accepted", () => {
    expect(probeOutputDir(stamp, ".data/scratch/one")).toBe(".data/scratch/one");
    expect(probeOutputDir(stamp, ".data")).toBe(".data");
  });

  test.each([
    ["the committed corpus", "runs"],
    ["a trace directory", "runs/traces"],
    ["an escape through ..", ".data/../runs"],
    ["a sibling that merely starts with the same characters", ".database"],
    ["an absolute path outside the repository", "/tmp/defender-probe"],
  ])("%s is refused", (_label, directory) => {
    expect(() => probeOutputDir(stamp, directory)).toThrow(/must stay inside \.data/);
  });
});

/**
 * A source-text guard, in the spirit of `ground-truth-isolation.test.ts`.
 *
 * The path checks above prove `probeOutputDir` refuses the wrong directory; they cannot prove the
 * probe actually writes through it. This does: every write in the script has to be derived from
 * `outDir`, so a later addition that hard-codes a path fails here rather than on a tenant.
 */
const source = await Bun.file(new URL("./probe-defender.ts", import.meta.url)).text();

describe("the probe writes nowhere but its own output directory", () => {
  // The lookahead swallows the whitespace itself. Written as `\s*(?!…)` the greedy match simply
  // backtracks until the lookahead is trivially satisfied, and the guard never fires.
  test.each([
    ["Bun.write", /Bun\.write\((?!\s*join\(outDir,)/g],
    ["mkdir", /\bmkdir\((?!\s*outDir\b)/g],
    ["writeFile", /\bwriteFile(?:Sync)?\(/g],
  ])("no %s call escapes outDir", (_label, pattern) => {
    expect(source.match(pattern) ?? []).toEqual([]);
  });
});

/**
 * The safety property, tested rather than asserted about.
 *
 * Advanced hunting's 429 means the tenant's shared CPU allowance is spent and *every* consumer is
 * blocked until the next 15-minute cycle. Microsoft's guidance, quoted in
 * `docs/research-defender-api.md` §7, is "Avoid immediate retries, because all requests accrue
 * against your usage limits." A probe that paced through a 429 and kept going would be the exact
 * harm the whole file is arranged to avoid, so the stop is a behaviour with a test and not a
 * comment.
 */
describe("a 429 stops the probe", () => {
  test("the throttled call is recorded, the send throws, and every later send is refused", async () => {
    let served = 0;
    using server = Bun.serve({
      port: 0,
      fetch: () => {
        served += 1;
        return new Response(
          JSON.stringify({
            error: { code: "TooManyRequests", message: "Please retry again later." },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } },
        );
      },
    });

    const recorder = new Recorder();
    // No pacing: the test is about the stop, and 1.5 s of sleep would only slow it down.
    const transport = new Transport(recorder, 5_000, 0);
    const spec = {
      section: "C",
      id: "C1",
      question: "throttle probe",
      method: "GET",
      url: server.url.href,
    } as const;

    const first = await transport.send(spec).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ThrottledError);
    expect(String(first)).toContain("Retry-After: 10");

    // Recorded before the throw: the Retry-After header is the only evidence §7 Q11 asks for, and
    // aborting without keeping it would waste the one 429 the probe should ever legitimately see.
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.status).toBe(429);
    expect(recorder.calls[0]?.responseHeaders["retry-after"]).toBe("10");

    // Sticky, and it costs no further request — the point is not to accrue against the limit.
    const second = await transport.send({ ...spec, id: "C2" }).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(ThrottledError);
    expect(served).toBe(1);
    expect(recorder.calls).toHaveLength(1);
    expect(transport.throttled?.id).toBe("C1");
  });
});

/**
 * A misspelled option must not fail open.
 *
 * `--skip-table-probes` silently ignored spends 41 calls the operator asked not to spend, and a
 * mistyped `--pace-ms` silently restores the default pacing against a tenant somebody chose to be
 * gentle with. Both are one keystroke away and neither is visible in the output.
 */
describe("argument parsing", () => {
  test("known options parse", () => {
    const args = parseArgs(["--only", "A,C", "--pace-ms", "3000", "--skip-table-probe"]);
    expect([...args.sections]).toEqual(["A", "C"]);
    expect(args.paceMs).toBe(3_000);
    expect(args.skipTableProbe).toBeTrue();
  });

  test.each([
    ["a plausible misspelling of the flag", ["--skip-table-probes"]],
    ["a plausible misspelling of a value option", ["--pace", "3000"]],
    ["an unknown option entirely", ["--dry-run"]],
  ])("%s is refused rather than ignored", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/Unknown option/);
  });

  test.each([
    ["a bare positional", ["A"]],
    ["an unknown section", ["--only", "Z"]],
    ["a malformed window", ["--alert-window", "7 days"]],
    ["a non-positive pace", ["--pace-ms", "0"]],
  ])("%s is rejected before the first request", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
