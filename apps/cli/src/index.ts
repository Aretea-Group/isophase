#!/usr/bin/env bun
import rootPackageJson from "../../../package.json" with { type: "json" };
import { findCommand } from "./commands.ts";
import { commandList, describe } from "./help.ts";

/**
 * The one bin (PRD-11 §4.1 D3).
 *
 * `isophase <command> [options]`. Everything after the command name goes to that command's own
 * parser untouched — the parsers predate this file and are unchanged. What lives here is only the
 * routing: which module to load, `--help` and `--version`, and what an unknown command says.
 *
 * `--help` anywhere after a command prints that command's usage from here, before the module's
 * own `main` runs, so `help <command>` and `<command> --help` are one string by construction (AC5)
 * and neither needs the command's environment to be valid.
 */
export const PACKAGE_VERSION: string = rootPackageJson.version;

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export async function dispatch(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    console.log(commandList());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    console.log(PACKAGE_VERSION);
    return 0;
  }

  const command = findCommand(name);
  if (command === undefined) {
    console.error(
      `[isophase] Unknown command "${name}". Run \`isophase help\` to list the commands.`,
    );
    return 2;
  }

  if (wantsHelp(rest)) {
    console.log(await describe(name));
    return 0;
  }

  try {
    return await (await command.load()).run(rest);
  } catch (error) {
    console.error(`[isophase ${name}] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await dispatch(Bun.argv.slice(2));
  // The console returns 0 after `runApp` resolves but keeps its own event loop; exiting here would
  // close it. Every other command has finished by the time it returns.
  if (code !== 0) process.exit(code);
}
