import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateFuzz, type FuzzCorpus } from '../src/fuzz.js';
import { pascalCase } from '../src/gen/common.js';
import { defaultCppNamespace, generateCpp } from '../src/gen/cpp.js';
import { defaultCSharpNamespace, generateCSharp } from '../src/gen/csharp.js';
import { defaultJavaPackage, generateJava } from '../src/gen/java.js';
import { generateTypeScript } from '../src/gen/typescript.js';
import type { Protocol } from '../src/model.js';
import { allTypes, bitFields, chatRoom } from './helpers.js';

// Every generated decoder is fed the whole corpus: valid samples must decode and encode back to
// the same bytes, invalid ones must raise the error class named in the manifest.

const hasJava = spawnSync('javac', ['-version']).status === 0;
if (!hasJava && process.env.PKTSPEC_REQUIRE_JAVA) {
  throw new Error('PKTSPEC_REQUIRE_JAVA is set but javac was not found');
}

const dotnetVersion = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
const sdkMajor = dotnetVersion.status === 0 ? Number.parseInt(dotnetVersion.stdout, 10) : 0;
const hasDotnet = sdkMajor >= 8;
if (!hasDotnet && process.env.PKTSPEC_REQUIRE_DOTNET) {
  throw new Error('PKTSPEC_REQUIRE_DOTNET is set but a .NET SDK 8 or later was not found');
}

interface Compiler {
  command: string;
  msvc: boolean;
}

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

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-fuzz-'));
  workDirs.push(dir);
  return dir;
}

/** Writes the samples, the manifest and a tab-separated list for the drivers without a JSON parser. */
function writeCorpus(dir: string, corpus: FuzzCorpus): void {
  for (const sample of corpus.samples) {
    const path = join(dir, sample.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sample.data);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(corpus.manifest));
  const lines = corpus.samples.map((s) =>
    [s.file, s.packet ?? '', s.direction, String(s.valid), s.error ?? ''].join('\t'),
  );
  writeFileSync(join(dir, 'corpus.tsv'), lines.join('\n') + '\n');
}

function corpusFor(protocol: Protocol): FuzzCorpus {
  return generateFuzz(protocol, { count: 6 });
}

function expectOk(run: { stdout: string; stderr: string; status: number | null }, n: number): void {
  expect(run.stderr).toBe('');
  expect(run.stdout.trim().split(/\r?\n/).at(-1)).toBe(`ok ${n}`);
  expect(run.status).toBe(0);
}

const protocols: [string, () => Protocol][] = [
  ['chat-room', chatRoom],
  ['all-types', allTypes],
  ['bit-fields', bitFields],
];

describe('fuzz corpus', () => {
  it('has samples of every kind for the fixtures', () => {
    for (const [, load] of protocols) {
      const kinds = new Set(corpusFor(load()).samples.map((s) => s.kind));
      expect(kinds).toContain('boundary');
      expect(kinds).toContain('random');
      expect(kinds).toContain('truncated');
      expect(kinds).toContain('unknown_opcode');
      expect(kinds).toContain('length_past_end');
    }
  });
});

describe('TypeScript decoder on the fuzz corpus', () => {
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin',
    'tsc',
  );
  const options = {
    target: 'ES2020',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2020', 'DOM'],
    types: [],
    strict: true,
    skipLibCheck: true,
    rootDir: '.',
    outDir: 'out',
  };

  const runner = (entry: string) => `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gen from './out/gen/index.js';

const dir = process.argv[2];
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const entry = gen.${entry};
const hex = (data) => Buffer.from(data).toString('hex');
const failures = [];
for (const sample of manifest.samples) {
  const data = new Uint8Array(readFileSync(join(dir, sample.file)));
  const reader = new gen.PacketReader(data);
  let outcome = 'valid';
  let decoded;
  try {
    decoded = sample.direction === 'c2s' ? entry.decodeFromClient(reader) : entry.decodeFromServer(reader);
  } catch (error) {
    if (error instanceof gen.TruncatedPacketError) outcome = 'truncated';
    else if (error instanceof gen.InvalidPacketError) outcome = 'invalid';
    else outcome = String(error);
  }
  const expected = sample.valid ? 'valid' : sample.error;
  if (outcome !== expected) {
    failures.push(sample.file + ': expected ' + expected + ' but got ' + outcome);
  } else if (sample.valid) {
    if (reader.remaining !== 0) failures.push(sample.file + ': trailing bytes');
    else if (decoded.constructor.name !== sample.packet) failures.push(sample.file + ': decoded ' + decoded.constructor.name);
    else if (hex(decoded.encode()) !== hex(data)) failures.push(sample.file + ': re-encoding differs');
  }
}
if (failures.length > 0) {
  console.error(failures.slice(0, 10).join('\\n'));
  process.exit(1);
}
console.log('ok ' + manifest.samples.length);
`;

  it.each(protocols)(
    'accepts the valid and rejects the invalid samples of %s',
    (_, load) => {
      const protocol = load();
      const corpus = corpusFor(protocol);
      const dir = workDir();
      mkdirSync(join(dir, 'gen'));
      writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: options, include: ['gen'] }),
      );
      for (const file of generateTypeScript(protocol)) {
        writeFileSync(join(dir, 'gen', file.path), file.content);
      }
      const build = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
      expect(build.stdout + build.stderr).toBe('');
      writeCorpus(join(dir, 'corpus'), corpus);
      writeFileSync(join(dir, 'run.mjs'), runner(`${pascalCase(protocol.name)}Protocol`));
      const run = spawnSync(process.execPath, [join(dir, 'run.mjs'), join(dir, 'corpus')], {
        encoding: 'utf8',
      });
      expectOk(run, corpus.samples.length);
    },
    120_000,
  );
});

