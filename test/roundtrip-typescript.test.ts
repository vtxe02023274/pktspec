import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pascalCase } from '../src/gen/common.js';
import { generateTypeScript } from '../src/gen/typescript.js';
import {
  INT_RANGES,
  bitMember,
  fieldMembers,
  findEnum,
  findStruct,
  type Field,
  type MemberType,
  type Protocol,
} from '../src/model.js';
import {
  allTypes,
  bitFields,
  chatRoom,
  conditionalFields,
  minimal,
  presentFields,
} from './helpers.js';

type Variant = 'max' | 'min';

const PRIMITIVE_SAMPLES: Record<string, Record<Variant, string>> = {
  u8: { max: '255', min: '0' },
  u16: { max: '65535', min: '0' },
  u32: { max: '4294967295', min: '0' },
  u64: { max: '0xffffffffffffffffn', min: '0n' },
  i8: { max: '127', min: '-128' },
  i16: { max: '32767', min: '-32768' },
  i32: { max: '2147483647', min: '-2147483648' },
  i64: { max: '9223372036854775807n', min: '-9223372036854775808n' },
  f32: { max: 'NaN', min: '-1.5' },
  f64: { max: '-Infinity', min: 'Math.PI' },
  bool: { max: 'true', min: 'false' },
};

/** Constructor arguments for the fields; a bit field group gives one per bit field. */
function samples(protocol: Protocol, fields: Field[], variant: Variant, depth = 0): string[] {
  const present = presentFields(protocol, fields, variant);
  return fields.flatMap((field) => {
    if (!present.has(field)) return fieldMembers(field).map(() => 'undefined');
    if (field.type.kind !== 'bits') return [sample(protocol, field.type, variant, depth)];
    return field.type.fields.map((bit) =>
      bit.type.kind === 'uint'
        ? String(variant === 'max' ? 2 ** bit.bits - 1 : 0)
        : sample(protocol, bitMember(bit).type, variant, depth),
    );
  });
}

/** Builds a TypeScript expression holding an edge-case value of the given type. */
function sample(protocol: Protocol, type: MemberType, variant: Variant, depth = 0): string {
  switch (type.kind) {
    case 'primitive':
      return PRIMITIVE_SAMPLES[type.name]![variant];
    case 'string':
      return variant === 'max' ? '"\\u804a\\u5929 room \\ud83d\\ude00"' : '""';
    case 'bytes':
      return variant === 'max' ? 'new Uint8Array([0, 0xff, 7])' : 'new Uint8Array(0)';
    case 'fixedBytes': {
      const bytes = Array.from({ length: type.size }, (_, i) => String((i * 37) % 256));
      return variant === 'max'
        ? `new Uint8Array([${bytes.join(', ')}])`
        : `new Uint8Array(${type.size})`;
    }
    case 'enum': {
      const values = findEnum(protocol, type.name).values;
      const value = variant === 'max' ? values[values.length - 1]! : values[0]!;
      return `(${value.value} as ${type.name})`;
    }
    case 'struct': {
      const fields = findStruct(protocol, type.name).fields;
      const args = samples(protocol, fields, variant, depth + 1);
      return `new ${type.name}(${args.join(', ')})`;
    }
    case 'array': {
      // Recursive structs stop at the second level.
      if (variant === 'min' || depth > 1) return '[]';
      const items = [0, 1, 2].map((i) =>
        sample(protocol, type.element, i === 1 ? 'min' : 'max', depth),
      );
      return `[${items.join(', ')}]`;
    }
    case 'fixedArray': {
      const items = Array.from({ length: type.size }, () =>
        sample(protocol, type.element, variant, depth),
      );
      return `[${items.join(', ')}]`;
    }
  }
}

function opcodeBytes(protocol: Protocol, value: number): string {
  const size = protocol.opcode === 'u8' ? 1 : 2;
  const bytes = Array.from({ length: size }, (_, i) => (value >> (8 * i)) & 0xff);
  if (protocol.endian === 'big') bytes.reverse();
  return bytes.map((b) => String(b)).join(', ');
}

