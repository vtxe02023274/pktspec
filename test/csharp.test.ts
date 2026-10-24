import { describe, expect, it } from 'vitest';
import {
  defaultCSharpNamespace,
  generateCSharp,
  isValidCSharpNamespace,
} from '../src/gen/csharp.js';
import { allTypes, bitFields, chatRoom, conditionalFields } from './helpers.js';

describe('generateCSharp', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
    ['bit-fields', bitFields],
    ['conditional-fields', conditionalFields],
  ] as const) {
    it(`matches the golden files for ${name}`, async () => {
      const files = generateCSharp(load());
      for (const file of files) {
        await expect(file.content).toMatchFileSnapshot(`golden/csharp/${name}/${file.path}`);
      }
    });
  }

  it('writes one flat file per type', () => {
    const paths = generateCSharp(chatRoom(), { namespace: 'Example.Chat' }).map((f) => f.path);
    expect(paths).toContain('ChatRoomProtocol.cs');
    expect(paths).toContain('Login.cs');
    expect(paths).toContain('IPacket.cs');
    expect(paths.every((p) => !p.includes('/'))).toBe(true);
  });

  it('uses the namespace option', () => {
    const entry = generateCSharp(chatRoom(), { namespace: 'Example.Chat' }).find(
      (f) => f.path === 'Login.cs',
    )!;
    expect(entry.content).toContain('namespace Example.Chat\n{');
  });

  it('derives a namespace from the protocol name', () => {
    expect(defaultCSharpNamespace('chat-room')).toBe('ChatRoom');
    expect(defaultCSharpNamespace('all_types')).toBe('AllTypes');
    expect(isValidCSharpNamespace('Example.Chat')).toBe(true);
    expect(isValidCSharpNamespace('Example.object')).toBe(false);
    expect(isValidCSharpNamespace('Example..Chat')).toBe(false);
  });

  it('rejects an invalid namespace', () => {
    expect(() => generateCSharp(chatRoom(), { namespace: 'Example.new' })).toThrow(
      "'Example.new' is not a valid C# namespace name",
    );
  });

  it('rejects type names that clash with generated types', () => {
    const protocol = chatRoom();
    protocol.structs.push({ name: 'IPacket', fields: [] });
    expect(() => generateCSharp(protocol)).toThrow("'IPacket' clashes");
  });

  it('rejects type names that differ from generated types only in case', () => {
    for (const name of ['IPACKET', 'ChatRoomCODEC']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateCSharp(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('rejects type names that clash with types the generated code uses', () => {
    for (const name of ['List', 'Encoding', 'ArgumentException', 'Encode', 'Math']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateCSharp(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('escapes keywords used as constructor parameter names', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Keywords',
      fields: [{ name: 'class', type: { kind: 'primitive', name: 'u8' } }],
    });
    const file = generateCSharp(protocol).find((f) => f.path === 'Keywords.cs')!;
    expect(file.content).toContain('public byte Class { get; set; }');
    expect(file.content).toContain('public Keywords(byte @class)');
    expect(file.content).toContain('this.Class = @class;');
  });

  it('renames members that clash with generated members or the class name', () => {
    const protocol = chatRoom();
    const u8 = { kind: 'primitive', name: 'u8' } as const;
    protocol.structs.push({
      name: 'Clashes',
      fields: [
        { name: 'opcode', type: u8 },
        { name: 'body_size', type: u8 },
        { name: 'clashes', type: u8 },
        { name: 'to_string', type: u8 },
      ],
    });
    const file = generateCSharp(protocol).find((f) => f.path === 'Clashes.cs')!;
    expect(file.content).toContain('public byte Opcode_ { get; set; }');
    expect(file.content).toContain('public byte BodySize_ { get; set; }');
    expect(file.content).toContain('public byte Clashes_ { get; set; }');
    expect(file.content).toContain('public byte ToString_ { get; set; }');
  });

  it('renames members that would hide a generated type', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Hides',
      fields: [
        {
          name: 'user',
          type: { kind: 'array', element: { kind: 'struct', name: 'User' }, length: 'u8' },
        },
        { name: 'kind', type: { kind: 'enum', name: 'RoomKind' } },
      ],
    });
    const file = generateCSharp(protocol).find((f) => f.path === 'Hides.cs')!;
    expect(file.content).toContain('public List<User> User_ { get; set; }');
    expect(file.content).toContain('public RoomKind Kind { get; set; }');
  });

  it('keeps a member named like its own type', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Holder',
      fields: [{ name: 'user', type: { kind: 'struct', name: 'User' } }],
    });
    const file = generateCSharp(protocol).find((f) => f.path === 'Holder.cs')!;
    expect(file.content).toContain('public User User { get; set; } = new User();');
  });

  it('turns enum value names into PascalCase', () => {
    const entry = generateCSharp(chatRoom()).find((f) => f.path === 'LoginStatus.cs')!;
    expect(entry.content).toContain('        BadPassword = 1,');
    expect(entry.content).toContain('        ServerFull = 3,');
    expect(entry.content).toContain('public enum LoginStatus : byte');
  });

  it('keeps enum member names unique', () => {
    const protocol = chatRoom();
    protocol.enums.push({
      name: 'Mode',
      type: 'u8',
      values: [
        { name: 'A_B', value: 0 },
        { name: 'AB', value: 1 },
        { name: 'aB', value: 2 },
        { name: '_', value: 3 },
        { name: '_1', value: 4 },
      ],
    });
    const file = generateCSharp(protocol).find((f) => f.path === 'Mode.cs')!;
    expect(file.content).toContain(
      '        AB = 0,\n        Ab = 1,\n        AB_ = 2,\n        _ = 3,\n        _1 = 4,',
    );
  });

  it('writes docs as XML comments without breaking the comment', () => {
    const protocol = chatRoom();
    protocol.doc = 'Saves <a> & b\r\nsecond third\n\n\\ done';
    const entry = generateCSharp(protocol).find((f) => f.path === 'ChatRoomProtocol.cs')!;
    expect(entry.content).toContain(
      '    /// <summary>\n    /// Saves &lt;a&gt; &amp; b\n    /// second\n    /// third\n    ///\n    /// \\ done\n    /// </summary>\n',
    );
    expect(entry.content).not.toContain(' ');
  });

  it('writes protocol names and versions as ASCII string literals', () => {
    const protocol = chatRoom();
    protocol.version = 'v聊 "1"\\';
    const files = generateCSharp(protocol);
    const entry = files.find((f) => f.path === 'ChatRoomProtocol.cs')!;
    expect(entry.content).toContain('ProtocolVersion = "v\\u804a \\"1\\"\\\\";');
    for (const file of files) expect(file.content).not.toMatch(/[^\t\n\x20-\x7e]/);
  });
});
