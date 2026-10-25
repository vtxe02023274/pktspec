import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { pascalCase } from '../src/gen/common.js';
import { defaultCppNamespace, generateCpp } from '../src/gen/cpp.js';
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
import { allTypes, bitFields, chatRoom, conditionalFields, presentFields } from './helpers.js';

interface Compiler {
  command: string;
  msvc: boolean;
}

/** Looks for a C++17 compiler: $CXX first, then the usual names on the PATH. */
function findCompiler(): Compiler | undefined {
  const names = [process.env.CXX, 'g++', 'clang++', 'c++', 'cl'].filter(
    (name): name is string => !!name,
  );
  for (const command of names) {
    const msvc = /(^|[\\/])cl(\.exe)?$/i.test(command);
    const probe = spawnSync(command, msvc ? [] : ['--version'], { encoding: 'utf8' });
    if (probe.error === undefined && (msvc ? /Microsoft/.test(probe.stderr) : probe.status === 0)) {
      return { command, msvc };
    }
  }
  return undefined;
}

const compiler = findCompiler();
if (!compiler && process.env.PKTSPEC_REQUIRE_CPP) {
  throw new Error(
    'PKTSPEC_REQUIRE_CPP is set but no C++ compiler (CXX, g++, clang++, cl) was found',
  );
}

type Variant = 'max' | 'min';

const PRIMITIVE_SAMPLES: Record<string, Record<Variant, string>> = {
  u8: { max: 'static_cast<std::uint8_t>(255)', min: 'static_cast<std::uint8_t>(0)' },
  u16: { max: 'static_cast<std::uint16_t>(65535)', min: 'static_cast<std::uint16_t>(0)' },
  u32: { max: '4294967295u', min: '0u' },
  u64: { max: 'std::numeric_limits<std::uint64_t>::max()', min: 'std::uint64_t{0}' },
  i8: { max: 'static_cast<std::int8_t>(127)', min: 'static_cast<std::int8_t>(-128)' },
  i16: { max: 'static_cast<std::int16_t>(32767)', min: 'static_cast<std::int16_t>(-32768)' },
  i32: {
    max: 'std::numeric_limits<std::int32_t>::max()',
    min: 'std::numeric_limits<std::int32_t>::min()',
  },
  i64: {
    max: 'std::numeric_limits<std::int64_t>::max()',
    min: 'std::numeric_limits<std::int64_t>::min()',
  },
  // A NaN with a payload would survive the round trip bit for bit, so the standard one is used.
  f32: { max: 'f32FromBits(0x7fc00000u)', min: '-1.5f' },
  f64: { max: '-std::numeric_limits<double>::infinity()', min: '3.141592653589793' },
  bool: { max: 'true', min: 'false' },
};

/** The C++ type a field has in the generated code. */
function cppType(type: MemberType): string {
  switch (type.kind) {
    case 'primitive':
      return {
        u8: 'std::uint8_t',
        u16: 'std::uint16_t',
        u32: 'std::uint32_t',
        u64: 'std::uint64_t',
        i8: 'std::int8_t',
        i16: 'std::int16_t',
        i32: 'std::int32_t',
        i64: 'std::int64_t',
        f32: 'float',
        f64: 'double',
        bool: 'bool',
      }[type.name];
    case 'string':
      return 'std::string';
    case 'bytes':
      return 'std::vector<std::uint8_t>';
    case 'fixedBytes':
      return `std::array<std::uint8_t, ${type.size}>`;
    case 'struct':
    case 'enum':
      return type.name;
    case 'array':
      return `std::vector<${cppType(type.element)}>`;
    case 'fixedArray':
      return `std::array<${cppType(type.element)}, ${type.size}>`;
  }
}

/** Spells a string as a C++ literal of UTF-8 bytes, all in octal escapes. */
function cppBytes(text: string): string {
  const escapes = Array.from(
    Buffer.from(text, 'utf8'),
    (b) => '\\' + b.toString(8).padStart(3, '0'),
  );
  return `std::string("${escapes.join('')}")`;
}

