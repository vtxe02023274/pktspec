import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

const example = fileURLToPath(new URL('../examples/chat-room.yaml', import.meta.url));

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

  it('explains usage mistakes', () => {
    expect(run('check').err).toContain('check takes exactly one protocol file');
    expect(run('check', join(dir, 'missing.yaml')).err).toContain('cannot read');
    expect(run('frobnicate').code).toBe(2);
    expect(run().code).toBe(2);
  });

  it('prints help and version', () => {
    expect(run('--help')).toMatchObject({ code: 0 });
    expect(run('--version').out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
