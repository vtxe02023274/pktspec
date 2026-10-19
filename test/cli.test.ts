import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  it('explains usage mistakes', () => {
    expect(run('frobnicate').code).toBe(2);
    expect(run().code).toBe(2);
  });

  it('prints help and version', () => {
    expect(run('--help')).toMatchObject({ code: 0 });
    expect(run('--version').out).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
