import {
  INT_RANGES,
  PRIMITIVE_SIZES,
  bitLayout,
  findEnum,
  findStruct,
  type BitField,
  type BitsType,
  type Direction,
  type Endian,
  type Enum,
  type FieldType,
  type LengthType,
  type Packet,
  type PrimitiveType,
  type Protocol,
} from './model.js';

export interface FuzzOptions {
  /** Seed of the random samples, 0 to 4294967295. */
  seed?: number;
  /** Random valid samples per packet. */
  count?: number;
  /** Largest sample in bytes, opcode included. */
  maxSize?: number;
  /** Stop after this many samples in total. */
  maxSamples?: number;
}

export const FUZZ_DEFAULTS = { seed: 1, count: 16, maxSize: 131072 } as const;

/** The two error classes every generated decoder distinguishes. */
export type FuzzError = 'truncated' | 'invalid';

export type FuzzKind =
  | 'boundary'
  | 'random'
  | 'truncated'
  | 'length_past_end'
  | 'length_too_large'
  | 'unknown_opcode'
  | 'unknown_enum';

export interface FuzzSample {
  /** Path relative to the corpus directory, with forward slashes. */
  file: string;
  data: Uint8Array;
  /** Packet the sample was built from; null when the opcode belongs to no packet. */
  packet: string | null;
  /** Which decoder to feed: c2s for decodeFromClient, s2c for decodeFromServer. */
  direction: Direction;
  valid: boolean;
  error: FuzzError | null;
  kind: FuzzKind;
}

export interface FuzzManifestSample extends Omit<FuzzSample, 'data'> {
  size: number;
}

export interface FuzzManifest {
  format: 1;
  protocol: string;
  version: string | null;
  endian: Endian;
  opcode: string;
  seed: number;
  count: number;
  maxSize: number;
  /** Samples left out because they were over the size cap or past the total limit. */
  skipped: { tooLarge: number; overLimit: number };
  samples: FuzzManifestSample[];
}

export interface FuzzCorpus {
  samples: FuzzSample[];
  manifest: FuzzManifest;
}

type Profile = 'zero' | 'min' | 'max';
type Mode = 'valid' | 'enum' | 'length';

/** A length or count prefix that the packet builder may overwrite. */
interface Patch {
  offset: number;
  size: number;
  /** False when elements take no bytes, so a count past the end still decodes. */
  pastEnd: boolean;
}

interface Variant {
  label: string;
  bytes: Uint8Array;
  patch?: Patch;
}

interface Pending {
  direction: Direction;
  packet: string | null;
  name: string;
  data: Uint8Array;
  valid: boolean;
  error: FuzzError | null;
  kind: FuzzKind;
}

const LENGTH_MAX: Record<LengthType, number> = { u8: 0xff, u16: 0xffff, u32: 0xffffffff };
// Past this nesting only leaf fields get variants, so recursive structs stay finite.
const MAX_DEPTH = 3;
// Prefixed arrays of zero-byte elements never reach the end of the data, so cap them.
const EMPTY_ELEMENT_COUNT = 1024;
const TRUNCATE_ALL_UP_TO = 1024;
const LENGTH_TOO_LARGE = 0xffffffff;

const encoder = new TextEncoder();

/** Small seeded generator (mulberry32) so the same seed gives the same bytes on every platform. */
export class Rng {
  private state: number;

