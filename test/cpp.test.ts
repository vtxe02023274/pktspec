import { describe, expect, it } from 'vitest';
import { defaultCppNamespace, generateCpp, isValidCppNamespace } from '../src/gen/cpp.js';
import { allTypes, bitFields, chatRoom, conditionalFields } from './helpers.js';

describe('generateCpp', () => {
  for (const [name, load] of [
    ['chat-room', chatRoom],
    ['all-types', allTypes],
    ['bit-fields', bitFields],
    ['conditional-fields', conditionalFields],
  ] as const) {
    it(`matches the golden files for ${name}`, async () => {
      const files = generateCpp(load());
      for (const file of files) {
        await expect(file.content).toMatchFileSnapshot(`golden/cpp/${name}/${file.path}`);
      }
    });
  }

  it('writes flat header files, one per packet and enum and one for all structs', () => {
    const paths = generateCpp(chatRoom()).map((f) => f.path);
    expect(paths).toContain('ChatRoomProtocol.hpp');
    expect(paths).toContain('Login.hpp');
    expect(paths).toContain('LoginStatus.hpp');
    expect(paths).toContain('Structs.hpp');
    expect(paths).toContain('Packet.hpp');
    expect(paths).not.toContain('User.hpp');
    expect(paths.every((p) => p.endsWith('.hpp') && !p.includes('/'))).toBe(true);
  });

  it('leaves out Structs.hpp when the protocol has no structs', () => {
    const protocol = chatRoom();
    protocol.structs = [];
    protocol.packets = protocol.packets.filter((p) => p.name === 'LeaveRoom');
    protocol.enums = [];
    const paths = generateCpp(protocol).map((f) => f.path);
    expect(paths).not.toContain('Structs.hpp');
    expect(paths).toContain('LeaveRoom.hpp');
  });

  it('uses the namespace option', () => {
    for (const namespace of ['Example.Chat', 'Example::Chat']) {
      const entry = generateCpp(chatRoom(), { namespace }).find((f) => f.path === 'Login.hpp')!;
      expect(entry.content).toContain('namespace Example::Chat {\n');
      expect(entry.content).toContain('}  // namespace Example::Chat\n');
    }
  });

  it('derives a namespace from the protocol name', () => {
    expect(defaultCppNamespace('chat-room')).toBe('ChatRoom');
    expect(defaultCppNamespace('all_types')).toBe('AllTypes');
    expect(isValidCppNamespace('Example.Chat')).toBe(true);
    expect(isValidCppNamespace('Example::Chat')).toBe(true);
    expect(isValidCppNamespace('Example.new')).toBe(false);
    expect(isValidCppNamespace('Example..Chat')).toBe(false);
    expect(isValidCppNamespace('std')).toBe(false);
  });

  it('rejects an invalid namespace', () => {
    expect(() => generateCpp(chatRoom(), { namespace: 'Example.new' })).toThrow(
      "'Example.new' is not a valid C++ namespace name",
    );
  });

  it('rejects type names that clash with generated types', () => {
    for (const name of ['Packet', 'PacketReader', 'Structs', 'NULL', 'PacketRangeError']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateCpp(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('rejects type names that differ from generated types only in case', () => {
    for (const name of ['PACKET', 'ChatRoomPROTOCOL']) {
      const protocol = chatRoom();
      protocol.structs.push({ name, fields: [] });
      expect(() => generateCpp(protocol)).toThrow(`'${name}' clashes`);
    }
  });

  it('renames members that are keywords, macros or generated members', () => {
    const protocol = chatRoom();
    const u8 = { kind: 'primitive', name: 'u8' } as const;
    protocol.packets.push({
      name: 'Clashes',
      opcode: 0x20,
      direction: 'c2s',
      fields: [
        { name: 'class', type: u8 },
        { name: 'max', type: u8 },
        { name: 'opcode', type: u8 },
        { name: 'body_size', type: u8 },
        { name: 'new', type: u8 },
        { name: 'class_', type: u8 },
      ],
    });
    const file = generateCpp(protocol).find((f) => f.path === 'Clashes.hpp')!;
    expect(file.content).toContain('std::uint8_t class_{};');
    expect(file.content).toContain('std::uint8_t max_{};');
    expect(file.content).toContain('std::uint8_t opcode_{};');
    expect(file.content).toContain('std::uint8_t bodySize_{};');
    expect(file.content).toContain('std::uint8_t new_{};');
    expect(file.content).toContain('std::uint8_t class__{};');
  });

  it('keeps constructor parameters apart from members', () => {
    const protocol = chatRoom();
    const u8 = { kind: 'primitive', name: 'u8' } as const;
    protocol.structs.push({
      name: 'Pair',
      fields: [
        { name: 'id', type: u8 },
        { name: 'id_in', type: u8 },
        { name: 'idIn', type: u8 },
      ],
    });
    const file = generateCpp(protocol).find((f) => f.path === 'Structs.hpp')!;
    expect(file.content).toContain(
      'inline Pair::Pair(std::uint8_t idInIn, std::uint8_t idInInIn, std::uint8_t idIn_In)',
    );
  });

  it('marks a constructor with one parameter explicit', () => {
    const protocol = chatRoom();
    const entry = generateCpp(protocol).find((f) => f.path === 'LeaveRoom.hpp')!;
    expect(entry.content).toContain('explicit LeaveRoom(std::uint32_t roomIdIn);');
  });

  it('starts enum members and arrays of them at the first value', () => {
    const protocol = chatRoom();
    protocol.structs.push({
      name: 'Kinds',
      fields: [
        { name: 'one', type: { kind: 'enum', name: 'RoomKind' } },
        {
          name: 'two',
          type: { kind: 'fixedArray', element: { kind: 'enum', name: 'RoomKind' }, size: 2 },
        },
      ],
    });
    const file = generateCpp(protocol).find((f) => f.path === 'Structs.hpp')!;
    expect(file.content).toContain('RoomKind one{RoomKind::Public};');
    expect(file.content).toContain(
      'std::array<RoomKind, 2> two = detail::filled<2>(RoomKind::Public);',
    );
  });

  it('turns enum value names into PascalCase', () => {
    const entry = generateCpp(chatRoom()).find((f) => f.path === 'LoginStatus.hpp')!;
    expect(entry.content).toContain('    BadPassword = 1,');
    expect(entry.content).toContain('    ServerFull = 3,');
    expect(entry.content).toContain('enum class LoginStatus : std::uint8_t {');
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
    const file = generateCpp(protocol).find((f) => f.path === 'Mode.hpp')!;
    expect(file.content).toContain(
      '    AB = 0,\n    Ab = 1,\n    AB_ = 2,\n    _ = 3,\n    _1 = 4,',
    );
  });

  it('writes the extreme enum values as valid literals', () => {
    const wide = generateCpp(allTypes()).find((f) => f.path === 'Wide.hpp')!;
    expect(wide.content).toContain('    High = 4294967295u,');
    expect(wide.content).toContain('        case 4294967295u:');
    const protocol = chatRoom();
    protocol.enums.push({
      name: 'Int',
      type: 'i32',
      values: [{ name: 'LOW', value: -2147483648 }],
    });
    const low = generateCpp(protocol).find((f) => f.path === 'Int.hpp')!;
    expect(low.content).toContain('    Low = (-2147483647 - 1),');
  });

  it('orders structs so that held structs come first and declares all of them up front', () => {
    const protocol = chatRoom();
    protocol.structs.unshift({
      name: 'Holder',
      fields: [{ name: 'user', type: { kind: 'struct', name: 'User' } }],
    });
    const content = generateCpp(protocol).find((f) => f.path === 'Structs.hpp')!.content;
    expect(content).toContain('struct Holder;\nstruct User;');
    expect(content.indexOf('struct User {')).toBeLessThan(content.indexOf('struct Holder {'));
    expect(content).toContain('inline Holder::Holder(User userIn)');
  });

  it('writes docs as block comments without breaking the comment', () => {
    const protocol = chatRoom();
    protocol.doc = 'Saves /* a */ & b\r\nsecond\u2028third\n\n\\ done\\';
    const entry = generateCpp(protocol).find((f) => f.path === 'ChatRoomProtocol.hpp')!;
    expect(entry.content).toContain(
      '/**\n * Saves /\\* a *\\/ & b\n * second\n * third\n *\n * \\ done\\\n */\nstruct ChatRoomProtocol final {',
    );
  });

  it('keeps generated files pure ASCII', () => {
    const protocol = chatRoom();
    protocol.doc = '聊天 \u{1f600}\u0001';
    protocol.version = 'v聊 "1"\\??/';
    protocol.packets[0]!.doc = '存檔';
    const files = generateCpp(protocol);
    const entry = files.find((f) => f.path === 'ChatRoomProtocol.hpp')!;
    expect(entry.content).toContain('/** \\u804a\\u5929 \\U0001f600\\x01 */');
    expect(entry.content).toContain('ProtocolVersion = "v\\350\\201\\212 \\"1\\"\\\\\\?\\?/";');
    for (const file of files) expect(file.content).not.toMatch(/[^\t\n\x20-\x7e]/);
  });

  it('never ends a line with a backslash outside comments', () => {
    const protocol = chatRoom();
    protocol.packets[0]!.doc = 'ends with a backslash \\';
    for (const file of generateCpp(protocol)) {
      expect(
        file.content.split('\n').filter((l) => l.endsWith('\\') && !l.startsWith(' *')),
      ).toEqual([]);
    }
  });
});
