import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultJavaPackage, generateJava } from '../src/gen/java.js';
import { pascalCase } from '../src/gen/common.js';
import {
  bitMember,
  findEnum,
  findStruct,
  type Field,
  type MemberType,
  type Protocol,
} from '../src/model.js';
import { allTypes, bitFields, chatRoom } from './helpers.js';

const hasJava = spawnSync('javac', ['-version']).status === 0;
if (!hasJava && process.env.PKTSPEC_REQUIRE_JAVA) {
  throw new Error('PKTSPEC_REQUIRE_JAVA is set but javac was not found');
}

type Variant = 'max' | 'min';

const PRIMITIVE_SAMPLES: Record<string, Record<Variant, string>> = {
  u8: { max: '(short) 255', min: '(short) 0' },
  u16: { max: '65535', min: '0' },
  u32: { max: '4294967295L', min: '0L' },
  u64: { max: '-1L', min: '0L' },
  i8: { max: '(byte) 127', min: '(byte) -128' },
  i16: { max: '(short) 32767', min: '(short) -32768' },
  i32: { max: 'Integer.MAX_VALUE', min: 'Integer.MIN_VALUE' },
  i64: { max: 'Long.MAX_VALUE', min: 'Long.MIN_VALUE' },
  f32: { max: 'Float.NaN', min: '-1.5f' },
  f64: { max: 'Double.NEGATIVE_INFINITY', min: 'Math.PI' },
  bool: { max: 'true', min: 'false' },
};

/** Constructor arguments for the fields; a bit field group gives one per bit field. */
function samples(protocol: Protocol, fields: Field[], variant: Variant, depth = 0): string[] {
  return fields.flatMap((field) => {
    if (field.type.kind !== 'bits') return [sample(protocol, field.type, variant, depth)];
    return field.type.fields.map((bit) => {
      if (bit.type.kind !== 'uint') return sample(protocol, bitMember(bit).type, variant, depth);
      const value = variant === 'max' ? 2 ** bit.bits - 1 : 0;
      return bit.bits <= 8 ? `(short) ${value}` : bit.bits <= 16 ? `${value}` : `${value}L`;
    });
  });
}

/** Builds a Java expression holding an edge-case value of the given type. */
function sample(protocol: Protocol, type: MemberType, variant: Variant, depth = 0): string {
  switch (type.kind) {
    case 'primitive':
      return PRIMITIVE_SAMPLES[type.name]![variant];
    case 'string':
      return variant === 'max' ? '"\\u804a\\u5929 room \\ud83d\\ude00"' : '""';
    case 'bytes':
      return variant === 'max' ? 'new byte[] {0, (byte) 0xFF, 7}' : 'new byte[0]';
    case 'fixedBytes': {
      const bytes = Array.from({ length: type.size }, (_, i) => `(byte) ${i * 37}`);
      return variant === 'max' ? `new byte[] {${bytes.join(', ')}}` : `new byte[${type.size}]`;
    }
    case 'enum': {
      const values = findEnum(protocol, type.name).values;
      const value = variant === 'max' ? values[values.length - 1]! : values[0]!;
      return `${type.name}.${value.name}`;
    }
    case 'struct': {
      const fields = findStruct(protocol, type.name).fields;
      const args = samples(protocol, fields, variant, depth + 1);
      return `new ${type.name}(${args.join(', ')})`;
    }
    case 'array': {
      // Recursive structs stop at the second level.
      if (variant === 'min' || depth > 1) return 'new java.util.ArrayList<>()';
      const items = [0, 1, 2].map((i) =>
        sample(protocol, type.element, i === 1 ? 'min' : 'max', depth),
      );
      return `new java.util.ArrayList<>(java.util.Arrays.asList(${items.join(', ')}))`;
    }
    case 'fixedArray': {
      const items = Array.from({ length: type.size }, () =>
        sample(protocol, type.element, variant, depth),
      );
      return `new java.util.ArrayList<>(java.util.Arrays.asList(${items.join(', ')}))`;
    }
  }
}

