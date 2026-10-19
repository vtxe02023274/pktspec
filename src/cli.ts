import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `Usage:
  pktspec <command> [options]

Options:
  -h, --help             show this help
  -v, --version          show the version`;

const stdio: Output = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

/** Runs the command line and returns the process exit code. */
export function main(argv: string[], io: Output = stdio): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.err(`error: ${(error as Error).message}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(version());
    return 0;
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  return usageError(io, `unknown command '${command}'`);
}

function usageError(io: Output, message: string): number {
  io.err(`error: ${message}\n\n${USAGE}`);
  return 2;
}

function version(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}