/** Constructor arguments for the fields; a bit field group gives one per bit field. */
function samples(protocol: Protocol, fields: Field[], variant: Variant, depth = 0): string[] {
  const present = presentFields(protocol, fields, variant);
  return fields.flatMap((field) => {
    if (!present.has(field)) return fieldMembers(field).map(() => 'std::nullopt');
    if (field.type.kind !== 'bits') return [sample(protocol, field.type, variant, depth)];
    return field.type.fields.map((bit) => {
      const member = bitMember(bit).type;
      if (bit.type.kind !== 'uint') return sample(protocol, member, variant, depth);
      const value = variant === 'max' ? 2 ** bit.bits - 1 : 0;
      return `static_cast<${cppType(member)}>(${value}u)`;
    });
  });
}

/** Builds a C++ expression holding an edge-case value of the given type. */
function sample(protocol: Protocol, type: MemberType, variant: Variant, depth = 0): string {
  switch (type.kind) {
    case 'primitive':
      return PRIMITIVE_SAMPLES[type.name]![variant];
    case 'string':
      return variant === 'max' ? cppBytes('聊天 room \u{1f600}') : 'std::string()';
    case 'bytes':
      return variant === 'max'
        ? 'std::vector<std::uint8_t>{0, 0xFF, 7}'
        : 'std::vector<std::uint8_t>()';
    case 'fixedBytes': {
      const bytes = Array.from({ length: type.size }, (_, i) => String((i * 37) % 256));
      return variant === 'max' ? `${cppType(type)}{{${bytes.join(', ')}}}` : `${cppType(type)}{}`;
    }
    case 'enum': {
      const base = findEnum(protocol, type.name);
      const values = base.values;
      const value = (variant === 'max' ? values[values.length - 1]! : values[0]!).value;
      const literal =
        value === -0x80000000
          ? '(-2147483647 - 1)'
          : base.type === 'u32'
            ? `${value}u`
            : String(value);
      return `static_cast<${type.name}>(${literal})`;
    }
    case 'struct': {
      const fields = findStruct(protocol, type.name).fields;
      const args = samples(protocol, fields, variant, depth + 1);
      return `${type.name}(${args.join(', ')})`;
    }
    case 'array': {
      // Recursive structs stop at the second level.
      if (variant === 'min' || depth > 1) return `${cppType(type)}()`;
      const items = [0, 1, 2].map((i) =>
        sample(protocol, type.element, i === 1 ? 'min' : 'max', depth),
      );
      return `${cppType(type)}{${items.join(', ')}}`;
    }
    case 'fixedArray': {
      const items = Array.from({ length: type.size }, () =>
        sample(protocol, type.element, variant, depth),
      );
      return `${cppType(type)}{{${items.join(', ')}}}`;
    }
  }
}

function opcodeBytes(protocol: Protocol, value: number): string {
  const size = protocol.opcode === 'u8' ? 1 : 2;
  const bytes = Array.from({ length: size }, (_, i) => (value >> (8 * i)) & 0xff);
  if (protocol.endian === 'big') bytes.reverse();
  return bytes.map((b) => String(b)).join(', ');
}

