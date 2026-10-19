import { describe, expect, it } from 'vitest';
import { defaultJavaPackage, generateJava, isValidJavaPackage } from '../src/gen/java.js';
import { allTypes, chatRoom } from './helpers.js';

describe('generateJava', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
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

  it('escapes Java keywords in field names', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Keywords',
      fields: [{ name: 'class', type: { kind: 'primitive', name: 'u8' } }],
    });
    const file = generateJava(protocol).find((f) => f.path.endsWith('/Keywords.java'))!;
    expect(file.content).toContain('public short class_;');
  });
});
