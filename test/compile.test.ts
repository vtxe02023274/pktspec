import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';

const load = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);
}

const header = 'name: test\n';

describe('compile', () => {
  it('accepts the chat-room example', () => {
    const { protocol, diagnostics } = compile(load('../examples/chat-room.yaml'));
    expect(diagnostics).toEqual([]);
    expect(protocol?.packets.map((p) => p.name)).toEqual([
      'Login',
      'LoginResult',
      'JoinRoom',
      'RoomJoined',
      'Say',
      'Message',
      'LeaveRoom',
      'UserLeft',
    ]);
  });

  it('resolves every kind of type', () => {
    const { protocol, diagnostics } = compile(load('fixtures/all-types.yaml'));
    expect(diagnostics).toEqual([]);
    expect(protocol).toMatchObject({ name: 'all_types', version: '2.1', endian: 'big' });
    const texts = protocol!.packets.find((p) => p.name === 'Texts')!;
    expect(texts.fields.map((f) => f.type)).toEqual([
      { kind: 'string', length: 'u8' },
      { kind: 'string', length: 'u16' },
      { kind: 'string', length: 'u32' },
      { kind: 'bytes', length: 'u32' },
      { kind: 'fixedBytes', size: 4 },
    ]);
    const collections = protocol!.packets.find((p) => p.name === 'Collections')!;
    expect(collections.fields.map((f) => f.type)).toEqual([
      { kind: 'array', length: 'u16', element: { kind: 'primitive', name: 'u32' } },
      { kind: 'array', length: 'u8', element: { kind: 'string', length: 'u16' } },
      { kind: 'fixedArray', size: 3, element: { kind: 'primitive', name: 'bool' } },
      { kind: 'fixedArray', size: 4, element: { kind: 'struct', name: 'Point' } },
      { kind: 'array', length: 'u32', element: { kind: 'struct', name: 'Point' } },
      { kind: 'array', length: 'u16', element: { kind: 'enum', name: 'Small' } },
    ]);
  });

  it('keeps an unquoted version as written', () => {
    expect(compile(`${header}version: 1.10\n`).protocol?.version).toBe('1.10');
    expect(compile(`${header}version: 1.0 # first\n`).protocol?.version).toBe('1.0');
    expect(compile(`${header}version: 2\n`).protocol?.version).toBe('2');
  });

  it('applies defaults', () => {
    const { protocol } = compile(header);
    expect(protocol).toMatchObject({ endian: 'little', opcode: 'u16', packets: [] });
  });

  it('reports YAML syntax errors with their position', () => {
    expect(errors('name: test\nname: again\n')).toEqual(['2:1 Map keys must be unique']);
  });

  it('reports duplicate opcodes in the same direction only', () => {
    const source = `${header}packets:
  - { name: A, opcode: 1, direction: c2s }
  - { name: B, opcode: 1, direction: s2c }
  - { name: C, opcode: 0x01, direction: c2s }
`;
    expect(errors(source)).toEqual(["5:24 opcode 0x01 (c2s) is already used by 'A' at line 3"]);
  });

  it('reports duplicate names across packets, structs and enums', () => {
    const source = `${header}enums:
  Thing: { type: u8, values: { A: 0 } }
structs:
  Thing: { fields: [] }
packets:
  - { name: Thing, opcode: 1, direction: c2s }
`;
    expect(errors(source)).toEqual([
      "5:3 'Thing' is already defined as enum at line 3",
      "7:13 'Thing' is already defined as enum at line 3",
    ]);
  });

  it('rejects names that differ only in case', () => {
    const source = `${header}structs:
  User: { fields: [] }
packets:
  - { name: USER, opcode: 1, direction: c2s }
`;
    expect(errors(source)).toEqual([
      "5:13 'USER' differs only in case from struct 'User' at line 3; names are used as file names",
    ]);
  });

  it('rejects built-in and lowercase type names', () => {
    const source = `${header}enums:
  u8: { type: u8, values: { A: 0 } }
structs:
  string: { fields: [] }
  goto: { fields: [] }
  point: { fields: [] }
packets:
  - { name: _P, opcode: 1, direction: c2s }
`;
    expect(errors(source)).toEqual([
      "3:3 enum name 'u8' is a built-in type",
      "5:3 struct name 'string' is a built-in type",
      "6:3 struct name 'goto' must start with an uppercase letter",
      "7:3 struct name 'point' must start with an uppercase letter",
      "9:13 packet name '_P' must start with an uppercase letter",
    ]);
  });

  it('reports duplicate and clashing field names', () => {
    const source = `${header}structs:
  S:
    fields:
      - { name: room_id, type: u8 }
      - { name: room_id, type: u8 }
      - { name: roomId, type: u8 }
`;
    expect(errors(source)).toEqual([
      "6:17 duplicate field 'room_id'",
      "7:17 field 'roomId' clashes with 'room_id' once converted to camelCase",
    ]);
  });

  it('rejects field names that do not start with a letter after leading underscores', () => {
    const source = `${header}structs:
  S:
    fields:
      - { name: _1st, type: u8 }
      - { name: _, type: u8 }
      - { name: __, type: u8 }
      - { name: _ok, type: u8 }
`;
    expect(errors(source)).toEqual([
      "5:17 field name '_1st' must start with a letter once leading underscores are dropped for camelCase",
      "6:17 field name '_' must start with a letter once leading underscores are dropped for camelCase",
      "7:17 field name '__' must start with a letter once leading underscores are dropped for camelCase",
    ]);
  });

  it('reports unknown types with a suggestion', () => {
    const source = `${header}structs:
  S:
    fields:
      - { name: a, type: U16 }
      - { name: b, type: Missing }
      - { name: c, type: 'u8[0]' }
      - { name: d, type: 'u8[][]' }
      - { name: e, type: 'bytes[]' }
`;
    expect(errors(source)).toEqual([
      "5:26 unknown type 'U16'; did you mean 'u16'?",
      "6:26 unknown type 'Missing'",
      '7:26 array size must be greater than 0',
      "8:26 invalid type 'u8[][]'",
      '9:26 arrays of bytes are not supported; wrap bytes in a struct',
    ]);
  });

  it('rejects packets used as field types', () => {
    const source = `${header}packets:
  - { name: A, opcode: 1, direction: c2s }
  - name: B
    opcode: 2
    direction: c2s
    fields: [{ name: a, type: A }]
`;
    expect(errors(source)).toEqual([
      "7:31 'A' is a packet; only structs and enums can be used as field types",
    ]);
  });

  it('reports invalid length settings', () => {
    const source = `${header}structs:
  S:
    fields:
      - { name: a, type: u32, length: u8 }
      - { name: b, type: string, length: u64 }
      - { name: c, type: 'u8[4]', length: u8 }
      - { name: d, type: string, size: 4 }
      - { name: e, type: bytes, size: 4, length: u8 }
      - { name: f, type: bytes, size: 0 }
`;
    expect(errors(source)).toEqual([
      "5:31 'length' only applies to string, bytes and [] arrays",
      "6:42 'length' must be one of: u8, u16, u32",
      "7:35 'length' only applies to string, bytes and [] arrays",
      "8:34 'size' only applies to bytes",
      "9:33 'length' and 'size' cannot be combined",
      "10:39 'size' must be greater than 0",
    ]);
  });

  it('checks opcode and enum ranges', () => {
    const source = `name: test
opcode: u8
enums:
  E:
    type: u8
    values: { A: 0, B: 256, C: 0 }
  F:
    type: u64
    values: { A: 0 }
packets:
  - { name: P, opcode: 0x100, direction: up }
`;
    expect(errors(source)).toEqual([
      '6:24 256 does not fit in u8 (0..255)',
      "6:32 value 0 is already used by 'E.A'",
      "8:11 type of enum 'F' must be one of: u8, u16, u32, i8, i16, i32",
      '11:24 opcode 0x100 does not fit in u8',
      "11:42 direction of packet 'P' must be one of: c2s, s2c",
    ]);
  });

  it('reports missing and unknown keys', () => {
    const source = `version: 1
packets:
  - name: P
    opcod: 1
`;
    expect(errors(source)).toEqual([
      "1:1 protocol is missing 'name'",
      "3:5 packet 'P' is missing 'opcode'",
      "3:5 packet 'P' is missing 'direction'",
      "4:5 unknown key 'opcod' in packet; expected one of: name, opcode, direction, doc, fields",
    ]);
  });

  it('rejects structs that contain themselves', () => {
    const source = `${header}structs:
  A: { fields: [{ name: b, type: B }] }
  B: { fields: [{ name: a, type: 'A[2]' }] }
  Tree: { fields: [{ name: children, type: 'Tree[]' }] }
`;
    expect(errors(source)).toEqual(["3:3 struct 'A' contains itself (A -> B -> A)"]);
  });

  it('resolves bit fields', () => {
    const { protocol, diagnostics, locations } = compile(load('fixtures/bit-fields.yaml'));
    expect(diagnostics).toEqual([]);
    const status = protocol!.packets.find((p) => p.name === 'Status')!;
    expect(status.fields[1]).toEqual({
      name: 'state',
      doc: 'Packed player state.',
      type: {
        kind: 'bits',
        base: 'u16',
        fields: [
          { name: 'alive', bits: 1, type: { kind: 'bool' }, doc: 'False once the player is down.' },
          { name: 'team', bits: 2, type: { kind: 'enum', name: 'Team' }, doc: undefined },
          { name: 'level', bits: 7, type: { kind: 'uint' }, doc: undefined },
          { name: 'mood', bits: 2, type: { kind: 'enum', name: 'Mood' }, doc: undefined },
        ],
      },
    });
    expect(locations!.get('packet:Status/field:state/bit:level')).toEqual({ line: 43, column: 21 });
  });

  it('checks bit field sizes, types and enum values', () => {
    const source = `${header}enums:
  E: { type: i8, values: { A: -1, B: 1 } }
  F: { type: u8, values: { A: 0, B: 4 } }
structs:
  S:
    fields:
      - name: a
        type: u8
        bits:
          - { name: x, bits: 0 }
          - { name: y, type: bool, bits: 2 }
          - { name: z }
          - { name: w, type: F, bits: 2 }
          - { name: v, type: E, bits: 2 }
          - { name: u, type: u8, bits: 2 }
          - { name: t, type: Bool }
          - { name: s, type: S, bits: 1 }
      - name: b
        type: u8
        bits:
          - { name: p, bits: 5 }
          - { name: q, bits: 4 }
      - { name: c, type: 'u8[]', bits: [{ name: r, bits: 1 }] }
      - { name: d, type: u64, bits: [{ name: o, bits: 1 }] }
      - { name: e, type: u8, length: u8, bits: [{ name: n, bits: 1 }] }
      - { name: f, type: u8, bits: [] }
      - { name: g, type: u8, bits: { name: m } }
      - { name: h, type: u8, bits: [{ name: _1st, bits: 1, size: 2 }] }
`;
    expect(errors(source)).toEqual([
      "11:30 'bits' of bit field 'x' must be greater than 0",
      '12:42 a bool bit field takes exactly 1 bit',
      "13:13 bit field 'z' is missing 'bits'",
      "14:39 enum 'F' value 'B' (4) does not fit in 2 bits (0..3)",
      "15:39 enum 'E' value 'A' (-1) does not fit in 2 bits (0..3)",
      "16:30 bit field type must be bool or an enum; leave out 'type' for an unsigned integer",
      "17:30 unknown type 'Bool'; did you mean 'bool'?",
      "18:30 bit field type must be bool or an enum; leave out 'type' for an unsigned integer",
      '20:15 bit fields take 9 bits, more than the 8 bits of u8',
      '24:26 bit fields cannot be arrays; wrap them in a struct and use an array of the struct',
      '25:26 bit fields must be stored in one of: u8, u16, u32',
      "26:30 'length' does not apply to bit fields",
      "27:36 'bits' must list at least one field",
      "28:36 'bits' must be a list",
      "29:45 bit field name '_1st' must start with a letter once leading underscores are dropped for camelCase",
      "29:60 unknown key 'size' in bit field; expected one of: name, type, bits, doc",
    ]);
  });

  it('keeps bit field names apart from each other and from the fields around them', () => {
    const source = `${header}packets:
  - name: P
    opcode: 1
    direction: c2s
    fields:
      - { name: room_id, type: u8 }
      - name: flags
        type: u16
        bits:
          - { name: roomId, bits: 1 }
          - { name: flags, bits: 1 }
          - { name: ok, type: bool }
          - { name: ok, type: bool }
      - { name: o_k, type: u8 }
`;
    expect(errors(source)).toEqual([
      "11:21 field 'roomId' clashes with 'room_id' once converted to camelCase",
      "12:21 duplicate field 'flags'",
      "14:21 duplicate field 'ok'",
      "15:17 field 'o_k' clashes with 'ok' once converted to camelCase",
    ]);
  });

  it('resolves conditions on bools, integers, enums and bit fields', () => {
    const { protocol, diagnostics, locations } = compile(load('fixtures/conditional-fields.yaml'));
    expect(diagnostics).toEqual([]);
    const draw = protocol!.packets.find((p) => p.name === 'Draw')!;
    expect(draw.fields.map((f) => [f.name, f.condition])).toEqual([
      ['shape', undefined],
      ['radius', { kind: 'in', field: 'shape', values: [1] }],
      ['corner', { kind: 'in', field: 'shape', values: [2, 3] }],
      ['points', { kind: 'in', field: 'shape', values: [3] }],
      ['closed', { kind: 'in', field: 'shape', values: [3] }],
      ['fill', { kind: 'true', field: 'closed' }],
      ['style', { kind: 'true', field: 'closed' }],
      ['dash', { kind: 'true', field: 'dashed' }],
      ['label', { kind: 'in', field: 'width', values: [0, 15] }],
    ]);
    const profile = protocol!.packets.find((p) => p.name === 'Profile')!;
    expect(profile.fields.find((f) => f.name === 'avatar')!.condition).toEqual({
      kind: 'in',
      field: 'id',
      values: [0, 9007199254740991],
    });
    expect(locations!.get('packet:Draw/field:radius/if')).toEqual({ line: 39, column: 40 });
  });

  it('checks what a condition refers to and the values it compares', () => {
    const source = `${header}enums:
  E: { type: u8, values: { A: 0, B: 1 } }
structs:
  S:
    fields:
      - { name: a, type: E }
      - { name: b, type: u8, if: a }
      - { name: c, type: u8, if: { field: a, equals: C } }
      - { name: d, type: u8, if: { field: a, in: [A, A] } }
      - { name: e, type: u8, if: { field: z, equals: 1 } }
      - { name: f, type: u8, if: { field: g, equals: 1 } }
      - { name: g, type: u8 }
      - { name: h, type: u8, if: h }
      - { name: i, type: string }
      - { name: j, type: u8, if: i }
      - { name: k, type: bool }
      - { name: l, type: u8, if: { field: k, equals: 1 } }
      - { name: m, type: u8, if: { field: g, equals: 256 } }
      - { name: n, type: u8, if: { field: g, in: [] } }
      - { name: o, type: u8, if: { field: g, equals: 1, in: [2] } }
      - { name: p, type: u8, if: { field: g } }
      - name: q
        type: u8
        bits: [{ name: r, bits: 2 }]
      - { name: s, type: u8, if: q }
      - { name: t, type: u8, if: { field: r, equals: 4 } }
      - { name: u, type: u8, if: [g] }
      - { name: v, type: u8, if: { field: G, equals: 1 } }
      - { name: w, type: u8, if: { field: g, equals: x } }
      - { name: x, type: Missing }
      - { name: y, type: u8, if: x }
      - { name: z, type: u8, if: { field: g, equals: 1, other: 2 } }
      - { name: aa, type: f32 }
      - { name: ab, type: u8, if: { field: aa, equals: 1 } }
      - { name: ac, type: u64 }
      - { name: ad, type: u8, if: { field: ac, equals: 9007199254740992 } }
      - name: ae
        type: u8
        if: af
        bits: [{ name: af, type: bool }]
`;
    expect(errors(source)).toEqual([
      "8:34 'a' is an enum; give the values to match with 'equals' or 'in'",
      "9:54 'C' is not a value of enum 'E'; expected one of: A, B",
      "10:54 'A' is listed twice in the condition",
      "11:43 condition of field 'e' refers to 'z', which comes after it; a condition can only test earlier fields",
      "12:43 condition of field 'f' refers to 'g', which comes after it; a condition can only test earlier fields",
      "14:34 field 'h' cannot be its own condition",
      "16:34 condition field 'i' must be a bool, an integer or an enum, not string",
      "18:46 'k' is a bool; write 'if: k' to test it",
      '19:54 256 does not fit in u8 (0..255)',
      "20:50 'in' must be a non-empty list",
      "21:57 'equals' and 'in' cannot be combined",
      "22:34 condition is missing 'equals' or 'in'",
      "26:34 'q' is a group of bit fields; test one of its bit fields",
      '27:54 4 does not fit in 2 bits (0..3)',
      "28:34 'if' must be a field name, or a mapping with 'field' and 'equals' or 'in'",
      "29:43 condition of field 'v' refers to unknown field 'G'; did you mean 'g'?",
      '30:54 condition value must be an integer',
      "31:26 unknown type 'Missing'",
      "33:57 unknown key 'other' in condition; expected one of: field, equals, in",
      "35:44 condition field 'aa' must be a bool, an integer or an enum, not f32",
      '37:56 9007199254740992 does not fit in u64 (0..9007199254740991)',
      "40:13 field 'ae' cannot test its own bit field 'af'",
    ]);
  });
});
