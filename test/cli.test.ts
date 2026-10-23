import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

const example = fileURLToPath(new URL('../examples/chat-room.yaml', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const oldSpec = fixture('diff-old.yaml');
const newSpec = fixture('diff-new.yaml');

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pktspec-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('checks a valid protocol', () => {
    expect(run('check', example)).toEqual({
      code: 0,
      out: `${example}: ok (8 packets, 1 struct, 2 enums)`,
      err: '',
    });
  });

  it('prints file:line:column for errors', () => {
    const file = join(dir, 'bad.yaml');
    writeFileSync(file, 'name: bad\npackets:\n  - { name: A, opcode: 1, direction: up }\n');
    const result = run('check', file);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `${file}:3:38: error: direction of packet 'A' must be one of: c2s, s2c`,
    );
  });

  it('generates Java into the package directory', () => {
    const result = run('gen', 'java', example, '-o', dir, '--package', 'com.example.chat');
    expect(result).toMatchObject({ code: 0, out: `wrote 14 files to ${dir}` });
    expect(existsSync(join(dir, 'com/example/chat/Login.java'))).toBe(true);
  });

  it('generates C# into the output directory', () => {
    const result = run('gen', 'csharp', example, '-o', dir, '--namespace', 'Example.Chat');
    expect(result).toMatchObject({ code: 0, out: `wrote 16 files to ${dir}` });
    expect(existsSync(join(dir, 'Login.cs'))).toBe(true);
    expect(readFileSync(join(dir, 'Login.cs'), 'utf8')).toContain('namespace Example.Chat');
  });

  it('generates TypeScript into the output directory', () => {
    const result = run('gen', 'typescript', example, '-o', dir);
    expect(result).toMatchObject({ code: 0, out: `wrote 18 files to ${dir}` });
    expect(existsSync(join(dir, 'Login.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'index.ts'), 'utf8')).toContain("export * from './Login.js';");
  });

  it('rejects an invalid C# namespace', () => {
    const result = run('gen', 'csharp', example, '-o', dir, '--namespace', 'Example.new');
    expect(result).toMatchObject({
      code: 1,
      err: "error: 'Example.new' is not a valid C# namespace name",
    });
  });

  it('generates docs', () => {
    expect(run('gen', 'docs', example, '--out', dir).code).toBe(0);
    expect(existsSync(join(dir, 'chat-room.md'))).toBe(true);
  });

  it('rejects an invalid Java package', () => {
    const result = run('gen', 'java', example, '-o', dir, '--package', 'com.example.new');
    expect(result).toMatchObject({
      code: 1,
      err: "error: 'com.example.new' is not a valid Java package name",
    });
  });

  it('diffs two specs as text and exits 1 on breaking changes', () => {
    const result = run('diff', oldSpec, newSpec);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.out.split('\n')).toEqual([
      'breaking (2)',
      `  ${newSpec}:15:17: struct 'Vec2' field 'x': type changed from i16 to i32 (used by: Move) (was ${oldSpec}:14:17)`,
      `  ${oldSpec}:31:11: packet 'Ping' (0x03, c2s) removed`,
      '',
      'compatible (2)',
      `  ${newSpec}:10:7: enum 'Team' value 'GREEN' (2) added`,
      `  ${newSpec}:32:11: packet 'Chat' (0x04, c2s) added`,
      '',
      'info (2)',
      `  ${newSpec}:1:1: version changed from '1' to '2' (was ${oldSpec}:1:1)`,
      `  ${newSpec}:23:17: packet 'Join' field 'id': renamed from 'player_id' (was ${oldSpec}:22:17)`,
      '',
      '2 breaking, 2 compatible, 2 info',
    ]);
  });

  it('diffs two specs as json', () => {
    const result = run('diff', oldSpec, newSpec, '--format', 'json');
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      old: oldSpec,
      new: newSpec,
      breaking: true,
      summary: { breaking: 2, compatible: 2, info: 2 },
    });
    expect(report.changes).toContainEqual({
      severity: 'breaking',
      rule: 'packet-removed',
      subject: 'packet',
      path: 'Ping',
      message: "packet 'Ping' (0x03, c2s) removed",
      old: { line: 31, column: 11 },
      new: null,
    });
  });

  it('exits 0 when nothing is breaking', () => {
    expect(run('diff', oldSpec, oldSpec)).toEqual({ code: 0, out: 'no differences', err: '' });
    expect(JSON.parse(run('diff', oldSpec, oldSpec, '--format', 'json').out)).toMatchObject({
      breaking: false,
      changes: [],
    });
    const compatible = join(dir, 'compatible.yaml');
    writeFileSync(
      compatible,
      readFileSync(oldSpec, 'utf8').replace('BLUE: 1', 'BLUE: 1\n      GREEN: 2'),
    );
    const result = run('diff', oldSpec, compatible);
    expect(result.code).toBe(0);
    expect(result.out).toContain('compatible (1)');
  });

  it('reports errors in both files the way check does', () => {
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'name: bad\npackets:\n  - { name: A, opcode: 1, direction: up }\n');
    const result = run('diff', bad, join(dir, 'missing.yaml'));
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    const worse = join(dir, 'worse.yaml');
    writeFileSync(worse, 'name: worse\npackets:\n  - { name: A, opcode: 1 }\n');
    const both = run('diff', bad, worse);
    expect(both.code).toBe(1);
    expect(both.err).toContain(
      `${bad}:3:38: error: direction of packet 'A' must be one of: c2s, s2c`,
    );
    expect(both.err).toContain(`${worse}:3:5: error: packet 'A' is missing 'direction'`);
  });

  it('explains diff usage mistakes', () => {
    expect(run('diff', oldSpec)).toMatchObject({ code: 2 });
    expect(run('diff', oldSpec, newSpec, '--format', 'xml')).toMatchObject({ code: 2 });
    expect(run('diff', oldSpec, newSpec, '--format', 'xml').err).toContain(
      "unknown format 'xml'; expected text or json",
    );
  });

  it('explains usage mistakes', () => {
    expect(run('gen', 'rust', example, '-o', dir).err).toContain(
      "unknown target 'rust'; expected one of: java, csharp, typescript, docs",
    );
    expect(run('gen', 'java', example).err).toContain('gen requires --out <dir>');
    expect(run('check', join(dir, 'missing.yaml')).err).toContain('cannot read');
    expect(run('frobnicate').code).toBe(2);
    expect(run().code).toBe(2);
  });

  it('prints help and version', () => {
    expect(run('--help')).toMatchObject({ code: 0 });
    expect(run('--version').out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
