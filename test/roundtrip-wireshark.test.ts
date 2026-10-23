import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateWireshark } from '../src/gen/wireshark.js';
import type { Protocol } from '../src/model.js';
import { allTypes, chatRoom } from './helpers.js';

function findTshark(): string | undefined {
  const candidates = ['tshark'];
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Wireshark', 'tshark.exe'),
    );
  }
  for (const candidate of candidates) {
    if (candidate !== 'tshark' && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['-v'], { encoding: 'utf8' });
    if (result.status === 0 && /\bLua\b/.test(result.stdout)) return candidate;
  }
  return undefined;
}

const tshark = findTshark();
if (!tshark && process.env.PKTSPEC_REQUIRE_TSHARK) {
  throw new Error('PKTSPEC_REQUIRE_TSHARK is set but tshark with Lua support was not found');
}

/** Builds wire bytes the way the generated codecs lay them out. */
class Wire {
  private readonly chunks: Buffer[] = [];

  constructor(private readonly little: boolean) {}

  int(size: 1 | 2 | 4 | 8, value: number | bigint): this {
    const buffer = Buffer.alloc(size);
    let rest = BigInt.asUintN(size * 8, BigInt(value));
    for (let i = 0; i < size; i++) {
      buffer[this.little ? i : size - 1 - i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    this.chunks.push(buffer);
    return this;
  }

  float(size: 4 | 8, value: number): this {
    const buffer = Buffer.alloc(size);
    if (size === 4) {
      if (this.little) buffer.writeFloatLE(value);
      else buffer.writeFloatBE(value);
    } else if (this.little) {
      buffer.writeDoubleLE(value);
    } else {
      buffer.writeDoubleBE(value);
    }
    this.chunks.push(buffer);
    return this;
  }

  raw(data: ArrayLike<number>): this {
    this.chunks.push(Buffer.from(Array.from(data)));
    return this;
  }

  text(prefix: 1 | 2 | 4, value: string): this {
    const data = Buffer.from(value, 'utf8');
    this.int(prefix, data.length);
    this.chunks.push(data);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface Frame {
  from: number;
  to: number;
  payload: Buffer;
  transport?: 'udp' | 'tcp';
}

/** A classic pcap file of Ethernet, IPv4 and UDP or TCP frames; checksums are left zero. */
function pcap(frames: Frame[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);
  const records = frames.map((frame, index) => {
    const tcp = frame.transport === 'tcp';
    const transport = Buffer.alloc(tcp ? 20 : 8);
    transport.writeUInt16BE(frame.from, 0);
    transport.writeUInt16BE(frame.to, 2);
    if (tcp) {
      transport.writeUInt32BE(1 + index, 4);
      transport[12] = 5 << 4;
      transport[13] = 0x18;
      transport.writeUInt16BE(65535, 14);
    } else {
      transport.writeUInt16BE(8 + frame.payload.length, 4);
    }
    const ip = Buffer.alloc(20);
    ip[0] = 0x45;
    ip.writeUInt16BE(20 + transport.length + frame.payload.length, 2);
    ip.writeUInt16BE(index, 4);
    ip[8] = 64;
    ip[9] = tcp ? 6 : 17;
    ip.set([10, 0, 0, 1], 12);
    ip.set([10, 0, 0, 2], 16);
    const ethernet = Buffer.alloc(14);
    ethernet.writeUInt16BE(0x0800, 12);
    const data = Buffer.concat([ethernet, ip, transport, frame.payload]);
    const record = Buffer.alloc(16);
    record.writeUInt32LE(index, 0);
    record.writeUInt32LE(data.length, 8);
    record.writeUInt32LE(data.length, 12);
    return Buffer.concat([record, data]);
  });
  return Buffer.concat([header, ...records]);
}

const workDirs: string[] = [];
afterAll(() => workDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Capture {
  /** The dissector, written to disk. */
  script: string;
  /** The capture file. */
  file: string;
}

function capture(protocol: Protocol, port: number | undefined, frames: Frame[]): Capture {
  const dir = mkdtempSync(join(tmpdir(), 'pktspec-'));
  workDirs.push(dir);
  const generated = generateWireshark(protocol, { port })[0]!;
  const script = join(dir, generated.path);
  const file = join(dir, 'capture.pcap');
  writeFileSync(script, generated.content);
  writeFileSync(file, pcap(frames));
  return { script, file };
}

function run(files: Capture, args: string[]): string {
  const result = spawnSync(
    tshark!,
    ['-X', `lua_script:${files.script}`, '-r', files.file, ...args],
    {
      encoding: 'utf8',
    },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

type Row = Record<string, string>;

/** Runs tshark and returns one row per frame; empty cells are fields the frame does not have. */
function fieldRows(files: Capture, names: string[], args: string[] = []): Row[] {
  const columns = ['_ws.col.info', '_ws.expert.message', ...names];
  const output = run(files, [
    '-T',
    'fields',
    ...columns.flatMap((name) => ['-e', name]),
    '-E',
    'separator=/t',
    '-E',
    'occurrence=a',
    '-E',
    'aggregator=|',
    ...args,
  ]);
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(columns.map((name, i) => [name, cells[i] ?? '']));
  });
}

const SERVER = 7000;
const CLIENT = 50000;
const toServer = (payload: Buffer): Frame => ({ from: CLIENT, to: SERVER, payload });
const toClient = (payload: Buffer): Frame => ({ from: SERVER, to: CLIENT, payload });

const chat = () => new Wire(true);
const user = (wire: Wire, id: number, nickname: string, level: number) =>
  wire.int(4, id).text(1, nickname).int(1, level);

const CHAT_FIELDS = [
  'chat_room.direction',
  'chat_room.packet',
  'chat_room.opcode',
  'chat_room.login.account',
  'chat_room.login.password_hash',
  'chat_room.login.client_version',
  'chat_room.login_result.status',
  'chat_room.user.id',
  'chat_room.user.nickname',
  'chat_room.user.level',
  'chat_room.join_room.room_id',
  'chat_room.join_room.password',
  'chat_room.room_joined.room_id',
  'chat_room.room_joined.kind',
  'chat_room.room_joined.members',
  'chat_room.say.room_id',
  'chat_room.say.text',
  'chat_room.message.room_id',
  'chat_room.message.sender_id',
  'chat_room.message.text',
  'chat_room.message.sent_at',
  'chat_room.leave_room.room_id',
  'chat_room.user_left.room_id',
  'chat_room.user_left.user_id',
];

const hash = Array.from({ length: 32 }, (_, i) => i * 7);
const hashHex = Buffer.from(hash).toString('hex');

describe.skipIf(!tshark)('Wireshark dissector in tshark', () => {
  it('decodes every chat-room packet', () => {
    const files = capture(chatRoom(), SERVER, [
      toServer(chat().int(2, 1).text(1, 'alice').raw(hash).int(2, 258).build()),
      toClient(user(chat().int(2, 1).int(1, 3), 7, 'ab', 9).build()),
      toServer(chat().int(2, 2).int(4, 5).text(1, 'secret').build()),
      toClient(
        user(user(chat().int(2, 2).int(4, 5).int(1, 1).int(1, 2), 1, 'x', 5), 2, '', 6).build(),
      ),
      // The Say vector of the round-trip tests.
      toServer(chat().int(2, 3).int(4, 0xffffffff).text(2, '\u804a\u5929 room \u{1f600}').build()),
      toClient(chat().int(2, 3).int(4, 5).int(4, 7).text(2, 'hello').int(8, -2n).build()),
      toServer(chat().int(2, 4).int(4, 5).build()),
      toClient(chat().int(2, 4).int(4, 5).int(4, 8).build()),
    ]);
    const rows = fieldRows(files, CHAT_FIELDS);
    expect(rows).toHaveLength(8);

    const pick = (row: Row, ...names: string[]) =>
      Object.fromEntries(names.map((n) => [n, row[`chat_room.${n}`]]));
    expect(rows.map((r) => r['_ws.col.info'])).toEqual([
      'Login',
      'LoginResult',
      'JoinRoom',
      'RoomJoined',
      'Say',
      'Message',
      'LeaveRoom',
      'UserLeft',
    ]);
    expect(rows.map((r) => r['chat_room.direction'])).toEqual([
      'c2s',
      's2c',
      'c2s',
      's2c',
      'c2s',
      's2c',
      'c2s',
      's2c',
    ]);
    expect(rows.map((r) => r['chat_room.packet'])).toEqual(rows.map((r) => r['_ws.col.info']));
    expect(rows.map((r) => r['chat_room.opcode'])).toEqual([
      '0x0001',
      '0x0001',
      '0x0002',
      '0x0002',
      '0x0003',
      '0x0003',
      '0x0004',
      '0x0004',
    ]);
    expect(rows.every((r) => r['_ws.expert.message'] === '')).toBe(true);

    expect(pick(rows[0]!, 'login.account', 'login.password_hash', 'login.client_version')).toEqual({
      'login.account': 'alice',
      'login.password_hash': hashHex,
      'login.client_version': '258',
    });
    expect(pick(rows[1]!, 'login_result.status', 'user.id', 'user.nickname', 'user.level')).toEqual(
      {
        'login_result.status': '3',
        'user.id': '7',
        'user.nickname': 'ab',
        'user.level': '9',
      },
    );
    expect(pick(rows[2]!, 'join_room.room_id', 'join_room.password')).toEqual({
      'join_room.room_id': '5',
      'join_room.password': 'secret',
    });
    expect(
      pick(
        rows[3]!,
        'room_joined.room_id',
        'room_joined.kind',
        'room_joined.members',
        'user.id',
        'user.nickname',
        'user.level',
      ),
    ).toEqual({
      'room_joined.room_id': '5',
      'room_joined.kind': '1',
      'room_joined.members': '2',
      'user.id': '1|2',
      'user.nickname': 'x|',
      'user.level': '5|6',
    });
    expect(pick(rows[4]!, 'say.room_id', 'say.text')).toEqual({
      'say.room_id': '4294967295',
      'say.text': '\u804a\u5929 room \u{1f600}',
    });
    expect(
      pick(rows[5]!, 'message.room_id', 'message.sender_id', 'message.text', 'message.sent_at'),
    ).toEqual({
      'message.room_id': '5',
      'message.sender_id': '7',
      'message.text': 'hello',
      'message.sent_at': '-2',
    });
    expect(pick(rows[6]!, 'leave_room.room_id')).toEqual({ 'leave_room.room_id': '5' });
    expect(pick(rows[7]!, 'user_left.room_id', 'user_left.user_id')).toEqual({
      'user_left.room_id': '5',
      'user_left.user_id': '8',
    });
  });

  it('shows enum names, subtrees and the packet name in the tree', () => {
    const files = capture(chatRoom(), SERVER, [
      toClient(chat().int(2, 2).int(4, 5).int(1, 1).int(1, 1).raw([1, 0, 0, 0, 1, 65, 3]).build()),
    ]);
    const tree = run(files, ['-V', '-O', 'chat_room']);
    expect(tree).toContain('chat-room: RoomJoined');
    expect(tree).toContain('kind: PRIVATE (1)');
    expect(tree).toContain('members: 1');
    expect(tree).toContain('members[0]');
    expect(tree).toContain('nickname: A');
    expect(tree).toContain('level: 3');
  });

  it('reads a message from a TCP segment', () => {
    const payload = chat().int(2, 3).int(4, 9).text(2, 'tcp').build();
    const files = capture(chatRoom(), SERVER, [
      { from: CLIENT, to: SERVER, payload, transport: 'tcp' },
    ]);
    expect(fieldRows(files, ['chat_room.say.text'])).toEqual([
      expect.objectContaining({ '_ws.col.info': 'Say', 'chat_room.say.text': 'tcp' }),
    ]);
  });

  it('raises expert info for truncated, unknown, invalid and oversized data', () => {
    const say = chat().int(2, 3).int(4, 1).text(2, 'hi').build();
    const files = capture(chatRoom(), SERVER, [
      toServer(say.subarray(0, 4)),
      toServer(say.subarray(0, 2)),
      toServer(say.subarray(0, 8)),
      toServer(chat().int(2, 3).int(4, 1).int(2, 0xffff).build()),
      toServer(chat().int(2, 9).build()),
      toClient(user(chat().int(2, 1).int(1, 9), 7, 'ab', 9).build()),
      toServer(Buffer.concat([say, Buffer.from([1, 2])])),
      toServer(Buffer.from([3])),
    ]);
    const rows = fieldRows(files, ['chat_room.say.text']);
    expect(rows.map((r) => r['_ws.expert.message'])).toEqual([
      'Truncated: 4 more bytes needed at offset 2, 2 left',
      'Truncated: 4 more bytes needed at offset 2, 0 left',
      'Length 2 runs past the end of the packet, 0 bytes left',
      'Length 65535 runs past the end of the packet, 0 bytes left',
      'Unknown opcode 0x0009',
      'Unknown LoginStatus value: 9',
      '2 bytes follow the packet',
      'Truncated: 2 more bytes needed at offset 0, 1 left',
    ]);
    expect(rows.map((r) => r['_ws.col.info'])).toEqual([
      'Say',
      'Say',
      'Say',
      'Say',
      'Unknown opcode 0x0009',
      'LoginResult',
      'Say',
      'Truncated packet',
    ]);
    // Fields before the problem are still shown, fields after it are not.
    expect(rows[5]!['chat_room.say.text']).toBe('');
    expect(rows[6]!['chat_room.say.text']).toBe('hi');
  });

  it('tries both directions when the server port is not known', () => {
    const files = capture(chatRoom(), undefined, [
      { from: 40000, to: 40001, payload: chat().int(2, 4).int(4, 5).build() },
      { from: 40000, to: 40001, payload: chat().int(2, 4).int(4, 5).int(4, 8).build() },
      { from: 40000, to: 40001, payload: chat().int(2, 4).raw(new Array(12).fill(1)).build() },
      { from: 40000, to: 40001, payload: chat().int(2, 3).int(4, 5).text(2, 'ok').build() },
    ]);
    const rows = fieldRows(files, ['chat_room.direction'], ['-d', 'udp.port==40001,chat_room']);
    expect(rows.map((r) => r['chat_room.direction'])).toEqual(['c2s', 's2c', 'c2s', 'c2s']);
    expect(rows.map((r) => r['_ws.col.info'])).toEqual([
      'LeaveRoom',
      'UserLeft',
      'LeaveRoom',
      'Say',
    ]);
    expect(rows.map((r) => r['_ws.expert.message'])).toEqual([
      '',
      '',
      'The opcode fits both directions, assuming c2s; set the server port preference|8 bytes follow the packet',
      '',
    ]);
  });

  it('uses the port preferences instead of a built-in port', () => {
    const payload = chat().int(2, 4).int(4, 5).build();
    const files = capture(chatRoom(), undefined, [toServer(payload)]);
    expect(fieldRows(files, [])[0]!['_ws.col.info']).not.toBe('LeaveRoom');
    const byPref = fieldRows(
      files,
      ['chat_room.direction'],
      ['-o', `chat_room.udp_port:${SERVER}`, '-o', `chat_room.server_port:${SERVER}`],
    );
    expect(byPref[0]).toMatchObject({
      '_ws.col.info': 'LeaveRoom',
      'chat_room.direction': 'c2s',
    });
  });

  it('decodes every type in big-endian order', () => {
    const wire = () => new Wire(false);
    const numbers = wire()
      .int(1, 1)
      .int(1, 255)
      .int(2, 65535)
      .int(4, 0xffffffff)
      .int(8, 0xffffffffffffffffn)
      .int(1, 127)
      .int(2, 0x7fff)
      .int(4, 0x7fffffff)
      .int(8, 0x7fffffffffffffffn)
      .float(4, Number.NaN)
      .float(8, Number.NEGATIVE_INFINITY)
      .int(1, 1)
      .build();
    const texts = wire()
      .int(1, 2)
      .text(1, 'ab')
      .text(2, '\u804a\u5929 room \u{1f600}')
      .text(4, '')
      .int(4, 3)
      .raw([0, 255, 7])
      .raw([0, 37, 74, 111])
      .build();
    const point = (w: Wire, x: number, y: number) => w.int(2, x).int(2, y);
    let collections = wire().int(1, 2).int(2, 2).int(4, 1).int(4, 0xffffffff);
    collections = collections.int(1, 1).text(2, 'hi').raw([1, 0, 1]);
    for (let i = 0; i < 4; i++) collections = point(collections, i, -i);
    collections = point(collections.int(4, 1), 9, 8).int(2, 2).raw([0x80, 0x7f]);
    const nested = point(wire().int(1, 3), 1, 2)
      .text(1, 'r')
      .int(1, 1)
      .text(1, 'c')
      .int(1, 0)
      .int(1, 0)
      .int(4, 0xffffffff)
      .build();
    const files = capture(allTypes(), SERVER, [
      toServer(numbers),
      toServer(texts),
      toClient(collections.build()),
      toClient(nested),
      toClient(Buffer.from([0xff])),
      toClient(Buffer.from([3, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0])),
    ]);
    const rows = fieldRows(files, [
      'all_types.packet',
      ...['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'bool'].map(
        (n) => `all_types.numbers.a_${n}`,
      ),
      'all_types.texts.short_text',
      'all_types.texts.text',
      'all_types.texts.long_text',
      'all_types.texts.blob',
      'all_types.texts.hash',
      'all_types.collections.ids',
      'all_types.collections.ids.item',
      'all_types.collections.names.item',
      'all_types.collections.flags.item',
      'all_types.collections.kinds.item',
      'all_types.point.x',
      'all_types.point.y',
      'all_types.node.label',
      'all_types.node.children',
      'all_types.nested.small',
      'all_types.nested.wide',
    ]);
    expect(rows.map((r) => r['all_types.packet'])).toEqual([
      'Numbers',
      'Texts',
      'Collections',
      'Nested',
      'Ping',
      'Nested',
    ]);

    const numberRow = rows[0]!;
    const numeric = (name: string) => numberRow[`all_types.numbers.a_${name}`];
    expect(['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64'].map(numeric)).toEqual([
      '255',
      '65535',
      '4294967295',
      '18446744073709551615',
      '127',
      '32767',
      '2147483647',
      '9223372036854775807',
    ]);
    expect(numeric('f32')).toMatch(/nan/i);
    expect(numeric('f64')).toMatch(/^-inf/i);
    expect(numeric('bool')).toMatch(/^(1|true)$/i);

    const textRow = rows[1]!;
    expect(textRow['all_types.texts.short_text']).toBe('ab');
    expect(textRow['all_types.texts.text']).toBe('\u804a\u5929 room \u{1f600}');
    expect(textRow['all_types.texts.long_text']).toBe('');
    expect(textRow['all_types.texts.blob']).toBe('00ff07');
    expect(textRow['all_types.texts.hash']).toBe('00254a6f');

    const collectionRow = rows[2]!;
    expect(collectionRow['all_types.collections.ids']).toBe('2');
    expect(collectionRow['all_types.collections.ids.item']).toBe('1|4294967295');
    expect(collectionRow['all_types.collections.names.item']).toBe('hi');
    expect(collectionRow['all_types.collections.flags.item']).toMatch(
      /^(1|true)\|(0|false)\|(1|true)$/i,
    );
    expect(collectionRow['all_types.collections.kinds.item']).toBe('-128|127');
    expect(collectionRow['all_types.point.x']).toBe('0|1|2|3|9');
    expect(collectionRow['all_types.point.y']).toBe('0|-1|-2|-3|8');

    const nestedRow = rows[3]!;
    expect(nestedRow['all_types.point.x']).toBe('1');
    expect(nestedRow['all_types.node.label']).toBe('r|c');
    expect(nestedRow['all_types.node.children']).toBe('1|0');
    expect(nestedRow['all_types.nested.small']).toBe('0');
    expect(nestedRow['all_types.nested.wide']).toBe('4294967295');

    expect(rows[4]!['_ws.expert.message']).toBe('');
    expect(rows[5]!['_ws.expert.message']).toBe('Unknown Small value: 5');
  });
});