/** Checks that a corrupt or out-of-range input raises the documented error. */
function errorChecks(protocol: Protocol): string[] {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = (['c2s', 's2c'] as const).map((direction) => {
    const used = new Set(
      protocol.packets.filter((p) => p.direction === direction).map((p) => p.opcode),
    );
    const max = INT_RANGES[protocol.opcode][1];
    let unknown = max;
    while (used.has(unknown)) unknown--;
    const method = direction === 'c2s' ? 'decodeFromClient' : 'decodeFromServer';
    return `throws(InvalidPacketError, () => ${entry}.${method}(new Uint8Array([${opcodeBytes(protocol, unknown)}])), '${direction} unknown opcode');`;
  });
  if (protocol.name === 'chat-room') {
    checks.push(
      "throws(RangeError, () => new Login('a'.repeat(256), new Uint8Array(32), 1).encode(), 'long account');",
      "throws(RangeError, () => new Login('a', new Uint8Array(31), 1).encode(), 'short hash');",
      "throws(RangeError, () => new Login('a', new Uint8Array(32), 65536).encode(), 'u16 too large');",
      "throws(RangeError, () => new Login('a', new Uint8Array(32), 1.5).encode(), 'u16 fraction');",
    );
  }
  if (protocol.name === 'all_types') {
    const numbers = (field: string, value: string): string =>
      `{ const p = ${packetSample(protocol, 'Numbers')}; p.${field} = ${value}; throws(RangeError, () => p.encode(), '${field} ${value}'); }`;
    checks.push(
      "throws(RangeError, () => new Texts('a'.repeat(256), '', '', new Uint8Array(0), new Uint8Array(4)).encode(), 'long short_text');",
      "throws(RangeError, () => new Texts('', '', '', new Uint8Array(0), new Uint8Array(3)).encode(), 'short hash');",
      "throws(RangeError, () => new Collections([], [], [true], [], [], []).encode(), 'flags count');",
      "throws(InvalidPacketError, () => AllTypesProtocol.decodeFromServer(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 5])), 'unknown enum value');",
      "throws(InvalidPacketError, () => AllTypesProtocol.decodeFromClient(new Uint8Array([2, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])), 'length over int');",
      "throws(TruncatedPacketError, () => AllTypesProtocol.decodeFromClient(new Uint8Array([2, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff])), 'length over data');",
      numbers('aU8', '256'),
      numbers('aU8', '-1'),
      numbers('aU16', '65536'),
      numbers('aU32', '4294967296'),
      numbers('aU64', '-1n'),
      numbers('aU64', '0x10000000000000000n'),
      numbers('aI8', '128'),
      numbers('aI16', '-32769'),
      numbers('aI32', '2147483648'),
      numbers('aI32', 'NaN'),
      numbers('aI64', '9223372036854775808n'),
      numbers('aI64', '1 as unknown as bigint'),
    );
    checks.push(
      "{ const p = new Texts('', '\\ud800', '', new Uint8Array(0), new Uint8Array(4)); const data = p.encode(); expect(data.length === 1 + p.bodySize(), 'lone surrogate size'); expect((AllTypesProtocol.decodeFromClient(data) as Texts).text === '\\ufffd', 'lone surrogate text'); }",
      "check(new Texts('\\ufeff', '\\ufeffabc', '', new Uint8Array(0), new Uint8Array(4)), true);",
    );
  }
  if (protocol.name === 'bit_fields') {
    const status = (field: string, value: string): string =>
      `{ const p = new Status(); p.${field} = ${value}; throws(RangeError, () => p.encode(), '${field} ${value}'); }`;
    const decode = (bytes: string) =>
      `BitFieldsProtocol.decodeFromClient(new Uint8Array([${bytes}]))`;
    checks.push(
      status('level', '128'),
      status('level', '-1'),
      status('level', '1.5'),
      status('low', '0x80000000'),
      status('team', '4 as Team'),
      status('mood', '-1 as Mood'),
      `throws(InvalidPacketError, () => ${decode('1, 0, 0, 0, 0, 0, 0, 0')}, 'mood 0');`,
      `throws(InvalidPacketError, () => ${decode('1, 0, 6, 4, 0, 0, 0, 0')}, 'team 3');`,
      `expect(new Status().equals(${decode('1, 0, 0, 0x84, 0, 0, 0, 0')}), 'unused bits');`,
    );
  }
  if (protocol.name === 'conditional_fields') {
    const polygon = 'Shape.Polygon, undefined, new Point(), []';
    checks.push(
      'check(new Draw(Shape.Circle, 1.5), true);',
      "throws(RangeError, () => new Draw(Shape.Circle).encode(), 'missing radius');",
      "throws(RangeError, () => new Draw(Shape.Point, 1.5).encode(), 'radius without Circle');",
      `throws(RangeError, () => new Draw(${polygon}, true, 7, false).encode(), 'half a bit field group');`,
      `throws(RangeError, () => new Draw(${polygon}, false, undefined, undefined, 1).encode(), 'bit field group when closed is false');`,
      "expect(new Draw().equals(ConditionalFieldsProtocol.decodeFromClient(new Uint8Array([1, 0, 9]))), 'absent fields stay undefined');",
    );
  }
  return checks.map((check) => `  ${check}`);
}

function packetSample(protocol: Protocol, name: string): string {
  const packet = protocol.packets.find((p) => p.name === name)!;
  const args = samples(protocol, packet.fields, 'max');
  return `new ${name}(${args.join(', ')})`;
}