  constructor(seed: number, stream = '') {
    let hash = 0x811c9dc5;
    for (const byte of encoder.encode(stream)) {
      hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    this.state = (seed ^ hash) >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Integer in [0, limit). */
  below(limit: number): number {
    return Math.floor((this.next() / 0x100000000) * limit);
  }

  bits(count: number): bigint {
    let value = 0n;
    for (let done = 0; done < count; done += 32) {
      value = (value << 32n) | BigInt(this.next());
    }
    return BigInt.asUintN(count, value);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function repeat(part: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(part.length * times);
  for (let i = 0; i < times; i++) out.set(part, i * part.length);
  return out;
}

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function primitiveValues(name: PrimitiveType): [string, bigint][] {
  const bits = BigInt(PRIMITIVE_SIZES[name] * 8);
  switch (name) {
    case 'bool':
      return [['true', 1n]];
    case 'f32':
      return [
        ['neg_zero', 0x80000000n],
        ['one_and_half', 0x3fc00000n],
        ['nan', 0x7fc00000n],
        ['inf', 0x7f800000n],
        ['neg_inf', 0xff800000n],
        ['max', 0x7f7fffffn],
        ['lowest', 0xff7fffffn],
        ['subnormal', 1n],
      ];
    case 'f64':
      return [
        ['neg_zero', 0x8000000000000000n],
        ['one_and_half', 0x3ff8000000000000n],
        ['nan', 0x7ff8000000000000n],
        ['inf', 0x7ff0000000000000n],
        ['neg_inf', 0xfff0000000000000n],
        ['max', 0x7fefffffffffffffn],
        ['lowest', 0xffefffffffffffffn],
        ['subnormal', 1n],
      ];
    case 'i8':
    case 'i16':
    case 'i32':
    case 'i64':
      return [
        ['min', -(1n << (bits - 1n))],
        ['minus1', -1n],
        ['one', 1n],
        ['max', (1n << (bits - 1n)) - 1n],
      ];
    default:
      return [
        ['one', 1n],
        ['high_bit', 1n << (bits - 1n)],
        ['max', (1n << bits) - 1n],
      ];
  }
}

function primitiveProfile(name: PrimitiveType, profile: Profile): bigint {
  if (profile === 'zero') return 0n;
  if (name === 'bool') return profile === 'max' ? 1n : 0n;
  const bits = BigInt(PRIMITIVE_SIZES[name] * 8);
  const signed = name.startsWith('i');
  if (name === 'f32') return profile === 'min' ? 0xff7fffffn : 0x7f7fffffn;
  if (name === 'f64') return profile === 'min' ? 0xffefffffffffffffn : 0x7fefffffffffffffn;
  if (profile === 'min') return signed ? -(1n << (bits - 1n)) : 0n;
  return signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
}

/** Builds the corpus for a protocol. The result depends only on the protocol and the options. */
export function generateFuzz(protocol: Protocol, options: FuzzOptions = {}): FuzzCorpus {
  const seed = options.seed ?? FUZZ_DEFAULTS.seed;
  const count = options.count ?? FUZZ_DEFAULTS.count;
  const maxSize = options.maxSize ?? FUZZ_DEFAULTS.maxSize;
  return new Builder(protocol, seed, count, maxSize, options.maxSamples).build();
}

class Builder {
  private tooLarge = 0;

  constructor(
    private readonly protocol: Protocol,
    private readonly seed: number,
    private readonly count: number,
    private readonly maxSize: number,
    private readonly maxSamples: number | undefined,
  ) {}

  build(): FuzzCorpus {
    const { protocol } = this;
    const boundary: Pending[] = [];
    const invalid: Pending[] = [];
    const truncated: Pending[] = [];
    const random: Pending[] = [];
    for (const packet of protocol.packets) {
      this.boundarySamples(packet, boundary);
      this.invalidSamples(packet, invalid, truncated);
      this.randomSamples(packet, random);
    }
    for (const direction of ['c2s', 's2c'] as const) this.opcodeSamples(direction, invalid);

    const seen = new Set<string>();
    const unique: Pending[] = [];
    for (const item of [...boundary, ...invalid, ...truncated, ...random]) {
      const key = `${item.direction}:${Buffer.from(item.data).toString('base64')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    const kept = this.maxSamples === undefined ? unique : unique.slice(0, this.maxSamples);

    const names = new Set<string>();
    const samples = kept.map((item): FuzzSample => {
      const folder = item.valid ? 'valid' : 'invalid';
      let name = sanitize(item.name);
      // Case-insensitive file systems would merge names that differ only in case.
      for (let n = 2; names.has(`${folder}/${name}`.toLowerCase()); n++) {
        name = `${sanitize(item.name)}-${n}`;
      }
      names.add(`${folder}/${name}`.toLowerCase());
      return {
        file: `${folder}/${name}.bin`,
        data: item.data,
        packet: item.packet,
        direction: item.direction,
        valid: item.valid,
        error: item.error,
        kind: item.kind,
      };
    });

    return {
      samples,
      manifest: {
        format: 1,
        protocol: protocol.name,
        version: protocol.version ?? null,
        endian: protocol.endian,
        opcode: protocol.opcode,
        seed: this.seed,
        count: this.count,
        maxSize: this.maxSize,
        skipped: { tooLarge: this.tooLarge, overLimit: unique.length - kept.length },
        samples: samples.map(({ data, ...rest }) => ({ ...rest, size: data.length })),
      },
    };
  }

  private uint(value: bigint, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let rest = BigInt.asUintN(size * 8, value);
    for (let i = 0; i < size; i++) {
      out[this.protocol.endian === 'little' ? i : size - 1 - i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return out;
  }

  private prefix(type: LengthType, value: number): Uint8Array {
    return this.uint(BigInt(value), PRIMITIVE_SIZES[type]);
  }

  private opcodeBytes(opcode: number): Uint8Array {
    return this.uint(BigInt(opcode), PRIMITIVE_SIZES[this.protocol.opcode]);
  }

  private enumBytes(definition: Enum, value: number): Uint8Array {
    return this.uint(BigInt(value), PRIMITIVE_SIZES[definition.type]);
  }

  private add(out: Pending[], item: Omit<Pending, 'name'> & { name: string[] }): void {
    if (item.data.length > this.maxSize) {
      this.tooLarge++;
      return;
    }
    out.push({ ...item, name: item.name.join('-') });
  }

  /** Encodes one value of the given type: all zero, the lowest values, or the highest values. */
  private profile(type: FieldType, profile: Profile, depth: number): Uint8Array {
    switch (type.kind) {
      case 'primitive':
        return this.uint(primitiveProfile(type.name, profile), PRIMITIVE_SIZES[type.name]);
      case 'string':
      case 'bytes': {
        const body =
          profile !== 'max'
            ? new Uint8Array(0)
            : type.kind === 'string'
              ? encoder.encode('ok聊\u{1f600}')
              : Uint8Array.of(0xff, 0, 0x7f);
        return concat([this.prefix(type.length, body.length), body]);
      }
      case 'fixedBytes':
        return new Uint8Array(type.size).fill(profile === 'max' ? 0xff : 0);
      case 'enum': {
        const definition = findEnum(this.protocol, type.name);
        const { values } = definition;
        const pick = profile === 'max' ? values[values.length - 1]! : values[0]!;
        return this.enumBytes(definition, pick.value);
      }
      case 'struct':
        return concat(
          findStruct(this.protocol, type.name).fields.map((f) =>
            this.profile(f.type, profile, depth + 1),
          ),
        );
      case 'array': {
        // The element is not built for an empty array: it may contain this array again.
        if (profile !== 'max' || depth >= MAX_DEPTH) return this.prefix(type.length, 0);
        return concat([
          this.prefix(type.length, 2),
          repeat(this.profile(type.element, profile, depth + 1), 2),
        ]);
      }
      case 'fixedArray':
        return repeat(this.profile(type.element, profile, depth + 1), type.size);
      case 'bits':
        return this.packBits(
          type,
          type.fields.map((f) => this.bitProfile(f, profile)),
        );
    }
  }

  /** Packs one value per bit field, lowest bits first; the unused high bits stay 0. */
  private packBits(type: BitsType, values: bigint[]): Uint8Array {
    let packed = 0n;
    for (const [i, { offset }] of bitLayout(type.fields).entries()) {
      packed |= values[i]! << BigInt(offset);
    }
    return this.uint(packed, PRIMITIVE_SIZES[type.base]);
  }

  private bitProfile(field: BitField, profile: Profile): bigint {
    if (field.type.kind === 'enum') {
      const { values } = findEnum(this.protocol, field.type.name);
      return BigInt((profile === 'max' ? values[values.length - 1]! : values[0]!).value);
    }
    return profile === 'max' ? (1n << BigInt(field.bits)) - 1n : 0n;
  }

  /** Each bit field in turn at its edge values, the others at their zero profile. */
  private bitVariants(type: BitsType, mode: Mode): Variant[] {
    if (mode === 'length') return [];
    const defaults = type.fields.map((f) => this.bitProfile(f, 'zero'));
    const result: Variant[] = [];
    type.fields.forEach((field, j) => {
      const values: [string, bigint][] = [];
      if (field.type.kind === 'enum') {
        const definition = findEnum(this.protocol, field.type.name);
        const used = new Set(definition.values.map((v) => v.value));
        if (mode === 'valid') {
          const seen = new Set<number>([definition.values[0]!.value]);
          for (const v of definition.values) {
            if (!seen.has(v.value) && seen.add(v.value)) values.push([v.name, BigInt(v.value)]);
          }
        } else {
          // The highest and the lowest value the bits can hold that no member uses.
          const high = 2 ** field.bits - 1;
          const free = [high, 0].map((start) => {
            for (let v = start; v >= 0 && v <= high; v += start === 0 ? 1 : -1) {
              if (!used.has(v)) return v;
            }
            return undefined;
          });
          for (const v of new Set(free)) if (v !== undefined) values.push([`bad_${v}`, BigInt(v)]);
        }
      } else if (mode === 'valid') {
        values.push([field.type.kind === 'bool' ? 'true' : 'max', (1n << BigInt(field.bits)) - 1n]);
      }
      for (const [label, value] of values) {
        const packed = defaults.map((d, i) => (i === j ? value : d));
        result.push({ label: `${field.name}-${label}`, bytes: this.packBits(type, packed) });
      }
    });
    return result;
  }

  private embed(label: string, before: Uint8Array[], inner: Variant, after: Uint8Array[]): Variant {
    const start = before.reduce((sum, part) => sum + part.length, 0);
    return {
      label,
      bytes: concat([...before, inner.bytes, ...after]),
      patch: inner.patch && { ...inner.patch, offset: inner.patch.offset + start },
    };
  }

  /** Edge-case encodings of a value of this type; the all-default value is not repeated. */
  private variants(type: FieldType, mode: Mode, room: number, depth: number): Variant[] {
    const all = this.rawVariants(type, mode, room, depth);
    const fits = all.filter((v) => v.bytes.length <= room);
    this.tooLarge += all.length - fits.length;
    return fits;
  }

  private rawVariants(type: FieldType, mode: Mode, room: number, depth: number): Variant[] {
    switch (type.kind) {
      case 'primitive':
        if (mode !== 'valid') return [];
        return primitiveValues(type.name).map(([label, value]) => ({
          label,
          bytes: this.uint(value, PRIMITIVE_SIZES[type.name]),
        }));
      case 'string':
      case 'bytes':
        return this.sizedVariants(type, mode, room);
      case 'fixedBytes': {
        if (mode !== 'valid') return [];
        const pattern = Uint8Array.from({ length: type.size }, (_, i) => (i * 37 + 1) & 0xff);
        return [
          { label: 'ones', bytes: new Uint8Array(type.size).fill(0xff) },
          { label: 'pattern', bytes: pattern },
        ];
      }
      case 'enum':
        return this.enumVariants(findEnum(this.protocol, type.name), mode);
      case 'struct': {
        if (depth >= MAX_DEPTH) return [];
        const fields = findStruct(this.protocol, type.name).fields;
        const defaults = fields.map((f) => this.profile(f.type, 'zero', depth + 1));
        const total = defaults.reduce((sum, d) => sum + d.length, 0);
        const result: Variant[] = this.profiles(type, mode, depth);
        fields.forEach((field, j) => {
          const others = total - defaults[j]!.length;
          for (const v of this.variants(field.type, mode, room - others, depth + 1)) {
            result.push(
              this.embed(
                `${field.name}-${v.label}`,
                defaults.slice(0, j),
                v,
                defaults.slice(j + 1),
              ),
            );
          }
        });
        return result;
      }
      case 'array': {
        if (depth >= MAX_DEPTH) return [];
        const size = PRIMITIVE_SIZES[type.length];
        const element = this.profile(type.element, 'zero', depth + 1);
        const result: Variant[] = this.profiles(type, mode, depth);
        if (mode === 'length') {
          result.push({
            label: 'count',
            bytes: this.prefix(type.length, 0),
            patch: { offset: 0, size, pastEnd: element.length > 0 },
          });
        }
        if (mode === 'valid') {
          result.push({
            label: 'one',
            bytes: concat([this.prefix(type.length, 1), element]),
          });
          const fit =
            element.length === 0 ? EMPTY_ELEMENT_COUNT : Math.floor((room - size) / element.length);
          const items = Math.min(LENGTH_MAX[type.length], fit);
          if (items >= 2) {
            result.push({
              label: items === LENGTH_MAX[type.length] ? 'max' : 'fill',
              bytes: concat([this.prefix(type.length, items), repeat(element, items)]),
            });
          }
        }
        for (const v of this.variants(type.element, mode, room - size, depth + 1)) {
          result.push(this.embed(`elem-${v.label}`, [this.prefix(type.length, 1)], v, []));
        }
        return result;
      }
      case 'bits':
        return this.bitVariants(type, mode);
      case 'fixedArray': {
        if (depth >= MAX_DEPTH || type.size < 1) return [];
        const element = this.profile(type.element, 'zero', depth + 1);
        const rest = repeat(element, type.size - 1);
        const result: Variant[] = this.profiles(type, mode, depth);
        for (const v of this.variants(type.element, mode, room - rest.length, depth + 1)) {
          result.push(this.embed(`first-${v.label}`, [], v, [rest]));
        }
        return result;
      }
    }
  }

  private profiles(type: FieldType, mode: Mode, depth: number): Variant[] {
    if (mode !== 'valid') return [];
    return (['min', 'max'] as const).map((p) => ({
      label: `all_${p}`,
      bytes: this.profile(type, p, depth),
    }));
  }

  private enumVariants(definition: Enum, mode: Mode): Variant[] {
    if (mode === 'length') return [];
    if (mode === 'valid') {
      const seen = new Set<number>([definition.values[0]!.value]);
      return definition.values
        .filter((v) => !seen.has(v.value) && seen.add(v.value))
        .map((v) => ({ label: v.name, bytes: this.enumBytes(definition, v.value) }));
    }
    // The highest and the lowest value that no member uses.
    const used = new Set(definition.values.map((v) => v.value));
    const [low, high] = INT_RANGES[definition.type];
    const bad: number[] = [];
    for (let v = high; v >= low && v > high - used.size - 2; v--) {
      if (!used.has(v)) {
        bad.push(v);
        break;
      }
    }
    for (let v = low; v <= high && v < low + used.size + 2; v++) {
      if (!used.has(v)) {
        if (!bad.includes(v)) bad.push(v);
        break;
      }
    }
    return bad.map((v) => ({
      label: `bad_${v < 0 ? `n${-v}` : v}`,
      bytes: this.enumBytes(definition, v),
    }));
  }

  private sizedVariants(
    type: { kind: 'string' | 'bytes'; length: LengthType },
    mode: Mode,
    room: number,
  ): Variant[] {
    const size = PRIMITIVE_SIZES[type.length];
    if (mode === 'enum') return [];
    if (mode === 'length') {
      return [
        {
          label: 'length',
          bytes: this.prefix(type.length, 0),
          patch: { offset: 0, size, pastEnd: true },
        },
      ];
    }
    const make = (label: string, body: Uint8Array): Variant => ({
      label,
      bytes: concat([this.prefix(type.length, body.length), body]),
    });
    const fit = Math.min(LENGTH_MAX[type.length], room - size);
    const label = fit === LENGTH_MAX[type.length] ? 'max' : 'fill';
    if (type.kind === 'string') {
      const filler = Uint8Array.from({ length: Math.max(fit, 0) }, (_, i) => 97 + (i % 26));
      return [
        make('ascii', encoder.encode('abc')),
        make('utf8', encoder.encode('聊天 ok\u{1f600}')),
        ...(fit > 0 ? [make(label, filler)] : []),
      ];
    }
    const filler = Uint8Array.from({ length: Math.max(fit, 0) }, (_, i) => (i * 131 + 7) & 0xff);
    return [make('one', Uint8Array.of(0xff)), ...(fit > 0 ? [make(label, filler)] : [])];
  }

  /** Opcode followed by the fields at their defaults, with field `index` replaced. */
  private assemble(packet: Packet, defaults: Uint8Array[], index: number, v: Variant) {
    const head = this.opcodeBytes(packet.opcode);
    const before = [head, ...defaults.slice(0, index)];
    const bytes = concat([...before, v.bytes, ...defaults.slice(index + 1)]);
    const start = before.reduce((sum, part) => sum + part.length, 0);
    return { bytes, patch: v.patch && { ...v.patch, offset: v.patch.offset + start } };
  }

  private fieldVariants(packet: Packet, mode: Mode) {
    const defaults = packet.fields.map((f) => this.profile(f.type, 'zero', 0));
    const total =
      PRIMITIVE_SIZES[this.protocol.opcode] + defaults.reduce((sum, d) => sum + d.length, 0);
    const result: { label: string; bytes: Uint8Array; patch?: Patch }[] = [];
    packet.fields.forEach((field, j) => {
      const room = this.maxSize - (total - defaults[j]!.length);
      for (const v of this.variants(field.type, mode, room, 0)) {
        result.push({
          label: `${field.name}-${v.label}`,
          ...this.assemble(packet, defaults, j, v),
        });
      }
    });
    return result;
  }

  private wholePacket(packet: Packet, profile: Profile): Uint8Array {
    return concat([
      this.opcodeBytes(packet.opcode),
      ...packet.fields.map((f) => this.profile(f.type, profile, 0)),
    ]);
  }

  private boundarySamples(packet: Packet, out: Pending[]): void {
    const base = { direction: packet.direction, packet: packet.name, valid: true } as const;
    for (const profile of ['zero', 'min', 'max'] as const) {
      this.add(out, {
        ...base,
        name: [packet.direction, packet.name, profile],
        data: this.wholePacket(packet, profile),
        error: null,
        kind: 'boundary',
      });
    }
    for (const v of this.fieldVariants(packet, 'valid')) {
      this.add(out, {
        ...base,
        name: [packet.direction, packet.name, v.label],
        data: v.bytes,
        error: null,
        kind: 'boundary',
      });
    }
  }

  private invalidSamples(packet: Packet, out: Pending[], cuts: Pending[]): void {
    const base = { direction: packet.direction, packet: packet.name, valid: false } as const;
    for (const v of this.fieldVariants(packet, 'enum')) {
      this.add(out, {
        ...base,
        name: [packet.direction, packet.name, 'enum', v.label],
        data: v.bytes,
        error: 'invalid',
        kind: 'unknown_enum',
      });
    }
    for (const v of this.fieldVariants(packet, 'length')) {
      if (!v.patch) continue;
      const { offset, size } = v.patch;
      const tail = v.bytes.length - offset - size;
      const limit = Math.min(2 ** (size * 8) - 1, 0x7fffffff);
      if (v.patch.pastEnd && tail + 1 <= limit) {
        this.add(out, {
          ...base,
          name: [packet.direction, packet.name, 'length', v.label],
          data: this.patched(v.bytes, v.patch, tail + 1),
          error: 'truncated',
          kind: 'length_past_end',
        });
      }
      if (size === 4) {
        this.add(out, {
          ...base,
          name: [packet.direction, packet.name, 'length', v.label, 'too_large'],
          data: this.patched(v.bytes, v.patch, LENGTH_TOO_LARGE),
          error: 'invalid',
          kind: 'length_too_large',
        });
      }
    }

    const whole = this.wholePacket(packet, 'max');
    if (whole.length > this.maxSize) {
      this.tooLarge++;
      return;
    }
    const lengths = Array.from({ length: whole.length }, (_, i) => i).filter(
      (n) =>
        whole.length <= TRUNCATE_ALL_UP_TO ||
        n < TRUNCATE_ALL_UP_TO / 2 ||
        n >= whole.length - TRUNCATE_ALL_UP_TO / 2,
    );
    const width = String(whole.length).length;
    for (const n of lengths) {
      this.add(cuts, {
        ...base,
        name: [packet.direction, packet.name, 'truncated', String(n).padStart(width, '0')],
        data: whole.slice(0, n),
        error: 'truncated',
        kind: 'truncated',
      });
    }
  }

  private patched(bytes: Uint8Array, patch: Patch, value: number): Uint8Array {
    const out = bytes.slice();
    out.set(this.uint(BigInt(value), patch.size), patch.offset);
    return out;
  }

  /** Unused opcodes, plus opcodes that only exist in the other direction. */
  private opcodeSamples(direction: Direction, out: Pending[]): void {
    const used = new Set<number>();
    const other = new Map<number, string>();
    for (const packet of this.protocol.packets) {
      if (packet.direction === direction) used.add(packet.opcode);
    }
    for (const packet of this.protocol.packets) {
      if (packet.direction !== direction && !used.has(packet.opcode)) {
        other.set(packet.opcode, packet.name);
      }
    }
    const [low, high] = INT_RANGES[this.protocol.opcode];
    const free: number[] = [];
    for (let v = low; v <= high && free.length < 1; v++) if (!used.has(v)) free.push(v);
    for (let v = high; v >= low; v--) {
      if (!used.has(v)) {
        if (!free.includes(v)) free.push(v);
        break;
      }
    }
    const width = this.protocol.opcode === 'u8' ? 2 : 4;
    const hex = (v: number): string => v.toString(16).padStart(width, '0');
    const base = { direction, packet: null, valid: false } as const;
    for (const v of free) {
      this.add(out, {
        ...base,
        name: [direction, 'unknown_opcode', hex(v)],
        data: this.opcodeBytes(v),
        error: 'invalid',
        kind: 'unknown_opcode',
      });
    }
    for (const [v, name] of other) {
      this.add(out, {
        ...base,
        name: [direction, 'unknown_opcode', hex(v), 'only', name],
        data: this.opcodeBytes(v),
        error: 'invalid',
        kind: 'unknown_opcode',
      });
    }
  }

  private randomSamples(packet: Packet, out: Pending[]): void {
    const rng = new Rng(this.seed, `${packet.direction}/${packet.name}`);
    const width = String(this.count).length;
    for (let i = 1; i <= this.count; i++) {
      const data = concat([
        this.opcodeBytes(packet.opcode),
        ...packet.fields.map((f) => this.random(f.type, rng, 0)),
      ]);
      this.add(out, {
        direction: packet.direction,
        packet: packet.name,
        name: [packet.direction, packet.name, 'random', String(i).padStart(width, '0')],
        data,
        valid: true,
        error: null,
        kind: 'random',
      });
    }
  }

  private randomLength(type: LengthType, rng: Rng, small: number): number {
    const bound = rng.below(10) === 0 ? 300 : small;
    return rng.below(Math.min(LENGTH_MAX[type], bound) + 1);
  }

  private random(type: FieldType, rng: Rng, depth: number): Uint8Array {
    switch (type.kind) {
      case 'primitive':
        return this.uint(this.randomBits(type.name, rng), PRIMITIVE_SIZES[type.name]);
      case 'string': {
        const limit = this.randomLength(type.length, rng, 24);
        const parts: Uint8Array[] = [];
        let used = 0;
        for (;;) {
          const char = encoder.encode(String.fromCodePoint(this.randomCodePoint(rng)));
          if (used + char.length > limit) break;
          parts.push(char);
          used += char.length;
        }
        return concat([this.prefix(type.length, used), ...parts]);
      }
      case 'bytes': {
        const body = this.randomBytes(rng, this.randomLength(type.length, rng, 24));
        return concat([this.prefix(type.length, body.length), body]);
      }
      case 'fixedBytes':
        return this.randomBytes(rng, type.size);
      case 'enum': {
        const definition = findEnum(this.protocol, type.name);
        return this.enumBytes(
          definition,
          definition.values[rng.below(definition.values.length)]!.value,
        );
      }
      case 'struct':
        return concat(
          findStruct(this.protocol, type.name).fields.map((f) =>
            this.random(f.type, rng, depth + 1),
          ),
        );
      case 'array': {
        const items = depth >= MAX_DEPTH ? 0 : rng.below(Math.min(LENGTH_MAX[type.length], 6) + 1);
        return concat([
          this.prefix(type.length, items),
          ...Array.from({ length: items }, () => this.random(type.element, rng, depth + 1)),
        ]);
      }
      case 'fixedArray':
        return concat(
          Array.from({ length: type.size }, () => this.random(type.element, rng, depth + 1)),
        );
      case 'bits':
        return this.packBits(
          type,
          type.fields.map((field) => {
            if (field.type.kind !== 'enum') return rng.bits(field.bits);
            const { values } = findEnum(this.protocol, field.type.name);
            return BigInt(values[rng.below(values.length)]!.value);
          }),
        );
    }
  }

  private randomBits(name: PrimitiveType, rng: Rng): bigint {
    if (name === 'bool') return BigInt(rng.below(2));
    const bits = PRIMITIVE_SIZES[name] * 8;
    const value = rng.bits(bits);
    if (name === 'f32' || name === 'f64') {
      // Any NaN becomes the standard one so decoders that normalize it still round-trip.
      const exponent = name === 'f32' ? 0xffn << 23n : 0x7ffn << 52n;
      const fraction = name === 'f32' ? (1n << 23n) - 1n : (1n << 52n) - 1n;
      if ((value & exponent) === exponent && (value & fraction) !== 0n) {
        return exponent | ((fraction + 1n) / 2n);
      }
      return value;
    }
    switch (rng.below(8)) {
      case 0:
        return 0n;
      case 1:
        return (1n << BigInt(bits)) - 1n;
      case 2:
        return 1n << BigInt(bits - 1);
      default:
        return value;
    }
  }

  private randomBytes(rng: Rng, length: number): Uint8Array {
    return Uint8Array.from({ length }, () => rng.below(256));
  }

  private randomCodePoint(rng: Rng): number {
    switch (rng.below(4)) {
      case 0:
        return 0x20 + rng.below(0x5f);
      case 1:
        return 0xa1 + rng.below(0x5e);
      case 2:
        return 0x4e00 + rng.below(0x5200);
      default:
        return 0x1f600 + rng.below(0x50);
    }
  }
}
