import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { compile, formatDiagnostic } from './compile.js';
import type { Protocol } from './model.js';

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `Usage:
  pktspec check <protocol.yaml>

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
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'check') {
    if (rest.length !== 1) return usageError(io, 'check takes exactly one protocol file');
    const protocol = load(rest[0]!, io);
    if (!protocol) return 1;
    const counts = [
      plural(protocol.packets.length, 'packet'),
      plural(protocol.structs.length, 'struct'),
      plural(protocol.enums.length, 'enum'),
    ];
    io.out(`${rest[0]}: ok (${counts.join(', ')})`);
    return 0;
  }

  return usageError(io, `unknown command '${command}'`);
}

function load(file: string, io: Output): Protocol | undefined {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(`error: cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? error}`);
    return undefined;
  }
  const { protocol, diagnostics } = compile(source);
  for (const diagnostic of diagnostics) io.err(formatDiagnostic(file, diagnostic));
  return protocol;
}

function usageError(io: Output, message: string): number {
  io.err(`error: ${message}\n\n${USAGE}`);
  return 2;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function version(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}
