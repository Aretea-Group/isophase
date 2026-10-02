import type { CommandModule } from "./command-module.ts";

/**
 * The command table (PRD-11 §4.1 D3, §4.3).
 *
 * One table drives both dispatch and `help`, so the two cannot disagree: a command that is not here
 * cannot run, and one that is here is listed. Modules load lazily — `init` and `help` have to work
 * before any `.env` exists, and the investigator validates its environment at import.
 */
export interface CommandSpec {
  readonly name: string;
  /** One line for the command list. */
  readonly summary: string;
  readonly load: () => Promise<CommandModule>;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "write a .env and the working directories for a Defender or Sentinel tenant",
    load: async () => (await import("./init.ts")).command,
  },
  {
    name: "investigate",
    summary: "investigate one alert, or run the unattended loop with --watch",
    load: () =>
      Promise.resolve({
        usage: async () => (await import("@soc/investigator/cli-usage")).USAGE,
        run: async (argv) => (await import("@soc/investigator")).runCli(argv),
      }),
  },
  {
    name: "console",
    summary: "open the operator console; --live <source> points it at a real tenant",
    load: () =>
      Promise.resolve({
        usage: async () => (await import("@soc/console")).USAGE,
        run: async (argv) => {
          // The overlay goes into the environment before the console is imported: its `env.ts`
          // reads `process.env` at import, which is why this cannot be a flag the console parses —
          // and why `usage` above is a function and not a string read at load time.
          const { planLaunch } = await import("./live.ts");
          const plan = planLaunch(argv);
          Object.assign(process.env, plan.env);
          return (await import("@soc/console")).runCli(plan.consoleArgs);
        },
      }),
  },
  {
    name: "probe",
    summary: "check a Defender credential's consent and record what the tenant supports",
    load: async () => (await import("./probe.ts")).command,
  },
  {
    name: "help",
    summary: "list the commands, or describe one: help <command>",
    load: async () => (await import("./help.ts")).command,
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
