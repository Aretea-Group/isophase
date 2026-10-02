/**
 * What every subcommand hands the dispatcher (PRD-11 §4.1 D3).
 *
 * `usage` is the text `help <command>` and `<command> --help` both print — one string, so the two
 * cannot disagree (AC5). `run` receives argv with the command name already removed and returns the
 * exit code; it throws for a usage error, and the dispatcher turns the throw into a message and a
 * non-zero exit.
 *
 * A type rather than a base class, because the command modules are loaded lazily: `init` and
 * `help` must work before any `.env` exists, and the investigator's `env.ts` validates at import
 * (ADR 005 §6), so the dispatcher imports a command only when it is about to run it.
 */
export interface CommandModule {
  /**
   * A function, not a string: the console's usage text embeds its environment, and its module must
   * not be imported until `run` has applied `--live`'s overlay to `process.env`. Importing it for
   * the text first would validate the wrong environment and open the wrong queue.
   */
  usage(): Promise<string>;
  run(argv: readonly string[]): Promise<number>;
}
