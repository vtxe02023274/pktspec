import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultCSharpNamespace, generateCSharp } from '../src/gen/csharp.js';
import { pascalCase } from '../src/gen/common.js';
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

const dotnetVersion = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const sdkMajor = dotnetVersion.status === 0 ? Number.parseInt(dotnetVersion.stdout, 10) : 0;
const hasDotnet = sdkMajor >= 8;
if (!hasDotnet && process.env.PKTSPEC_REQUIRE_DOTNET) {
  throw new Error('PKTSPEC_REQUIRE_DOTNET is set but a .NET SDK 8 or later was not found');
}

type Variant = 'max' | 'min';

const PRIMITIVE_SAMPLES: Record<string, Record<Variant, string>> = {
  u8: { max: '(byte)255', min: '(byte)0' },
  u16: { max: '(ushort)65535', min: '(ushort)0' },
  u32: { max: '4294967295u', min: '0u' },
  u64: { max: 'ulong.MaxValue', min: '0UL' },
  i8: { max: '(sbyte)127', min: '(sbyte)-128' },
  i16: { max: '(short)32767', min: '(short)-32768' },
  i32: { max: 'int.MaxValue', min: 'int.MinValue' },
  i64: { max: 'long.MaxValue', min: 'long.MinValue' },
  // float.NaN has the sign bit set in .NET, so the bits are spelled out to match the other targets.
  f32: { max: 'BitConverter.Int32BitsToSingle(0x7fc00000)', min: '-1.5f' },
  f64: { max: 'double.NegativeInfinity', min: 'Math.PI' },
  bool: { max: 'true', min: 'false' },
};

/** Constructor arguments for the fields; a bit field group gives one per bit field. */
function samples(protocol: Protocol, fields: Field[], variant: Variant, depth = 0): string[] {
  const present = presentFields(protocol, fields, variant);
  return fields.flatMap((field) => {
    if (!present.has(field)) return fieldMembers(field).map(() => 'null');
    if (field.type.kind !== 'bits') return [sample(protocol, field.type, variant, depth)];
    return field.type.fields.map((bit) => {
      if (bit.type.kind !== 'uint') return sample(protocol, bitMember(bit).type, variant, depth);
      const value = variant === 'max' ? 2 ** bit.bits - 1 : 0;
      return bit.bits <= 8 ? `(byte)${value}` : bit.bits <= 16 ? `(ushort)${value}` : `${value}u`;
    });
  });
}

