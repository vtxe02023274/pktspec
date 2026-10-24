import { describe, expect, it } from 'vitest';
import { generateTypeScript } from '../src/gen/typescript.js';
import { allTypes, bitFields, chatRoom, conditionalFields } from './helpers.js';

describe('generateTypeScript', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
    ['bit-fields', bitFields],
    ['conditional-fields', conditionalFields],
  ] as const) {
    it(`matches the golden files for ${name}`, async () => {
      const files = generateTypeScript(load());
      for (const file of files) {
        await expect(file.content).toMatchFileSnapshot(`golden/typescript/${name}/${file.path}`);
      }
    });
  }

  it('writes one flat file per type', () => {
    const paths = generateTypeScript(chatRoom()).map((f) => f.path);
    expect(paths).toContain('ChatRoomProtocol.ts');
    expect(paths).toContain('ChatRoomCodec.ts');
    expect(paths).toContain('Login.ts');
    expect(paths).toContain('Packet.ts');
    expect(paths).toContain('index.ts');
    expect(paths.every((p) => !p.includes('/') && p.endsWith('.ts'))).toBe(true);
  });

  it('imports with explicit .js extensions', () => {
    for (const file of generateTypeScript(allTypes())) {
      for (const match of file.content.matchAll(/(?:from|export \* from) '([^']+)'/g)) {
        expect(match[1], file.path).toMatch(/^\.\/[A-Za-z0-9_]+\.js$/);
      }
    }
  });

  it('does not use enum, namespace or parameter properties', () => {
    for (const file of generateTypeScript(allTypes())) {
      expect(file.content, file.path).not.toMatch(/^(export )?(const )?enum /m);
      expect(file.content, file.path).not.toMatch(/\bnamespace\b|constructor\(\s*(public|private)/);
    }
  });

  it('rejects type names that clash with generated names', () => {
    for (const name of ['Packet', 'PacketReader', 'Index', 'InvalidPacketError']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateTypeScript(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('rejects type names that differ from generated names only in case', () => {
    for (const name of ['PACKET', 'ChatRoomCODEC', 'INDEX']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateTypeScript(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('rejects type names that clash with globals the generated code uses', () => {
    for (const name of ['Uint8Array', 'Error', 'Number', 'Array', 'TextEncoder']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateTypeScript(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('escapes reserved words used as constructor parameter names', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Keywords',
      fields: [
        { name: 'class', type: { kind: 'primitive', name: 'u8' } },
        { name: 'delete', type: { kind: 'primitive', name: 'u8' } },
      ],
    });
    const file = generateTypeScript(protocol).find((f) => f.path === 'Keywords.ts')!;
    expect(file.content).toContain('  class: number;');
    expect(file.content).toContain('constructor(class_: number = 0, delete_: number = 0) {');
    expect(file.content).toContain('this.class = class_;');
  });

  it('renames members that clash with generated members', () => {
    const protocol = chatRoom();
    const u8 = { kind: 'primitive', name: 'u8' } as const;
    protocol.structs.push({
      name: 'Clashes',
      fields: [
        { name: 'opcode', type: u8 },
        { name: 'body_size', type: u8 },
        { name: 'to_string', type: u8 },
        { name: 'constructor', type: u8 },
      ],
    });
    const file = generateTypeScript(protocol).find((f) => f.path === 'Clashes.ts')!;
    expect(file.content).toContain('  opcode_: number;');
    expect(file.content).toContain('  bodySize_: number;');
    expect(file.content).toContain('  toString_: number;');
    expect(file.content).toContain('  constructor_: number;');
  });

  it('keeps a member named like its own type', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Holder',
      fields: [{ name: 'user', type: { kind: 'struct', name: 'User' } }],
    });
    const file = generateTypeScript(protocol).find((f) => f.path === 'Holder.ts')!;
    expect(file.content).toContain('  user: User;');
    expect(file.content).toContain('constructor(user: User = new User()) {');
    expect(file.content).toContain("import { User } from './User.js';");
  });

  it('writes enums as const objects with a union type', () => {
    const entry = generateTypeScript(chatRoom()).find((f) => f.path === 'LoginStatus.ts')!;
    expect(entry.content).toContain('  BadPassword: 1,');
    expect(entry.content).toContain('  ServerFull: 3,');
    expect(entry.content).toContain('export const LoginStatus = {');
    expect(entry.content).toContain('} as const;');
    expect(entry.content).toContain(
      'export type LoginStatus = (typeof LoginStatus)[keyof typeof LoginStatus];',
    );
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
    const file = generateTypeScript(protocol).find((f) => f.path === 'Mode.ts')!;
    expect(file.content).toContain('  AB: 0,\n  Ab: 1,\n  AB_: 2,\n  _: 3,\n  _1: 4,');
  });

  it('writes docs as comments without ending the comment early', () => {
    const protocol = chatRoom();
    const nel = String.fromCharCode(0x85);
    protocol.doc = `Ends */ here\r\nsecond${nel}third\n\n\\ done`;
    const entry = generateTypeScript(protocol).find((f) => f.path === 'ChatRoomProtocol.ts')!;
    expect(entry.content).toContain(
      '/**\n * Ends *\\/ here\n * second\n * third\n *\n * \\ done\n */\nexport const ChatRoomProtocol',
    );
    expect(entry.content.includes(nel)).toBe(false);
  });

  it('writes protocol names and versions as ASCII string literals', () => {
    const protocol = chatRoom();
    protocol.version = `v${String.fromCharCode(0x8046)} '1'"\\`;
    const files = generateTypeScript(protocol);
    const entry = files.find((f) => f.path === 'ChatRoomProtocol.ts')!;
    expect(entry.content).toContain("VERSION: 'v\\u8046 \\'1\\'\"\\\\',");
    for (const file of files) expect(file.content).not.toMatch(/[^\t\n\x20-\x7e]/);
  });
});
