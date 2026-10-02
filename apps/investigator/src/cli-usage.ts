/**
 * The investigator's usage text, in a module of its own.
 *
 * `index.ts` imports `env.ts`, which validates the environment at import (ADR 005 §6). The
 * dispatcher's `help investigate` must print this without that validation running — help is the
 * one command that has to work before `.env` is right — so the text lives where importing it
 * reads nothing (PRD-11 §4.1 D3).
 */
export const USAGE = `isophase investigate [--alert <id>] [--watch]

  --alert <id>   investigate one alert by its id instead of sweeping every new one
  --watch        run unattended: poll the primary source, investigate what is new, and
                 listen for a console on WATCH_CONTROL_SOCKET
  --help         this message

Reads .env in the working directory: the selected source, its credentials, the model and a
provider key. Writes one run artifact per sweep under RUNS_DIR.`;
