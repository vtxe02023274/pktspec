import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { compile, formatDiagnostic } from './compile.js';
import { diffProtocols, diffReport, formatDiff, type Spec } from './diff.js';
import { FUZZ_DEFAULTS, generateFuzz } from './fuzz.js';
import type { GeneratedFile } from './gen/common.js';
import { generateCpp } from './gen/cpp.js';
import { generateCSharp } from './gen/csharp.js';
import { generateDocs } from './gen/docs.js';
import { generateJava } from './gen/java.js';
import { generateTypeScript } from './gen/typescript.js';
import { generateWireshark } from './gen/wireshark.js';
import type { Protocol } from './model.js';

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `Usage:
  pktspec check <protocol.yaml>
  pktspec diff <old.yaml> <new.yaml> [--format text|json]
  pktspec gen <target> <protocol.yaml> -o <dir> [options]
  pktspec fuzz <protocol.yaml> -o <dir> [options]

Targets:
  java        Java classes using java.nio.ByteBuffer
  csharp      C# classes for .NET Standard 2.1 (Unity and .NET)
  typescript  TypeScript classes for browsers and Node.js
  cpp         C++17 headers using only the standard library
  wireshark   Wireshark Lua dissector
  docs        Markdown reference

Options:
  -o, --out <dir>        output directory (required for gen)
      --package <name>   Java package (default: derived from the protocol name)
      --namespace <name> C# or C++ namespace (default: derived from the protocol name)
      --port <number>    wireshark: default TCP, UDP and server port (default: none)
      --format <format>  diff output: text (default) or json
      --seed <number>    fuzz: seed of the random samples, 0 to 4294967295 (default: ${FUZZ_DEFAULTS.seed})
      --count <number>   fuzz: random valid samples per packet (default: ${FUZZ_DEFAULTS.count})
      --max-size <bytes> fuzz: largest sample, opcode included (default: ${FUZZ_DEFAULTS.maxSize})
      --max-samples <n>  fuzz: stop after n samples in total (default: no limit)
  -h, --help             show this help
  -v, --version          show the version`;

interface GenerateOptions {
  package?: string;
  namespace?: string;
  port?: number;
}

const GENERATORS: Record<
  string,
  (protocol: Protocol, options: GenerateOptions) => GeneratedFile[]
> = {
  java: (protocol, options) => generateJava(protocol, { package: options.package }),
  csharp: (protocol, options) => generateCSharp(protocol, { namespace: options.namespace }),
  typescript: (protocol) => generateTypeScript(protocol),
  cpp: (protocol, options) => generateCpp(protocol, { namespace: options.namespace }),
  wireshark: (protocol, options) => generateWireshark(protocol, { port: options.port }),
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
        port: { type: 'string' },
        format: { type: 'string' },
        seed: { type: 'string' },
        count: { type: 'string' },
        'max-size': { type: 'string' },
        'max-samples': { type: 'string' },
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

  if (command === 'diff') {
    if (rest.length !== 2) return usageError(io, 'diff takes an old and a new protocol file');
    const format = values.format ?? 'text';
    if (format !== 'text' && format !== 'json') {
      return usageError(io, `unknown format '${format}'; expected text or json`);
    }
    // Both files are loaded before returning so that every error is reported at once.
    const before = loadSpec(rest[0]!, io);
    const after = loadSpec(rest[1]!, io);
    if (!before || !after) return 1;
    const changes = diffProtocols(before, after);
    if (format === 'json') {
      io.out(JSON.stringify(diffReport(rest[0]!, rest[1]!, changes), null, 2));
    } else {
      for (const line of formatDiff(rest[0]!, rest[1]!, changes)) io.out(line);
    }
    return changes.some((change) => change.severity === 'breaking') ? 1 : 0;
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
    let port: number | undefined;
    if (values.port !== undefined) {
      port = /^[0-9]+$/.test(values.port) ? Number(values.port) : NaN;
      if (!(port >= 1 && port <= 65535)) {
        return usageError(io, `'${values.port}' is not a valid port; expected 1 to 65535`);
      }
    }
    const protocol = load(file, io);
    if (!protocol) return 1;
    let files;
    try {
      files = generate(protocol, { package: values.package, namespace: values.namespace, port });
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

  if (command === 'fuzz') {
    if (rest.length !== 1) return usageError(io, 'fuzz takes exactly one protocol file');
    if (!values.out) return usageError(io, 'fuzz requires --out <dir>');
    const numbers = {
      seed: integer(values.seed, 'seed', 0, 0xffffffff),
      count: integer(values.count, 'count', 0, 100000),
      maxSize: integer(values['max-size'], 'max-size', 1, 0x7fffffff),
      maxSamples: integer(values['max-samples'], 'max-samples', 1, 0x7fffffff),
    };
    for (const result of Object.values(numbers)) {
      if (result.error) return usageError(io, result.error);
    }
    const protocol = load(rest[0]!, io);
    if (!protocol) return 1;
    const corpus = generateFuzz(protocol, {
      seed: numbers.seed.value,
      count: numbers.count.value,
      maxSize: numbers.maxSize.value,
      maxSamples: numbers.maxSamples.value,
    });
    // A manifest means an earlier run; drop its samples so stale files cannot mix in.
    if (existsSync(join(values.out, 'manifest.json'))) {
      rmSync(join(values.out, 'valid'), { recursive: true, force: true });
      rmSync(join(values.out, 'invalid'), { recursive: true, force: true });
    }
    for (const sample of corpus.samples) {
      const path = join(values.out, sample.file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, sample.data);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(
      join(values.out, 'manifest.json'),
      JSON.stringify(corpus.manifest, null, 2) + '\n',
    );
    const valid = corpus.samples.filter((sample) => sample.valid).length;
    io.out(
      `wrote ${plural(corpus.samples.length, 'sample')} (${valid} valid, ${corpus.samples.length - valid} invalid) to ${values.out}`,
    );
    const { tooLarge, overLimit } = corpus.manifest.skipped;
    if (tooLarge > 0)
      io.err(`note: ${plural(tooLarge, 'sample')} left out for exceeding --max-size`);
    if (overLimit > 0) io.err(`note: ${plural(overLimit, 'sample')} left out by --max-samples`);
    return 0;
  }

  return usageError(io, `unknown command '${command}'`);
}

/** Parses an optional decimal option into a value or an error message. */
function integer(
  text: string | undefined,
  name: string,
  min: number,
  max: number,
): { value?: number; error?: string } {
  if (text === undefined) return {};
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) {
    return { error: `'${text}' is not a valid --${name}; expected ${min} to ${max}` };
  }
  return { value };
}

function load(file: string, io: Output): Protocol | undefined {
  return loadSpec(file, io)?.protocol;
}

function loadSpec(file: string, io: Output): Spec | undefined {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(`error: cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? error}`);
    return undefined;
  }
  const { protocol, locations, diagnostics } = compile(source);
  for (const diagnostic of diagnostics) io.err(formatDiagnostic(file, diagnostic));
  return protocol && locations ? { protocol, locations } : undefined;
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
