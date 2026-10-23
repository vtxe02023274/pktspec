import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { compile, formatDiagnostic } from './compile.js';
import type { GeneratedFile } from './gen/common.js';
import { generateCSharp } from './gen/csharp.js';
import { generateDocs } from './gen/docs.js';
import { generateJava } from './gen/java.js';
import { generateTypeScript } from './gen/typescript.js';
import type { Protocol } from './model.js';

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `Usage:
  pktspec check <protocol.yaml>
  pktspec gen <target> <protocol.yaml> -o <dir> [options]

Targets:
  java        Java classes using java.nio.ByteBuffer
  csharp      C# classes for .NET Standard 2.1 (Unity and .NET)
  typescript  TypeScript classes for browsers and Node.js
  docs        Markdown reference

Options:
  -o, --out <dir>        output directory (required for gen)
      --package <name>   Java package (default: derived from the protocol name)
      --namespace <name> C# namespace (default: derived from the protocol name)
  -h, --help             show this help
  -v, --version          show the version`;

interface GenerateOptions {
  package?: string;
  namespace?: string;
}

const GENERATORS: Record<
  string,
  (protocol: Protocol, options: GenerateOptions) => GeneratedFile[]
> = {
  java: (protocol, options) => generateJava(protocol, { package: options.package }),
  csharp: (protocol, options) => generateCSharp(protocol, { namespace: options.namespace }),
  typescript: (protocol) => generateTypeScript(protocol),
  docs: (protocol) => generateDocs(protocol),
};

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
        out: { type: 'string', short: 'o' },
        package: { type: 'string' },
        namespace: { type: 'string' },
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

  if (command === 'gen') {
    const [target, file] = rest;
    if (rest.length !== 2 || target === undefined || file === undefined) {
      return usageError(io, 'gen takes a target and one protocol file');
    }
    const generate = GENERATORS[target];
    if (!generate) {
      return usageError(
        io,
        `unknown target '${target}'; expected one of: ${Object.keys(GENERATORS).join(', ')}`,
      );
    }
    if (!values.out) return usageError(io, 'gen requires --out <dir>');
    const protocol = load(file, io);
    if (!protocol) return 1;
    let files;
    try {
      files = generate(protocol, { package: values.package, namespace: values.namespace });
    } catch (error) {
      io.err(`error: ${(error as Error).message}`);
      return 1;
    }
    for (const generated of files) {
      const path = join(values.out, generated.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, generated.content);
    }
    io.out(`wrote ${plural(files.length, 'file')} to ${values.out}`);
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