/** Checks that a corrupt or out-of-range input raises the documented exception. */
function errorChecks(protocol: Protocol): string[] {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = (['c2s', 's2c'] as const).flatMap((direction) => {
    const used = new Set(
      protocol.packets.filter((p) => p.direction === direction).map((p) => p.opcode),
    );
    const max = INT_RANGES[protocol.opcode][1];
    let unknown = max;
    while (used.has(unknown)) unknown--;
    const method = direction === 'c2s' ? 'decodeFromClient' : 'decodeFromServer';
    return [
      `throwsAs<UnknownOpcodeError>([] { ${entry}::${method}(bytes({ ${opcodeBytes(protocol, unknown)} })); }, "${direction} unknown opcode");`,
      `throwsAs<InvalidPacketError>([] { ${entry}::${method}(bytes({ ${opcodeBytes(protocol, unknown)} })); }, "${direction} unknown opcode is invalid data");`,
      `expect(unknownOpcode([] { ${entry}::${method}(bytes({ ${opcodeBytes(protocol, unknown)} })); }) == ${unknown}u, "${direction} unknown opcode value");`,
    ];
  });
  checks.push(
    'throwsAs<PacketRangeError>([] { PacketWriter w; w.writeLength(0x100, 1); }, "1-byte prefix");',
    'throwsAs<PacketRangeError>([] { PacketWriter w; w.writeLength(0x10000, 2); }, "2-byte prefix");',
    'throwsAs<TruncatedPacketError>([] { PacketReader r(nullptr, 0); r.readU8(); }, "empty reader");',
  );
  if (protocol.name === 'chat-room') {
    checks.push(
      'throwsAs<PacketRangeError>([] { Login(std::string(256, \'a\'), std::array<std::uint8_t, 32>{}, 1).encode(); }, "long account");',
      'throwsAs<TruncatedPacketError>([] { ChatRoomProtocol::decodeFromClient(bytes({ 1, 0, 255 })); }, "length past the data");',
      'throwsAs<UnknownEnumValueError>([] { ChatRoomProtocol::decodeFromServer(bytes({ 1, 0, 9 })); }, "unknown enum value");',
    );
  }
  if (protocol.name === 'all_types') {
    checks.push(
      'throwsAs<PacketRangeError>([] { Texts(std::string(256, \'a\'), "", "", std::vector<std::uint8_t>(), std::array<std::uint8_t, 4>{}).encode(); }, "long short_text");',
      'throwsAs<PacketRangeError>([] { Nested(Point(), Node("", std::vector<Node>(256)), static_cast<Small>(0), static_cast<Wide>(0u), Empty()).encode(); }, "too many children");',
      'throwsAs<UnknownEnumValueError>([] { AllTypesProtocol::decodeFromServer(bytes({ 3, 0, 0, 0, 0, 0, 0, 5 })); }, "unknown enum value");',
      'throwsAs<InvalidPacketError>([] { AllTypesProtocol::decodeFromClient(bytes({ 2, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF })); }, "length over 2^31 - 1");',
      'throwsAs<TruncatedPacketError>([] { AllTypesProtocol::decodeFromClient(bytes({ 2, 0, 0, 0, 0x7F, 0xFF, 0xFF, 0xFF })); }, "huge length past the data");',
      'throwsAs<TruncatedPacketError>([] { AllTypesProtocol::decodeFromServer(bytes({ 2, 0xFF, 0xFF })); }, "huge count past the data");',
    );
  }
  if (protocol.name === 'bit_fields') {
    const status = (field: string, value: string) =>
      `throwsAs<PacketRangeError>([] { Status p; p.${field} = ${value}; p.encode(); }, "${field} ${value}");`;
    const decode = (bytes: string) => `BitFieldsProtocol::decodeFromClient(bytes({ ${bytes} }))`;
    checks.push(
      status('level', '128'),
      status('low', '0x80000000u'),
      status('team', 'static_cast<Team>(4)'),
      status('mood', 'static_cast<Mood>(-1)'),
      `throwsAs<UnknownEnumValueError>([] { ${decode('1, 0, 0, 0, 0, 0, 0, 0')}; }, "mood 0");`,
      `throwsAs<UnknownEnumValueError>([] { ${decode('1, 0, 6, 4, 0, 0, 0, 0')}; }, "team 3");`,
      `expect(static_cast<const Status&>(*${decode('1, 0, 0, 0x84, 0, 0, 0, 0')}) == Status(), "unused bits");`,
    );
  }
  if (protocol.name === 'mutual') {
    checks.push(
      'throwsAs<PacketRangeError>([] { Shadow p; p.signed_ = static_cast<Signed>(-1); p.encode(); }, "negative enum in 32 bits");',
    );
  }
  if (protocol.name === 'conditional_fields') {
    const draw = (setup: string) => `[] { Draw p; ${setup} p.encode(); }`;
    const polygon = 'p.shape = Shape::Polygon; p.corner = Point(); p.points.emplace();';
    checks.push(
      'check<Draw>("Draw", [] { Draw p; p.shape = Shape::Circle; p.radius = 1.5f; return p; }(), true);',
      `throwsAs<PacketRangeError>(${draw('p.shape = Shape::Circle;')}, "missing radius");`,
      `throwsAs<PacketRangeError>(${draw('p.radius = 1.5f;')}, "radius without Circle");`,
      `throwsAs<PacketRangeError>(${draw(`${polygon} p.closed = true; p.fill = 7u; p.dashed = false;`)}, "half a bit field group");`,
      `throwsAs<PacketRangeError>(${draw(`${polygon} p.closed = false; p.width = static_cast<std::uint8_t>(1);`)}, "bit field group when closed is false");`,
      'expect(static_cast<const Draw&>(*ConditionalFieldsProtocol::decodeFromClient(bytes({ 1, 0, 9 }))) == Draw(), "absent fields stay empty");',
    );
  }
  return checks.map((check) => `    ${check}`);
}

