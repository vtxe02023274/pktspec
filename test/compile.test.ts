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
});
