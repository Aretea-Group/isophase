/**
 * Locates the vendored Training Lab telemetry.
 *
 * The CSVs are committed rather than downloaded at bootstrap (see
 * `fixtures/telemetry/SOURCE.md`), so this resolves a repository path rather
 * than fetching anything.
 */

/** Absolute path to `fixtures/telemetry/`, resolved from this module. */
export const TELEMETRY_DIR = new URL("../../../../fixtures/telemetry/", import.meta.url).pathname;

/** Reads one vendored file by its manifest-relative path, e.g. `BuildIn/SecurityEvents.csv`. */
export async function readTelemetryFile(relativePath: string): Promise<string> {
  const file = Bun.file(`${TELEMETRY_DIR}${relativePath}`);
  if (!(await file.exists())) {
    throw new Error(
      `Vendored telemetry missing: ${relativePath}\n` +
        `Expected under ${TELEMETRY_DIR} — see fixtures/telemetry/SOURCE.md for how to restore it.`,
    );
  }
  return file.text();
}