function driver(protocol: Protocol, namespace: string): string {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = protocol.packets.flatMap((packet) =>
    (['max', 'min'] as const).map((variant) => {
      const args = samples(protocol, packet.fields, variant);
      const fromClient = packet.direction === 'c2s';
      return `    check<${packet.name}>("${packet.name}", ${packet.name}(${args.join(', ')}), ${fromClient});`;
    }),
  );
  const opcodeSize = protocol.opcode === 'u8' ? 1 : 2;
  return `#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <functional>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

#include "${entry}.hpp"

using namespace ${namespace};

namespace {

[[maybe_unused]] float f32FromBits(std::uint32_t bits) {
    float value;
    std::memcpy(&value, &bits, sizeof value);
    return value;
}

std::vector<std::uint8_t> bytes(std::initializer_list<int> values) {
    std::vector<std::uint8_t> result;
    for (int value : values) {
        result.push_back(static_cast<std::uint8_t>(value));
    }
    return result;
}

std::string hexOf(const std::vector<std::uint8_t>& data) {
    static const char digits[] = "0123456789abcdef";
    std::string text;
    for (std::uint8_t b : data) {
        text += digits[b >> 4];
        text += digits[b & 0xF];
    }
    return text;
}

void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw std::logic_error(message);
    }
}

// Every error is also a std::runtime_error, so callers can catch the standard type.
template <typename E>
void throwsAs(const std::function<void()>& action, const std::string& message) {
    static_assert(std::is_base_of<std::runtime_error, E>::value, "not a runtime_error");
    try {
        action();
    } catch (const E& error) {
        expect(*error.what() != '\\0', message + ": empty message");
        return;
    } catch (const std::exception& error) {
        throw std::logic_error(message + ": wrong exception: " + error.what());
    }
    throw std::logic_error(message + ": nothing was thrown");
}

std::uint32_t unknownOpcode(const std::function<void()>& action) {
    try {
        action();
    } catch (const UnknownOpcodeError& error) {
        return error.opcode();
    }
    return 0xFFFFFFFFu;
}

std::unique_ptr<Packet> decode(PacketReader& reader, bool fromClient) {
    return fromClient ? ${entry}::decodeFromClient(reader) : ${entry}::decodeFromServer(reader);
}

std::unique_ptr<Packet> decode(const std::uint8_t* data, std::size_t size, bool fromClient) {
    return fromClient ? ${entry}::decodeFromClient(data, size) : ${entry}::decodeFromServer(data, size);
}

template <typename P>
void check(const char* name, const P& packet, bool fromClient) {
    const std::string label = name;
    const std::vector<std::uint8_t> data = packet.encode();
    PacketReader reader(data);
    std::unique_ptr<Packet> decoded = decode(reader, fromClient);
    expect(reader.remaining() == 0, label + ": trailing bytes");
    const P* typed = dynamic_cast<const P*>(decoded.get());
    expect(typed != nullptr, label + ": decoded as another packet");
    expect(typed->opcode() == P::OpcodeValue, label + ": opcode differs");
    expect(*typed == packet, label + ": decoded packet differs");
    expect(!(*typed != packet), label + ": operator!= disagrees");
    expect(typed->encode() == data, label + ": re-encoding differs");
    expect(${entry}::encode(packet) == data, label + ": protocol encode differs");
    expect(data.size() - packet.bodySize() == ${opcodeSize}, label + ": bodySize is wrong");
    expect(decoded.get() != &packet, label + ": decoded the same instance");

    std::vector<std::uint8_t> padded = data;
    padded.push_back(0xAA);
    PacketReader paddedReader(padded);
    decode(paddedReader, fromClient);
    expect(paddedReader.remaining() == 1, label + ": did not stop at the end of the packet");

    for (std::size_t length = 0; length < data.size(); ++length) {
        throwsAs<TruncatedPacketError>(
            [&] { decode(data.data(), length, fromClient); },
            label + ": truncated to " + std::to_string(length));
    }
    std::printf("%s %s\\n", name, hexOf(data).c_str());
}

}  // namespace

int main() {
    try {
${checks.join('\n')}
${errorChecks(protocol).join('\n')}
        std::printf("ok\\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "failed: %s\\n", error.what());
        return 1;
    }
}
`;
}

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runRoundTrip(protocol: Protocol): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-'));
  workDirs.push(dir);
  mkdirSync(join(dir, 'gen'));
  for (const file of generateCpp(protocol)) {
    writeFileSync(join(dir, 'gen', file.path), file.content);
  }
  writeFileSync(join(dir, 'main.cpp'), driver(protocol, defaultCppNamespace(protocol.name)));
  const exe = join(dir, process.platform === 'win32' ? 'app.exe' : 'app');
  const { command, msvc } = compiler!;
  const flags = msvc
    ? [
        '/nologo',
        '/std:c++17',
        '/W4',
        '/WX',
        '/permissive-',
        '/EHsc',
        '/utf-8',
        `/I${join(dir, 'gen')}`,
        `/Fo${dir}\\`,
        `/Fe${exe}`,
        join(dir, 'main.cpp'),
      ]
    : [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-pedantic',
        '-Wshadow',
        `-I${join(dir, 'gen')}`,
        join(dir, 'main.cpp'),
        '-o',
        exe,
      ];
  const build = spawnSync(command, flags, { encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const run = spawnSync(exe, { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  const lines = run.stdout.trim().split(/\r?\n/);
  expect(lines.at(-1)).toBe('ok');
  return lines;
}

const MUTUAL = `name: mutual
endian: little
opcode: u8
enums:
  Color:
    type: u8
    values:
      RED: 1
      BLUE: 2
  Signed:
    type: i32
    values:
      ZERO: 0
      ONE: 1
structs:
  Alpha:
    fields:
      - { name: class, type: string, length: u8 }
      - { name: betas, type: 'Beta[]', length: u8 }
      - { name: color, type: Color }
  Beta:
    fields:
      - { name: alpha, type: Alpha }
      - { name: max, type: u8 }
      - { name: ratio, type: f32 }
      - { name: shades, type: 'Color[2]' }
packets:
  - name: Forest
    opcode: 1
    direction: s2c
    fields:
      - { name: opcode, type: Alpha }
      - { name: delete, type: 'Beta[]', length: u8 }
      - { name: ids, type: 'bool[]' }
  # Members named like the locals and parameters of the generated functions.
  - name: Shadow
    opcode: 1
    direction: c2s
    fields:
      - name: flags
        type: u8
        bits:
          - { name: on, type: bool }
      - { name: flags_bits, type: u8 }
      - { name: data, type: 'Beta[]', length: u8, if: on }
      - { name: data_present, type: u8 }
      - { name: data_count, type: u8 }
      - { name: size, type: string, length: u8 }
      - { name: item, type: u8 }
      - { name: writer, type: u8 }
      - { name: other, type: u8 }
      - name: wide
        type: u32
        bits:
          - { name: signed, type: Signed, bits: 32 }
`;

function mutual(): Protocol {
  const { protocol, diagnostics } = compile(MUTUAL);
  if (!protocol) throw new Error(JSON.stringify(diagnostics));
  return protocol;
}

describe.skipIf(!compiler)('C++ round trip', () => {
  it('encodes and decodes every chat-room packet', () => {
    const lines = runRoundTrip(chatRoom());
    // Little-endian u16 opcode 0x0003, u32 room id, then a u16-prefixed UTF-8 string.
    expect(lines).toContain('Say 0300ffffffff1000e8818ae5a4a920726f6f6d20f09f9880');
    expect(lines).toContain('Say 0300000000000000');
  }, 240_000);

  it('packs bit fields into their integer', () => {
    const lines = runRoundTrip(bitFields());
    // Status: u8 seq, then u16 and u32 bit fields in little-endian order.
    expect(lines).toContain('Status 01fffd0fffffffff');
    expect(lines).toContain('Status 0100000400000000');
    expect(lines).toContain('Board 020305ffff00000005ffffffffffff');
  }, 240_000);

  it('writes conditional fields only when their condition holds', () => {
    const lines = runRoundTrip(conditionalFields());
    // Big-endian: opcode, Shape::Circle, then the f32 radius 1.5 and nothing else.
    expect(lines).toContain('Draw 01013fc00000');
    expect(lines).toContain('Draw 0100');
  }, 240_000);

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
  }, 240_000);

  it('compiles structs that hold arrays of each other and members named like keywords or locals', () => {
    const lines = runRoundTrip(mutual());
    expect(lines.filter((l) => l.startsWith('Forest '))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('Shadow '))).toHaveLength(2);
  }, 240_000);
});
