import { describe, expect, it } from 'vitest';
import { INT_RANGES, findEnum, type Protocol } from '../src/model.js';
import { Rng, generateFuzz, type FuzzCorpus, type FuzzSample } from '../src/fuzz.js';
import { allTypes, bitFields, chatRoom } from './helpers.js';

const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const find = (corpus: FuzzCorpus, file: string): FuzzSample => {
  const sample = corpus.samples.find((s) => s.file === file);
  if (!sample) throw new Error(`no sample ${file}`);
  return sample;
};

describe('Rng', () => {
  it('produces the same numbers on every platform', () => {
    const rng = new Rng(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([1533919252, 1350175853, 4208309711]);
    const stream = new Rng(1, 'c2s/Login');
    expect([stream.next(), stream.below(10), stream.bits(64)]).toEqual([
      2377271769,
      3,
      8907283541332915192n,
    ]);
  });
});

describe('generateFuzz', () => {
  it('gives identical bytes for the same seed and different random samples for another', () => {
    const a = generateFuzz(allTypes(), { seed: 7 });
    const b = generateFuzz(allTypes(), { seed: 7 });
    expect(b.manifest).toEqual(a.manifest);
    expect(b.samples.map((s) => hex(s.data))).toEqual(a.samples.map((s) => hex(s.data)));

    const c = generateFuzz(allTypes(), { seed: 8 });
    const boundary = (corpus: FuzzCorpus) =>
      corpus.samples.filter((s) => s.kind !== 'random').map((s) => [s.file, hex(s.data)]);
    const random = (corpus: FuzzCorpus) =>
      corpus.samples.filter((s) => s.kind === 'random').map((s) => hex(s.data));
    expect(boundary(c)).toEqual(boundary(a));
    expect(random(c)).not.toEqual(random(a));
  });

  it('keeps one packet random samples stable when another packet is added', () => {
    const protocol = chatRoom();
    const smaller: Protocol = { ...protocol, packets: protocol.packets.slice(0, 3) };
    const pick = (corpus: FuzzCorpus) =>
      corpus.samples.filter((s) => s.kind === 'random' && s.packet === 'Login').map((s) => s.file);
    expect(pick(generateFuzz(smaller))).toEqual(pick(generateFuzz(protocol)));
  });

  it('writes integer boundaries in the protocol byte order', () => {
    const corpus = generateFuzz(allTypes());
    // Big-endian, u8 opcode 1, then every field at zero except the one under test.
    const zeros = (bytes: number) => '00'.repeat(bytes);
    const prefix = (before: number, after: number, value: string) =>
      `01${zeros(before)}${value}${zeros(after)}`;
    // Fields: u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 bool = 1 2 4 8 1 2 4 8 4 8 1 bytes.
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_i64-min.bin').data)).toBe(
      prefix(1 + 2 + 4 + 8 + 1 + 2 + 4, 4 + 8 + 1, '8000000000000000'),
    );
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_u64-max.bin').data)).toBe(
      prefix(1 + 2 + 4, 1 + 2 + 4 + 8 + 4 + 8 + 1, 'ffffffffffffffff'),
    );
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_i8-minus1.bin').data)).toBe(
      prefix(1 + 2 + 4 + 8, 2 + 4 + 8 + 4 + 8 + 1, 'ff'),
    );
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_f32-nan.bin').data)).toBe(
      prefix(1 + 2 + 4 + 8 + 1 + 2 + 4 + 8, 8 + 1, '7fc00000'),
    );
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_f64-neg_zero.bin').data)).toBe(
      prefix(1 + 2 + 4 + 8 + 1 + 2 + 4 + 8 + 4, 1, '8000000000000000'),
    );
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_f64-inf.bin').data)).toContain('7ff0000000000000');
    expect(hex(find(corpus, 'valid/c2s-Numbers-a_f64-neg_inf.bin').data)).toContain(
      'fff0000000000000',
    );
  });

  it('uses the opcode width and little-endian order of the protocol', () => {
    const corpus = generateFuzz(chatRoom());
    // Say: opcode 3 (u16 LE), room_id u32 zero, empty u16-prefixed text.
    expect(hex(find(corpus, 'valid/c2s-Say-zero.bin').data)).toBe('0300' + '00000000' + '0000');
    expect(hex(find(corpus, 'valid/c2s-Say-room_id-high_bit.bin').data)).toBe(
      '0300' + '00000080' + '0000',
    );
  });

  it('covers empty and maximum-length strings, bytes, arrays and every enum value', () => {
    const corpus = generateFuzz(chatRoom());
    // Login: u16 opcode, u8-prefixed account of 255 bytes, 32 fixed bytes, u16 version.
    const login = find(corpus, 'valid/c2s-Login-account-max.bin');
    expect(login.data.length).toBe(2 + 1 + 255 + 32 + 2);
    expect(login.data[2]).toBe(255);
    expect(find(corpus, 'valid/c2s-Login-zero.bin').data[2]).toBe(0);
    // RoomJoined: members is a u8-prefixed array of Users, so 255 is the longest count.
    const joined = find(corpus, 'valid/s2c-RoomJoined-members-max.bin');
    expect(joined.data[2 + 4 + 1]).toBe(255);
    for (const name of ['BAD_PASSWORD', 'BANNED', 'SERVER_FULL']) {
      expect(
        corpus.samples.some((s) => s.file === `valid/s2c-LoginResult-status-${name}.bin`),
      ).toBe(true);
    }
    expect(findEnum(chatRoom(), 'LoginStatus').values).toHaveLength(4);
  });

  it('puts each bit field at 0 and at its maximum, and leaves unused bits 0', () => {
    const corpus = generateFuzz(bitFields());
    const status = (name: string) => hex(find(corpus, `valid/c2s-Status-${name}.bin`).data);
    // Opcode, u8 seq, u16 state, u32 wide, little-endian. Mood has no 0, so it starts at CALM (1).
    expect(status('zero')).toBe('01' + '00' + '0004' + '00000000');
    expect(status('max')).toBe('01' + 'ff' + 'fd0f' + 'ffffffff');
    expect(status('state-alive-true')).toBe('01' + '00' + '0104' + '00000000');
    expect(status('state-level-max')).toBe('01' + '00' + 'f807' + '00000000');
    expect(status('state-team-GREEN')).toBe('01' + '00' + '0404' + '00000000');
    expect(status('state-mood-ANGRY')).toBe('01' + '00' + '000c' + '00000000');
    expect(status('wide-low-max')).toBe('01' + '00' + '0004' + 'ffffff7f');
    expect(status('wide-top-true')).toBe('01' + '00' + '0004' + '00000080');
    expect(hex(find(corpus, 'valid/s2c-Board-full-everything-max.bin').data)).toBe('0200ffffffff');
    for (const sample of corpus.samples.filter((s) => s.valid && s.packet === 'Status')) {
      expect(sample.data[3]! & 0xf0, sample.file).toBe(0);
    }
  });

  it('uses enum values that fit in the bits but that no member uses', () => {
    const corpus = generateFuzz(bitFields());
    const status = (name: string) => find(corpus, `invalid/c2s-Status-enum-state-${name}.bin`);
    // Team takes two bits and uses 0 to 2; Mood takes two bits and uses 1 and 3.
    expect(hex(status('team-bad_3').data)).toBe('01' + '00' + '0604' + '00000000');
    expect(hex(status('mood-bad_0').data)).toBe('01' + '00' + '0000' + '00000000');
    expect(hex(status('mood-bad_2').data)).toBe('01' + '00' + '0008' + '00000000');
    const enums = corpus.samples.filter((s) => s.kind === 'unknown_enum');
    expect(enums.map((s) => s.file).sort()).toEqual([
      'invalid/c2s-Status-enum-state-mood-bad_0.bin',
      'invalid/c2s-Status-enum-state-mood-bad_2.bin',
      'invalid/c2s-Status-enum-state-team-bad_3.bin',
      'invalid/s2c-Board-enum-cells-elem-flags-owner-bad_3.bin',
    ]);
    expect(enums.every((s) => s.error === 'invalid')).toBe(true);
  });

  it('nests structs and stops recursive ones', () => {
    const corpus = generateFuzz(allTypes());
    expect(corpus.samples.some((s) => s.file.includes('s2c-Nested-tree-children-elem-label'))).toBe(
      true,
    );
    expect(corpus.samples.every((s) => s.data.length < 140000)).toBe(true);
  });

  it('labels every invalid sample with the error a decoder raises', () => {
    const protocol = allTypes();
    const corpus = generateFuzz(protocol);
    const invalid = corpus.samples.filter((s) => !s.valid);
    expect(invalid.length).toBeGreaterThan(100);
    for (const sample of invalid) {
      expect(sample.error, sample.file).toBe(
        sample.kind === 'truncated' || sample.kind === 'length_past_end' ? 'truncated' : 'invalid',
      );
    }
    for (const sample of corpus.samples.filter((s) => s.valid)) {
      expect(sample.error).toBeNull();
    }
    const kinds = new Set(invalid.map((s) => s.kind));
    expect(kinds).toEqual(
      new Set([
        'truncated',
        'length_past_end',
        'length_too_large',
        'unknown_opcode',
        'unknown_enum',
      ]),
    );
  });

  it('truncates at every byte boundary of the largest simple sample', () => {
    const corpus = generateFuzz(chatRoom());
    const full = find(corpus, 'valid/s2c-LoginResult-max.bin').data;
    const cuts = corpus.samples.filter((s) =>
      s.file.startsWith('invalid/s2c-LoginResult-truncated-'),
    );
    expect(cuts.map((s) => s.data.length)).toEqual(
      Array.from({ length: full.length }, (_, i) => i),
    );
    for (const cut of cuts) expect(hex(full).startsWith(hex(cut.data))).toBe(true);
  });

  it('only uses unknown opcodes and enum values that no packet or member uses', () => {
    const protocol = allTypes();
    const corpus = generateFuzz(protocol);
    const opcodeSize = 1;
    for (const sample of corpus.samples.filter((s) => s.kind === 'unknown_opcode')) {
      expect(sample.data.length).toBe(opcodeSize);
      const used = protocol.packets.filter((p) => p.direction === sample.direction);
      expect(used.map((p) => p.opcode)).not.toContain(sample.data[0]);
      expect(sample.packet).toBeNull();
    }
    // Opcode 2 only exists as c2s Texts and s2c Collections, 3 only as s2c Nested.
    expect(corpus.samples.map((s) => s.file)).toContain(
      'invalid/c2s-unknown_opcode-03-only-Nested.bin',
    );
    // Small is i8 with -128, 0 and 127, so the nearest free values are -127 and 126. They sit
    // after the opcode, Point (4 bytes) and Node (label and children prefixes, 2 bytes).
    const small = (name: string) => find(corpus, `invalid/s2c-Nested-enum-small-${name}.bin`).data;
    expect(small('bad_126')[1 + 4 + 2]).toBe(126);
    expect(small('bad_n127')[1 + 4 + 2]).toBe(0x81);
    expect(INT_RANGES.i8).toEqual([-128, 127]);
  });

  it('overwrites length prefixes so that they point past the end', () => {
    const corpus = generateFuzz(allTypes());
    // Texts with short_text (u8 prefix) claiming everything after it plus one byte.
    const sample = find(corpus, 'invalid/c2s-Texts-length-short_text-length.bin').data;
    expect(sample[1]).toBe(sample.length - 2 + 1);
    const huge = find(corpus, 'invalid/c2s-Texts-length-long_text-length-too_large.bin').data;
    // After the opcode, the u8 prefix of short_text and the u16 prefix of text.
    expect(hex(huge.subarray(4, 8))).toBe('ffffffff');
  });

  it('honours the size cap, the total limit and the random count', () => {
    const capped = generateFuzz(allTypes(), { maxSize: 20, count: 0 });
    expect(capped.samples.every((s) => s.data.length <= 20)).toBe(true);
    expect(capped.samples.some((s) => s.kind === 'random')).toBe(false);
    expect(capped.manifest.skipped.tooLarge).toBeGreaterThan(0);

    const limited = generateFuzz(allTypes(), { maxSamples: 25 });
    expect(limited.samples).toHaveLength(25);
    expect(limited.manifest.skipped.overLimit).toBeGreaterThan(0);
    expect(limited.samples.every((s) => s.valid)).toBe(true);

    const some = generateFuzz(chatRoom(), { count: 3 });
    const perPacket = some.samples.filter((s) => s.kind === 'random' && s.packet === 'Say');
    expect(perPacket.length).toBeLessThanOrEqual(3);
    expect(perPacket.length).toBeGreaterThan(0);
  });

  it('describes every sample in the manifest with unique, portable file names', () => {
    const corpus = generateFuzz(allTypes());
    expect(corpus.manifest.samples).toHaveLength(corpus.samples.length);
    corpus.samples.forEach((sample, i) => {
      expect(corpus.manifest.samples[i]).toEqual({
        file: sample.file,
        packet: sample.packet,
        direction: sample.direction,
        valid: sample.valid,
        error: sample.error,
        kind: sample.kind,
        size: sample.data.length,
      });
    });
    const names = corpus.samples.map((s) => s.file.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^(valid|invalid)\/[a-z0-9_.-]+\.bin$/.test(n))).toBe(true);
    expect(corpus.manifest).toMatchObject({
      format: 1,
      protocol: 'all_types',
      version: '2.1',
      endian: 'big',
      opcode: 'u8',
      seed: 1,
      count: 16,
    });
  });

  it('never repeats the same bytes for one direction', () => {
    const corpus = generateFuzz(chatRoom());
    const keys = corpus.samples.map((s) => `${s.direction}:${hex(s.data)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