describe.skipIf(!hasJava)('Java decoder on the fuzz corpus', () => {
  const driver = (protocol: Protocol, javaPackage: string) => `package ${javaPackage};

import java.io.IOException;
import java.nio.BufferUnderflowException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class FuzzRun {
    public static void main(String[] args) throws IOException {
        Path dir = Paths.get(args[0]);
        List<String> lines = Files.readAllLines(dir.resolve("corpus.tsv"), StandardCharsets.UTF_8);
        List<String> failures = new ArrayList<>();
        for (String line : lines) {
            String[] f = line.split("\\t", -1);
            byte[] data = Files.readAllBytes(dir.resolve(f[0]));
            boolean fromClient = f[2].equals("c2s");
            ByteBuffer buf = ByteBuffer.wrap(data).order(${pascalCase(protocol.name)}Protocol.BYTE_ORDER);
            String outcome = "valid";
            Packet decoded = null;
            try {
                decoded = fromClient
                        ? ${pascalCase(protocol.name)}Protocol.decodeFromClient(buf)
                        : ${pascalCase(protocol.name)}Protocol.decodeFromServer(buf);
            } catch (BufferUnderflowException e) {
                outcome = "truncated";
            } catch (IllegalArgumentException e) {
                outcome = "invalid";
            }
            String expected = f[3].equals("true") ? "valid" : f[4];
            if (!outcome.equals(expected)) {
                failures.add(f[0] + ": expected " + expected + " but got " + outcome);
            } else if (decoded != null) {
                if (buf.hasRemaining()) {
                    failures.add(f[0] + ": trailing bytes");
                } else if (!decoded.getClass().getSimpleName().equals(f[1])) {
                    failures.add(f[0] + ": decoded " + decoded.getClass().getSimpleName());
                } else if (!Arrays.equals(decoded.encode(), data)) {
                    failures.add(f[0] + ": re-encoding differs");
                }
            }
        }
        if (!failures.isEmpty()) {
            System.err.println(String.join("\\n", failures.subList(0, Math.min(10, failures.size()))));
            System.exit(1);
        }
        System.out.println("ok " + lines.size());
    }
}
`;

  it.each(protocols)(
    'accepts the valid and rejects the invalid samples of %s',
    (_, load) => {
      const protocol = load();
      const corpus = corpusFor(protocol);
      const dir = workDir();
      const javaPackage = defaultJavaPackage(protocol.name);
      const sources = generateJava(protocol).map((file) => ({
        ...file,
        path: join(dir, file.path),
      }));
      sources.push({
        path: join(dir, javaPackage, 'FuzzRun.java'),
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
      writeCorpus(join(dir, 'corpus'), corpus);
      const run = spawnSync(
        'java',
        ['-cp', classes, `${javaPackage}.FuzzRun`, join(dir, 'corpus')],
        { encoding: 'utf8' },
      );
      expectOk(run, corpus.samples.length);
    },
    120_000,
  );
});

describe.skipIf(!hasDotnet)('C# decoder on the fuzz corpus', () => {
  const driver = (protocol: Protocol, namespace: string) => `#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ${namespace};

public static class FuzzRun
{
    public static int Main(string[] args)
    {
        string dir = args[0];
        string[] lines = File.ReadAllLines(Path.Combine(dir, "corpus.tsv"));
        var failures = new List<string>();
        foreach (string line in lines)
        {
            string[] f = line.Split('\\t');
            byte[] data = File.ReadAllBytes(Path.Combine(dir, f[0]));
            var reader = new PacketReader(data);
            string outcome = "valid";
            IPacket? decoded = null;
            try
            {
                decoded = f[2] == "c2s"
                    ? ${pascalCase(protocol.name)}Protocol.DecodeFromClient(reader)
                    : ${pascalCase(protocol.name)}Protocol.DecodeFromServer(reader);
            }
            catch (EndOfStreamException)
            {
                outcome = "truncated";
            }
            catch (InvalidDataException)
            {
                outcome = "invalid";
            }
            string expected = f[3] == "true" ? "valid" : f[4];
            if (outcome != expected)
            {
                failures.Add(f[0] + ": expected " + expected + " but got " + outcome);
            }
            else if (decoded != null)
            {
                if (reader.Remaining != 0)
                {
                    failures.Add(f[0] + ": trailing bytes");
                }
                else if (decoded.GetType().Name != f[1])
                {
                    failures.Add(f[0] + ": decoded " + decoded.GetType().Name);
                }
                else if (!decoded.Encode().AsSpan().SequenceEqual(data))
                {
                    failures.Add(f[0] + ": re-encoding differs");
                }
            }
        }
        if (failures.Count > 0)
        {
            Console.Error.WriteLine(string.Join("\\n", failures.Take(10)));
            return 1;
        }
        Console.WriteLine("ok " + lines.Length);
        return 0;
    }
}
`;

  const libraryProject = `<Project Sdk="Microsoft.NET.Sdk">
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

  const appProject = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net${sdkMajor}.0</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../lib/Protocol.csproj" />
  </ItemGroup>
</Project>
`;

  const env = {
    ...process.env,
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  };

  it.each(protocols)(
    'accepts the valid and rejects the invalid samples of %s',
    (_, load) => {
      const protocol = load();
      const corpus = corpusFor(protocol);
      const dir = workDir();
      mkdirSync(join(dir, 'lib'));
      mkdirSync(join(dir, 'app'));
      writeFileSync(join(dir, 'lib', 'Protocol.csproj'), libraryProject);
      for (const file of generateCSharp(protocol)) {
        writeFileSync(join(dir, 'lib', file.path), file.content);
      }
      writeFileSync(join(dir, 'app', 'App.csproj'), appProject);
      writeFileSync(
        join(dir, 'app', 'FuzzRun.cs'),
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
      writeCorpus(join(dir, 'corpus'), corpus);
      const run = spawnSync('dotnet', [join(dir, 'out', 'App.dll'), join(dir, 'corpus')], {
        encoding: 'utf8',
        env,
      });
      expectOk(run, corpus.samples.length);
    },
    240_000,
  );
});

describe.skipIf(!compiler)('C++ decoder on the fuzz corpus', () => {
  const driver = (protocol: Protocol, namespace: string) => `#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "${pascalCase(protocol.name)}Protocol.hpp"

using namespace ${namespace};

int main(int, char** argv) {
    const std::string dir = argv[1];
    std::ifstream list(dir + "/corpus.tsv");
    std::vector<std::string> failures;
    std::string line;
    int count = 0;
    while (std::getline(list, line)) {
        std::vector<std::string> f(1);
        for (char c : line) {
            if (c == '\\t') {
                f.emplace_back();
            } else {
                f.back() += c;
            }
        }
        std::ifstream file(dir + "/" + f[0], std::ios::binary);
        const std::vector<std::uint8_t> data((std::istreambuf_iterator<char>(file)),
                                             std::istreambuf_iterator<char>());
        PacketReader reader(data);
        std::string outcome = "valid";
        std::unique_ptr<Packet> decoded;
        try {
            decoded = f[2] == "c2s" ? ${pascalCase(protocol.name)}Protocol::decodeFromClient(reader)
                                    : ${pascalCase(protocol.name)}Protocol::decodeFromServer(reader);
        } catch (const TruncatedPacketError&) {
            outcome = "truncated";
        } catch (const InvalidPacketError&) {
            outcome = "invalid";
        }
        const std::string expected = f[3] == "true" ? "valid" : f[4];
        if (outcome != expected) {
            failures.push_back(f[0] + ": expected " + expected + " but got " + outcome);
        } else if (decoded) {
            if (reader.remaining() != 0) {
                failures.push_back(f[0] + ": trailing bytes");
            } else if (decoded->encode() != data) {
                failures.push_back(f[0] + ": re-encoding differs");
            }
        }
        ++count;
    }
    for (std::size_t i = 0; i < failures.size() && i < 10; ++i) {
        std::fprintf(stderr, "%s\\n", failures[i].c_str());
    }
    if (!failures.empty()) {
        return 1;
    }
    std::printf("ok %d\\n", count);
    return 0;
}
`;

  it.each(protocols)(
    'accepts the valid and rejects the invalid samples of %s',
    (_, load) => {
      const protocol = load();
      const corpus = corpusFor(protocol);
      const dir = workDir();
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
            `-I${join(dir, 'gen')}`,
            join(dir, 'main.cpp'),
            '-o',
            exe,
          ];
      const build = spawnSync(command, flags, { encoding: 'utf8' });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      writeCorpus(join(dir, 'corpus'), corpus);
      const run = spawnSync(exe, [join(dir, 'corpus')], { encoding: 'utf8' });
      expectOk(run, corpus.samples.length);
    },
    240_000,
  );
});