/** Builds a C# expression holding an edge-case value of the given type. */
function sample(protocol: Protocol, type: MemberType, variant: Variant, depth = 0): string {
  switch (type.kind) {
    case 'primitive':
      return PRIMITIVE_SAMPLES[type.name]![variant];
    case 'string':
      return variant === 'max' ? '"\\u804a\\u5929 room \\ud83d\\ude00"' : '""';
    case 'bytes':
      return variant === 'max' ? 'new byte[] {0, 0xFF, 7}' : 'new byte[0]';
    case 'fixedBytes': {
      const bytes = Array.from({ length: type.size }, (_, i) => String((i * 37) % 256));
      return variant === 'max' ? `new byte[] {${bytes.join(', ')}}` : `new byte[${type.size}]`;
    }
    case 'enum': {
      const values = findEnum(protocol, type.name).values;
      const value = variant === 'max' ? values[values.length - 1]! : values[0]!;
      return `(${type.name})(${value.value}L)`;
    }
    case 'struct': {
      const fields = findStruct(protocol, type.name).fields;
      const args = samples(protocol, fields, variant, depth + 1);
      return `new ${type.name}(${args.join(', ')})`;
    }
    case 'array': {
      // Recursive structs stop at the second level.
      if (variant === 'min' || depth > 1) return 'new()';
      const items = [0, 1, 2].map((i) =>
        sample(protocol, type.element, i === 1 ? 'min' : 'max', depth),
      );
      return `new() { ${items.join(', ')} }`;
    }
    case 'fixedArray': {
      const items = Array.from({ length: type.size }, () =>
        sample(protocol, type.element, variant, depth),
      );
      return `new() { ${items.join(', ')} }`;
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
  const checks = (['c2s', 's2c'] as const).map((direction) => {
    const used = new Set(
      protocol.packets.filter((p) => p.direction === direction).map((p) => p.opcode),
    );
    const max = INT_RANGES[protocol.opcode][1];
    let unknown = max;
    while (used.has(unknown)) unknown--;
    const method = direction === 'c2s' ? 'DecodeFromClient' : 'DecodeFromServer';
    return `Throws<InvalidDataException>(() => ${pascalCase(protocol.name)}Protocol.${method}(new byte[] { ${opcodeBytes(protocol, unknown)} }), "${direction} unknown opcode");`;
  });
  if (protocol.name === 'chat-room') {
    checks.push(
      'Throws<ArgumentException>(() => new Login(new string(\'a\', 256), new byte[32], 1).Encode(), "long account");',
      'Throws<ArgumentException>(() => new Login("a", new byte[31], 1).Encode(), "short hash");',
    );
  }
  if (protocol.name === 'all_types') {
    checks.push(
      'Throws<ArgumentException>(() => new Texts(new string(\'a\', 256), "", "", new byte[0], new byte[4]).Encode(), "long short_text");',
      'Throws<ArgumentException>(() => new Texts("", "", "", new byte[0], new byte[3]).Encode(), "short hash");',
      'Throws<ArgumentException>(() => new Collections(new(), new(), new() { true }, new(), new(), new()).Encode(), "flags count");',
      'Throws<InvalidDataException>(() => AllTypesProtocol.DecodeFromServer(new byte[] { 3, 0, 0, 0, 0, 0, 0, 5 }), "unknown enum value");',
    );
  }
  if (protocol.name === 'bit_fields') {
    const status = (field: string, value: string) =>
      `Throws<ArgumentException>(() => new Status { ${field} = ${value} }.Encode(), "${field} ${value}");`;
    const decode = (bytes: string) => `BitFieldsProtocol.DecodeFromClient(new byte[] { ${bytes} })`;
    checks.push(
      status('Level', '128'),
      status('Low', '0x80000000u'),
      status('Team', '(Team)4'),
      status('Mood', '(Mood)(-1)'),
      `Throws<InvalidDataException>(() => ${decode('1, 0, 0, 0, 0, 0, 0, 0')}, "mood 0");`,
      `Throws<InvalidDataException>(() => ${decode('1, 0, 6, 4, 0, 0, 0, 0')}, "team 3");`,
      `Expect(new Status().Equals(${decode('1, 0, 0, 0x84, 0, 0, 0, 0')}), "unused bits");`,
    );
  }
  if (protocol.name === 'conditional_fields') {
    const polygon = 'Shape = Shape.Polygon, Corner = new Point(), Points = new List<Point>()';
    checks.push(
      'Check(new Draw { Shape = Shape.Circle, Radius = 1.5f }, true);',
      'Throws<ArgumentException>(() => new Draw { Shape = Shape.Circle }.Encode(), "missing radius");',
      'Throws<ArgumentException>(() => new Draw { Radius = 1.5f }.Encode(), "radius without Circle");',
      `Throws<ArgumentException>(() => new Draw { ${polygon}, Closed = true, Fill = 7, Dashed = false }.Encode(), "half a bit field group");`,
      `Throws<ArgumentException>(() => new Draw { ${polygon}, Closed = false, Width = 1 }.Encode(), "bit field group when closed is false");`,
      'Expect(new Draw().Equals(ConditionalFieldsProtocol.DecodeFromClient(new byte[] { 1, 0, 9 })), "absent fields stay null");',
    );
  }
  return checks.map((check) => `        ${check}`);
}

function driver(protocol: Protocol, namespace: string): string {
  const entry = `${pascalCase(protocol.name)}Protocol`;
  const checks = protocol.packets.flatMap((packet) =>
    (['max', 'min'] as const).map((variant) => {
      const args = samples(protocol, packet.fields, variant);
      const fromClient = packet.direction === 'c2s';
      return `        Check(new ${packet.name}(${args.join(', ')}), ${fromClient ? 'true' : 'false'});`;
    }),
  );
  return `#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using ${namespace};

public static class RoundTrip
{
    public static int Main()
    {
${checks.join('\n')}
${errorChecks(protocol).join('\n')}
        Console.WriteLine("ok");
        return 0;
    }

    static IPacket Decode(ReadOnlyMemory<byte> data, bool fromClient)
    {
        return fromClient ? ${entry}.DecodeFromClient(data) : ${entry}.DecodeFromServer(data);
    }

    static void Check(IPacket packet, bool fromClient)
    {
        byte[] data = packet.Encode();
        var reader = new PacketReader(data);
        IPacket decoded = fromClient
            ? ${entry}.DecodeFromClient(reader)
            : ${entry}.DecodeFromServer(reader);
        string name = packet.GetType().Name;
        Expect(reader.Remaining == 0, name + ": trailing bytes");
        Expect(packet.Equals(decoded), name + ": decoded " + decoded + " but sent " + packet);
        Expect(packet.GetHashCode() == decoded.GetHashCode(), name + ": hash code differs");
        Expect(data.AsSpan().SequenceEqual(decoded.Encode()), name + ": re-encoding differs");
        Expect(data.Length - packet.BodySize() == ${protocol.opcode === 'u8' ? 1 : 2}, name + ": BodySize is wrong");
        Expect(ReferenceEquals(packet, decoded) == false, name + ": decoded the same instance");
        Throws<EndOfStreamException>(
            () => Decode(new ReadOnlyMemory<byte>(data, 0, data.Length - 1), fromClient),
            name + ": truncated");
        Console.WriteLine(name + " " + Hex(data));
    }

    static string Hex(byte[] data)
    {
        var text = new System.Text.StringBuilder();
        foreach (byte b in data)
        {
            text.Append(b.ToString("x2"));
        }
        return text.ToString();
    }

    static void Expect(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    static void Throws<T>(Action action, string message) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }
        throw new InvalidOperationException(message + ": " + typeof(T).Name + " was not thrown");
    }
}
`;
}

const LIBRARY_PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <NoWarn>CS1591</NoWarn>
  </PropertyGroup>
</Project>
`;

const appProject = (framework: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${framework}</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../lib/Protocol.csproj" />
  </ItemGroup>
</Project>
`;

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const env = {
  ...process.env,
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
};

function runRoundTrip(protocol: Protocol): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-'));
  workDirs.push(dir);
  mkdirSync(join(dir, 'lib'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'lib', 'Protocol.csproj'), LIBRARY_PROJECT);
  for (const file of generateCSharp(protocol)) {
    writeFileSync(join(dir, 'lib', file.path), file.content);
  }
  writeFileSync(join(dir, 'app', 'App.csproj'), appProject(`net${sdkMajor}.0`));
  writeFileSync(
    join(dir, 'app', 'RoundTrip.cs'),
    driver(protocol, defaultCSharpNamespace(protocol.name)),
  );
  const build = spawnSync(
    'dotnet',
    [
      'build',
      join(dir, 'app', 'App.csproj'),
      '-c',
      'Release',
      '-o',
      join(dir, 'out'),
      '-nodeReuse:false',
      '-p:UseSharedCompilation=false',
      '-warnaserror',
      '-nologo',
      '-consoleLoggerParameters:NoSummary',
    ],
    { encoding: 'utf8', env },
  );
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const run = spawnSync('dotnet', [join(dir, 'out', 'App.dll')], { encoding: 'utf8', env });
  expect(run.stderr).toBe('');
  const lines = run.stdout.trim().split(/\r?\n/);
  expect(lines.at(-1)).toBe('ok');
  return lines;
}

describe.skipIf(!hasDotnet)('C# round trip', () => {
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
    // Big-endian: opcode, Shape.Circle, then the f32 radius 1.5 and nothing else.
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
});