function driver(protocol: Protocol, javaPackage: string): string {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = protocol.packets.flatMap((packet) =>
    (['max', 'min'] as const).map((variant) => {
      const args = samples(protocol, packet.fields, variant);
      const fromClient = packet.direction === 'c2s';
      return `        check(new ${packet.name}(${args.join(', ')}), ${fromClient});`;
    }),
  );
  if (protocol.name === 'bit_fields') checks.push(...bitFieldChecks());
  return `package ${javaPackage};

import java.nio.ByteBuffer;
import java.util.Arrays;

public class RoundTrip {
    public static void main(String[] args) {
${checks.join('\n')}
        System.out.println("ok");
    }

    static void check(Packet packet, boolean fromClient) {
        byte[] data = packet.encode();
        ByteBuffer buf = ByteBuffer.wrap(data).order(${entry}.BYTE_ORDER);
        Packet decoded = fromClient
                ? ${entry}.decodeFromClient(buf)
                : ${entry}.decodeFromServer(buf);
        String name = packet.getClass().getSimpleName();
        expect(!buf.hasRemaining(), name + ": trailing bytes");
        expect(packet.equals(decoded), name + ": decoded " + decoded + " but sent " + packet);
        expect(packet.hashCode() == decoded.hashCode(), name + ": hashCode differs");
        expect(Arrays.equals(data, decoded.encode()), name + ": re-encoding differs");
        expect(data.length - packet.bodySize() == ${protocol.opcode === 'u8' ? 1 : 2}, name + ": bodySize is wrong");
        System.out.println(name + " " + hex(data));
    }

    static void throwsIllegal(Runnable action, String message) {
        try {
            action.run();
        } catch (IllegalArgumentException e) {
            return;
        }
        throw new AssertionError(message + ": IllegalArgumentException was not thrown");
    }

    static String hex(byte[] data) {
        StringBuilder out = new StringBuilder();
        for (byte b : data) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }

    static void expect(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
`;
}

/** Range checks on write, unknown enum values in bits on read, and ignored unused bits. */
function bitFieldChecks(): string[] {
  const status = (level: string, low: string) =>
    `new Status((short) 0, false, Team.RED, ${level}, Mood.CALM, ${low}, false)`;
  return [
    `throwsIllegal(() -> ${status('(short) 128', '0L')}.encode(), "level too large");`,
    `throwsIllegal(() -> ${status('(short) -1', '0L')}.encode(), "level negative");`,
    `throwsIllegal(() -> ${status('(short) 0', '0x80000000L')}.encode(), "low too large");`,
    'throwsIllegal(() -> BitFieldsProtocol.decodeFromClient(new byte[] {1, 0, 0, 0, 0, 0, 0, 0}), "mood 0");',
    'throwsIllegal(() -> BitFieldsProtocol.decodeFromClient(new byte[] {1, 0, 6, 4, 0, 0, 0, 0}), "team 3");',
    `expect(${status('(short) 0', '0L')}.equals(BitFieldsProtocol.decodeFromClient(new byte[] {1, 0, 0, (byte) 0x84, 0, 0, 0, 0})), "unused bits");`,
  ].map((check) => `        ${check}`);
}

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runRoundTrip(protocol: Protocol): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-'));
  workDirs.push(dir);
  const javaPackage = defaultJavaPackage(protocol.name);
  const sources = generateJava(protocol).map((file) => ({ ...file, path: join(dir, file.path) }));
  sources.push({
    path: join(dir, javaPackage, 'RoundTrip.java'),
    content: driver(protocol, javaPackage),
  });
  for (const file of sources) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  const classes = join(dir, 'classes');
  mkdirSync(classes);
  const javac = spawnSync(
    'javac',
    ['-Xlint:all', '-Werror', '-d', classes, ...sources.map((f) => f.path)],
    { encoding: 'utf8' },
  );
  expect(javac.stderr + javac.stdout).toBe('');
  const java = spawnSync('java', ['-cp', classes, `${javaPackage}.RoundTrip`], {
    encoding: 'utf8',
  });
  expect(java.stderr).toBe('');
  const lines = java.stdout.trim().split(/\r?\n/);
  expect(lines.at(-1)).toBe('ok');
  return lines;
}

describe.skipIf(!hasJava)('Java round trip', () => {
  it('encodes and decodes every chat-room packet', () => {
    const lines = runRoundTrip(chatRoom());
    // Little-endian u16 opcode 0x0003, u32 room id, then a u16-prefixed UTF-8 string.
    expect(lines).toContain('Say 0300ffffffff1000e8818ae5a4a920726f6f6d20f09f9880');
    expect(lines).toContain('Say 0300000000000000');
  }, 60_000);

  it('packs bit fields into their integer', () => {
    const lines = runRoundTrip(bitFields());
    // Status: u8 seq, then u16 and u32 bit fields in little-endian order.
    expect(lines).toContain('Status 01fffd0fffffffff');
    expect(lines).toContain('Status 0100000400000000');
    expect(lines).toContain('Board 020305ffff00000005ffffffffffff');
  }, 60_000);

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
  }, 60_000);
});
