import { describe, expect, it } from 'vitest';
import { defaultJavaPackage, generateJava, isValidJavaPackage } from '../src/gen/java.js';
import { allTypes, bitFields, chatRoom, conditionalFields } from './helpers.js';

describe('generateJava', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
    ['bit-fields', bitFields],
    ['conditional-fields', conditionalFields],
  ] as const) {
    it(`matches the golden files for ${name}`, async () => {
      const files = generateJava(load());
      for (const file of files) {
        await expect(file.content).toMatchFileSnapshot(`golden/java/${name}/${file.path}`);
      }
    });
  }

  it('writes files under the package directory', () => {
    const paths = generateJava(chatRoom(), { package: 'com.example.chat' }).map((f) => f.path);
    expect(paths).toContain('com/example/chat/ChatRoomProtocol.java');
    expect(paths).toContain('com/example/chat/Login.java');
  });

  it('derives a package name from the protocol name', () => {
    expect(defaultJavaPackage('chat-room')).toBe('chatroom');
    expect(isValidJavaPackage('com.example.chat')).toBe(true);
    expect(isValidJavaPackage('com.example.new')).toBe(false);
    expect(isValidJavaPackage('com..chat')).toBe(false);
  });

  it('rejects type names that clash with generated classes', () => {
    const protocol = chatRoom();
    protocol.structs.push({ name: 'Packet', fields: [] });
    expect(() => generateJava(protocol)).toThrow("'Packet' clashes");
  });

  it('rejects type names that differ from generated classes only in case', () => {
    for (const name of ['PACKET', 'ChatRoomCODEC']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateJava(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('rejects type names that clash with classes the codec uses', () => {
    for (const name of [
      'IllegalArgumentException',
      'BufferUnderflowException',
      'StandardCharsets',
      'Supplier',
    ]) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateJava(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('writes docs with backslashes and non-ASCII text as plain ASCII', () => {
    const protocol = chatRoom();
    protocol.doc = 'Saves to C:\\users\\game\\save.dat\n\u804a\u5929 \ud83d\ude00';
    const files = generateJava(protocol);
    const entry = files.find((f) => f.path.endsWith('/ChatRoomProtocol.java'))!;
    expect(entry.content).toContain(' * Saves to C:&#92;users&#92;game&#92;save.dat\n');
    expect(entry.content).toContain(' * \\u804a\\u5929 \\ud83d\\ude00\n');
    for (const file of files) expect(file.content).not.toMatch(/[^\t\n\x20-\x7e]/);
  });

  it('escapes Java keywords in field names', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Keywords',
      fields: [{ name: 'class', type: { kind: 'primitive', name: 'u8' } }],
    });
    const file = generateJava(protocol).find((f) => f.path.endsWith('/Keywords.java'))!;
    expect(file.content).toContain('public short class_;');
  });

  it('renames the wire value field when an enum value is called value', () => {
    const protocol = chatRoom();
    protocol.enums.push({
      name: 'Mode',
      type: 'u8',
      values: [
        { name: 'value', value: 0 },
        { name: 'value_', value: 1 },
      ],
    });
    const file = generateJava(protocol).find((f) => f.path.endsWith('/Mode.java'))!;
    expect(file.content).toContain('    private final int value__;');
    expect(file.content).toContain('        return value__;');
    expect(file.content).toContain('if (constant.value__ == value) {');
  });

  it('escapes the underscore keyword in enum values', () => {
    const protocol = chatRoom();
    protocol.enums.push({ name: 'Marks', type: 'u8', values: [{ name: '_', value: 0 }] });
    const file = generateJava(protocol).find((f) => f.path.endsWith('/Marks.java'))!;
    expect(file.content).toContain('    __(0);');
  });
});
