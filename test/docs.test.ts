import { describe, expect, it } from 'vitest';
import { generateDocs } from '../src/gen/docs.js';
import { allTypes, bitFields, chatRoom } from './helpers.js';

describe('generateDocs', () => {
  it('matches the golden file for chat-room', async () => {
    const [file] = generateDocs(chatRoom());
    expect(file!.path).toBe('chat-room.md');
    await expect(file!.content).toMatchFileSnapshot('golden/docs/chat-room.md');
  });

  it('matches the golden file for all-types', async () => {
    const [file] = generateDocs(allTypes());
    await expect(file!.content).toMatchFileSnapshot('golden/docs/all_types.md');
  });

  it('matches the golden file for bit-fields, with a bit range table per bit field', async () => {
    const [file] = generateDocs(bitFields());
    await expect(file!.content).toMatchFileSnapshot('golden/docs/bit_fields.md');
    expect(file!.content).toContain('| 12–15 | (unused) |  | Written as 0, ignored when read. |');
  });

  it('escapes pipes in descriptions', () => {
    const protocol = chatRoom();
    protocol.packets[0]!.fields[0]!.doc = 'a | b\nc';
    expect(generateDocs(protocol)[0]!.content).toContain('| a \\| b c |');
  });
});
