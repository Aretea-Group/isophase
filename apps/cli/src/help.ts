import type { CommandModule } from "./command-module.ts";
import { COMMANDS, findCommand } from "./commands.ts";

/** The top-level listing: every command in the table, one line each (AC4). */
export function commandList(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const rows = COMMANDS.map(
    (command) => `  ${command.name.padEnd(width)}   ${command.summary}`,
  ).join("\n");
  return `isophase <command> [options]

Commands:
${rows}

  --help      this listing; after a command, that command's usage
  --version   the installed package version

Start with \`isophase init\`, which writes a .env for your tenant and prints the next command.`;
}

export const USAGE = `isophase help [command]

  With no argument, lists every command. With one, prints that command's usage — the same text
  \`isophase <command> --help\` prints.`;

/**
 * `help <command>` prints the command's own usage text, read from its module, so this and
 * `<command> --help` are one string (AC5).
 */
export async function describe(name: string): Promise<string> {
  const command = findCommand(name);
  if (command === undefined) {
    throw new Error(`Unknown command "${name}". Run \`isophase help\` to list the commands.`);
  }
  return (await command.load()).usage();
}

export const command: CommandModule = {
  usage: () => Promise.resolve(USAGE),
  run: async (argv) => {
    const [name, ...rest] = argv;
    if (name === undefined) {
      console.log(commandList());
      return 0;
    }
    if (rest.length > 0) throw new Error(`help takes one command name, got ${argv.length}.`);
    console.log(await describe(name));
    return 0;
  },
};