function driver(protocol: Protocol): string {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = protocol.packets.flatMap((packet) =>
    (['max', 'min'] as const).map((variant) => {
      const args = samples(protocol, packet.fields, variant);
      const fromClient = packet.direction === 'c2s';
      return `  check(new ${packet.name}(${args.join(', ')}), ${fromClient});`;
    }),
  );
  return `import {
  InvalidPacketError,
  PacketReader,
  TruncatedPacketError,
  ${entry},
  ${[...protocol.enums.map((e) => e.name), ...protocol.structs.map((s) => s.name), ...protocol.packets.map((p) => p.name)].join(',\n  ')},
  type Packet,
} from './gen/index.js';

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function throws(type: new (...args: never[]) => Error, action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof type) {
      return;
    }
    throw new Error(message + ': expected ' + type.name + ' but got ' + String(error));
  }
  throw new Error(message + ': ' + type.name + ' was not thrown');
}

function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

function decode(data: Uint8Array | PacketReader, fromClient: boolean): Packet {
  return fromClient ? ${entry}.decodeFromClient(data) : ${entry}.decodeFromServer(data);
}

function check(packet: Packet, fromClient: boolean): void {
  const data = packet.encode();
  const reader = new PacketReader(data);
  const decoded = decode(reader, fromClient);
  const name = packet.constructor.name;
  expect(reader.remaining === 0, name + ': trailing bytes');
  expect(packet.equals(decoded), name + ': decoded ' + String(decoded) + ' but sent ' + String(packet));
  expect(hex(decoded.encode()) === hex(data), name + ': re-encoding differs');
  expect(data.length - packet.bodySize() === ${protocol.opcode === 'u8' ? 1 : 2}, name + ': bodySize is wrong');
  expect(decoded !== packet, name + ': decoded the same instance');
  expect(decoded.constructor === packet.constructor, name + ': decoded another class');
  const padded = new Uint8Array(data.length + 5);
  padded.set(data, 3);
  expect(
    packet.equals(decode(padded.subarray(3, 3 + data.length), fromClient)),
    name + ': offset view differs',
  );
  throws(TruncatedPacketError, () => decode(data.subarray(0, data.length - 1), fromClient), name + ': truncated');
  console.log(name + ' ' + hex(data));
}

${checks.join('\n')}
${errorChecks(protocol).join('\n')}
console.log('ok');
`;
}

const STRICT_OPTIONS = {
  target: 'ES2020',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  lib: ['ES2020', 'DOM'],
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noPropertyAccessFromIndexSignature: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  erasableSyntaxOnly: true,
  skipLibCheck: true,
  noEmitOnError: true,
  rootDir: '.',
  outDir: 'out',
};

const tsc = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runRoundTrip(protocol: Protocol): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-'));
  workDirs.push(dir);
  mkdirSync(join(dir, 'gen'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: STRICT_OPTIONS, include: ['gen', 'RoundTrip.ts'] }),
  );
  for (const file of generateTypeScript(protocol)) {
    writeFileSync(join(dir, 'gen', file.path), file.content);
  }
  writeFileSync(join(dir, 'RoundTrip.ts'), driver(protocol));
  const compile = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
  expect(compile.stdout + compile.stderr).toBe('');
  const run = spawnSync(process.execPath, [join(dir, 'out', 'RoundTrip.js')], {
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  const lines = run.stdout.trim().split(/\r?\n/);
  expect(lines.at(-1)).toBe('ok');
  return lines;
}

describe('TypeScript round trip', () => {
  it('encodes and decodes every chat-room packet', () => {
    const lines = runRoundTrip(chatRoom());
    // Little-endian u16 opcode 0x0003, u32 room id, then a u16-prefixed UTF-8 string.
    expect(lines).toContain('Say 0300ffffffff1000e8818ae5a4a920726f6f6d20f09f9880');
    expect(lines).toContain('Say 0300000000000000');
  }, 120_000);

  it('packs bit fields into their integer', () => {
    const lines = runRoundTrip(bitFields());
    // Status: u8 seq, then u16 and u32 bit fields in little-endian order.
    expect(lines).toContain('Status 01fffd0fffffffff');
    expect(lines).toContain('Status 0100000400000000');
    expect(lines).toContain('Board 020305ffff00000005ffffffffffff');
  }, 120_000);

  it('compiles a protocol with nothing but one packet and one field', () => {
    // No enums, structs, bit fields or conditions, and no packets from the server.
    const lines = runRoundTrip(minimal());
    expect(lines).toContain('Ping 01ff');
    expect(lines).toContain('Ping 0100');
  }, 120_000);

  it('writes conditional fields only when their condition holds', () => {
    const lines = runRoundTrip(conditionalFields());
    // Big-endian: opcode, Shape.Circle, then the f32 radius 1.5 and nothing else.
    expect(lines).toContain('Draw 01013fc00000');
    expect(lines).toContain('Draw 0100');
  }, 120_000);

  it('encodes and decodes every type in big-endian order', () => {
    const lines = runRoundTrip(allTypes());
    expect(lines).toContain(
      'Numbers 01' +
        'ff' +
        'ffff' +
        'ffffffff' +
        'ffffffffffffffff' +
        '7f' +
        '7fff' +
        '7fffffff' +
        '7fffffffffffffff' +
        '7fc00000' +
        'fff0000000000000' +
        '01',
    );
  }, 120_000);
});
