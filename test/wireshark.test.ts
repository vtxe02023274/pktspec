import { describe, expect, it } from 'vitest';
import { generateWireshark } from '../src/gen/wireshark.js';
import { allTypes, chatRoom } from './helpers.js';

function lua(protocol = chatRoom(), port?: number): string {
  return generateWireshark(protocol, { port })[0]!.content;
}

describe('generateWireshark', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
  ] as const) {
    it(`matches the golden file for ${name}`, async () => {
      const files = generateWireshark(load());
      expect(files).toHaveLength(1);
      await expect(files[0]!.content).toMatchFileSnapshot(
        `golden/wireshark/${name}/${files[0]!.path}`,
      );
    });
  }

  it('writes one file named after the protocol', () => {
    expect(generateWireshark(chatRoom()).map((f) => f.path)).toEqual(['chat-room.lua']);
    expect(generateWireshark(allTypes()).map((f) => f.path)).toEqual(['all_types.lua']);
  });

  it('puts every packet in the table of its direction', () => {
    const content = lua();
    expect(content).toContain('PACKETS.c2s[0x0001] = { name = "Login"');
    expect(content).toContain('PACKETS.s2c[0x0001] = { name = "LoginResult"');
    expect(content).toContain('PACKETS.c2s[0x0004] = { name = "LeaveRoom"');
    expect(content).toContain('PACKETS.s2c[0x0004] = { name = "UserLeft"');
    expect(content.match(/^PACKETS\.(c2s|s2c)\[/gm)).toHaveLength(8);
    expect(lua(allTypes())).toContain('PACKETS.s2c[0xFF] = { name = "Ping", fields = {} }');
  });

  it('bakes in the byte order and the opcode width', () => {
    expect(lua()).toContain('local LITTLE = true\nlocal OPCODE_SIZE = 2');
    expect(lua()).toContain('local OPCODE_FORMAT = "0x%04X"');
    expect(lua(allTypes())).toContain('local LITTLE = false\nlocal OPCODE_SIZE = 1');
    expect(lua(allTypes())).toContain('local OPCODE_FORMAT = "0x%02X"');
  });

  it('has no port unless one is given', () => {
    expect(lua()).toContain('local DEFAULT_PORT = 0\n');
    expect(lua(chatRoom(), 7000)).toContain('local DEFAULT_PORT = 7000\n');
  });

  it('rejects a port that is not a port number', () => {
    for (const port of [-1, 65536, 1.5, Number.NaN]) {
      expect(() => generateWireshark(chatRoom(), { port })).toThrow('is not a valid port');
    }
  });

  it('gives every field its own abbreviation', () => {
    for (const protocol of [chatRoom(), allTypes()]) {
      const abbreviations = [...lua(protocol).matchAll(/ProtoField\.\w+\("([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(abbreviations.length).toBeGreaterThan(10);
      expect(new Set(abbreviations).size).toBe(abbreviations.length);
    }
    expect(lua(allTypes())).toContain('"all_types.collections.ids.item"');
    expect(lua()).toContain('"chat_room.login_result.status"');
  });

  it('keeps abbreviations unique when names differ only in case or separators', () => {
    const protocol = chatRoom();
    const u8 = { kind: 'primitive', name: 'u8' } as const;
    protocol.structs.push({
      name: 'Twins',
      fields: [
        { name: 'a_b', type: u8 },
        { name: 'aB', type: u8 },
        { name: 'item', type: u8 },
        { name: 'list', type: { kind: 'fixedArray', element: u8, size: 2 } },
      ],
    });
    const content = lua(protocol);
    expect(content).toContain('"chat_room.twins.a_b"');
    expect(content).toContain('"chat_room.twins.a_b_"');
    const abbreviations = [...content.matchAll(/ProtoField\.\w+\("([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(abbreviations).size).toBe(abbreviations.length);
  });

  it('lists a repeated enum value once, under its first name', () => {
    const protocol = chatRoom();
    protocol.enums.push({
      name: 'Alias',
      type: 'i8',
      values: [
        { name: 'ONE', value: 1 },
        { name: 'UNO', value: 1 },
        { name: 'NEG', value: -1 },
      ],
    });
    expect(lua(protocol)).toContain('ENUMS["Alias"] = { [1] = "ONE", [-1] = "NEG" }');
  });

  it('writes names as ASCII Lua strings', () => {
    const protocol = chatRoom();
    protocol.enums.push({
      name: 'Odd',
      type: 'u8',
      values: [{ name: 'a"b\\' + String.fromCharCode(0xe9, 0x8046), value: 0 }],
    });
    const content = lua(protocol);
    expect(content).toContain('"a\\"b\\\\\\195\\169\\232\\129\\134"');
    expect(content).not.toMatch(/[^\n\x20-\x7e]/);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('says how messages are framed and how the direction is chosen', () => {
    const header = lua().split('\n\n')[0]!;
    expect(header).toContain('no length prefix');
    expect(header).toContain('Decode As');
    expect(header).toContain('both directions');
  });
});
