import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { diffProtocols, formatDiff, type Change } from '../src/diff.js';

function spec(source: string) {
  const { protocol, locations, diagnostics } = compile(source);
  if (!protocol || !locations) throw new Error(JSON.stringify(diagnostics));
  return { protocol, locations };
}

function diff(before: string, after: string): Change[] {
  return diffProtocols(spec(before), spec(after));
}

/** `severity rule path` per change, which is all most rules need to assert. */
function brief(before: string, after: string): string[] {
  return diff(before, after).map((c) => `${c.severity} ${c.rule} ${c.path}`);
}

const head = 'name: t\n';

function packet(fields: string, opcode = 1, name = 'A', direction = 'c2s'): string {
  return `  - name: ${name}\n    opcode: ${opcode}\n    direction: ${direction}\n    fields: [${fields}]\n`;
}

const proto = (body: string, header = head) => `${header}${body}`;
const packets = (...items: string[]) => `packets:\n${items.join('')}`;

describe('diff header', () => {
  const base = proto(packets(packet('{ name: a, type: u8 }')));

  it('finds no differences in identical specs', () => {
    expect(diff(base, base)).toEqual([]);
  });

  it('treats endian and opcode width as breaking', () => {
    expect(
      brief(base, proto(packets(packet('{ name: a, type: u8 }')), `${head}endian: big\n`)),
    ).toEqual(['breaking endian-changed protocol.endian']);
    expect(
      brief(base, proto(packets(packet('{ name: a, type: u8 }')), `${head}opcode: u8\n`)),
    ).toEqual(['breaking opcode-width-changed protocol.opcode']);
  });

  it('treats name, version and doc as info', () => {
    const after = proto(
      packets(packet('{ name: a, type: u8 }')),
      'name: other\nversion: 2\ndoc: hi\n',
    );
    expect(brief(base, after)).toEqual([
      'info protocol-renamed protocol.name',
      'info version-changed protocol.version',
      'info doc-changed protocol.doc',
    ]);
  });
});

describe('diff packets', () => {
  const one = (fields: string, opcode = 1, name = 'A', direction = 'c2s') =>
    proto(packets(packet(fields, opcode, name, direction)));
  const a = '{ name: a, type: u8 }';

  it('flags a removed packet as breaking', () => {
    expect(brief(proto(packets(packet(a), packet(a, 2, 'B'))), one(a))).toEqual([
      'breaking packet-removed B',
    ]);
  });

  it('flags a new packet as compatible', () => {
    expect(brief(one(a), proto(packets(packet(a), packet(a, 2, 'B'))))).toEqual([
      'compatible packet-added B',
    ]);
  });

  it('flags a changed opcode or direction as breaking', () => {
    expect(brief(one(a), one(a, 2))).toEqual(['breaking packet-opcode-changed A']);
    expect(brief(one(a), one(a, 1, 'A', 's2c'))).toEqual(['breaking packet-direction-changed A']);
  });

  it('treats the same opcode under a new name as a rename', () => {
    expect(brief(one(a), one(a, 1, 'B'))).toEqual(['info packet-renamed B']);
  });

  it('still compares the fields of a renamed packet', () => {
    expect(brief(one(a), one('{ name: a, type: u16 }', 1, 'B'))).toEqual([
      'info packet-renamed B',
      'breaking field-type-changed B.a',
    ]);
  });

  it('reports doc changes as info', () => {
    const doc = proto(
      packets(
        '  - name: A\n    opcode: 1\n    direction: c2s\n    doc: new\n    fields: [' + a + ']\n',
      ),
    );
    expect(brief(one(a), doc)).toEqual(['info doc-changed A']);
  });
});

describe('diff fields', () => {
  const diffFields = (before: string, after: string) =>
    brief(proto(packets(packet(before))), proto(packets(packet(after))));
  const a = '{ name: a, type: u8 }';
  const b = '{ name: b, type: u16 }';

  it('flags added and removed fields as breaking', () => {
    expect(diffFields(a, `${a}, ${b}`)).toEqual(['breaking field-added A.b']);
    expect(diffFields(`${a}, ${b}`, a)).toEqual(['breaking field-removed A.b']);
    expect(diffFields(b, `${a}, ${b}`)).toEqual(['breaking field-added A.a']);
  });

  it('reports a rename as info when position and type stay', () => {
    expect(diffFields(a, '{ name: z, type: u8 }')).toEqual(['info field-renamed A.z']);
  });

  it('does not call a rename with a different type a rename', () => {
    expect(diffFields(a, '{ name: z, type: u16 }')).toEqual([
      'breaking field-removed A.a',
      'breaking field-added A.z',
    ]);
  });

  it('flags a changed primitive type as breaking', () => {
    expect(diffFields(a, '{ name: a, type: u16 }')).toEqual(['breaking field-type-changed A.a']);
    expect(diffFields(a, '{ name: a, type: i8 }')).toEqual(['breaking field-type-changed A.a']);
  });

  it('flags a changed length prefix of strings, bytes and arrays', () => {
    const str = (len: string) => `{ name: s, type: string, length: ${len} }`;
    const bytes = (len: string) => `{ name: s, type: bytes, length: ${len} }`;
    const arr = (len: string) => `{ name: s, type: 'u8[]', length: ${len} }`;
    for (const make of [str, bytes, arr]) {
      expect(diffFields(make('u8'), make('u32'))).toEqual(['breaking length-prefix-changed A.s']);
    }
    // The default prefix is u16, so spelling it out changes nothing.
    expect(diffFields(str('u16'), '{ name: s, type: string }')).toEqual([]);
  });

  it('flags a changed fixed length', () => {
    expect(
      diffFields('{ name: s, type: bytes, size: 4 }', '{ name: s, type: bytes, size: 8 }'),
    ).toEqual(['breaking fixed-size-changed A.s']);
    expect(diffFields("{ name: s, type: 'u8[2]' }", "{ name: s, type: 'u8[3]' }")).toEqual([
      'breaking fixed-size-changed A.s',
    ]);
  });

  it('flags a changed array element type or array kind', () => {
    expect(diffFields("{ name: s, type: 'u8[]' }", "{ name: s, type: 'u16[]' }")).toEqual([
      'breaking array-element-changed A.s',
    ]);
    expect(diffFields("{ name: s, type: 'u8[2]' }", "{ name: s, type: 'u16[2]' }")).toEqual([
      'breaking array-element-changed A.s',
    ]);
    expect(diffFields("{ name: s, type: 'u8[]' }", "{ name: s, type: 'u8[2]' }")).toEqual([
      'breaking field-type-changed A.s',
    ]);
  });

  it('flags a changed bytes shape', () => {
    expect(diffFields('{ name: s, type: bytes }', '{ name: s, type: bytes, size: 2 }')).toEqual([
      'breaking field-type-changed A.s',
    ]);
  });

  it('flags reordering that changes the layout as breaking', () => {
    expect(diffFields(`${a}, ${b}`, `${b}, ${a}`)).toEqual(['breaking field-reordered A.b']);
  });

  it('reports reordering of same-typed fields as info', () => {
    const x = '{ name: x, type: u8 }';
    const y = '{ name: y, type: u8 }';
    expect(diffFields(`${x}, ${y}`, `${y}, ${x}`)).toEqual(['info field-reordered A.y']);
  });

  it('reports field doc changes as info', () => {
    expect(diffFields(a, '{ name: a, type: u8, doc: hello }')).toEqual(['info doc-changed A.a']);
  });
});

describe('diff structs and enums', () => {
  const point = (fields: string, extra = '') =>
    `structs:\n  Point:\n    fields: [${fields}]\n${extra}`;
  const use = (names = ['A']) =>
    packets(...names.map((n, i) => packet('{ name: p, type: Point }', i + 1, n)));
  const x = '{ name: x, type: i16 }';
  const y = '{ name: y, type: i16 }';

  it('reports struct changes through the packets that use them', () => {
    const before = proto(point(`${x}, ${y}`) + use(['A', 'B']));
    const after = proto(point(`${x}, { name: y, type: i32 }`) + use(['A', 'B']));
    const changes = diff(before, after);
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'breaking field-type-changed Point.y',
    ]);
    expect(changes[0]!.usedBy).toEqual(['A', 'B']);
    expect(changes[0]!.message).toContain('used by: A, B');
  });

  it('follows structs nested inside structs and arrays', () => {
    const wrap = (inner: string) =>
      proto(
        `structs:\n  Point:\n    fields: [${inner}]\n  Line:\n    fields: [{ name: pts, type: 'Point[]' }]\n` +
          packets(packet('{ name: l, type: Line }')),
      );
    expect(diff(wrap(x), wrap(`${x}, ${y}`))[0]!.usedBy).toEqual(['A']);
  });

  it('downgrades struct changes that no packet uses', () => {
    const before = proto(point(x) + packets(packet('{ name: a, type: u8 }')));
    const after = proto(point(`${x}, ${y}`) + packets(packet('{ name: a, type: u8 }')));
    expect(brief(before, after)).toEqual(['info field-added Point.y']);
  });

  it('flags a removed struct only when a packet used it', () => {
    const fieldless = packets(packet('{ name: a, type: u8 }'));
    expect(brief(proto(point(x) + fieldless), proto(fieldless))).toEqual([
      'info struct-removed Point',
    ]);
    expect(
      brief(proto(point(x) + use()), proto(packets(packet('{ name: p, type: u32 }')))),
    ).toEqual(['breaking struct-removed Point', 'breaking field-type-changed A.p']);
  });

  it('reports a new struct as compatible', () => {
    const fieldless = packets(packet('{ name: a, type: u8 }'));
    expect(brief(proto(fieldless), proto(point(x) + fieldless))).toEqual([
      'compatible struct-added Point',
    ]);
  });

  it('sees through a struct swapped for one with the same layout', () => {
    const two = (inner: string) =>
      proto(
        `structs:\n  P:\n    fields: [${x}]\n  Q:\n    fields: [${x}]\n` +
          packets(packet(`{ name: p, type: ${inner} }`)),
      );
    expect(brief(two('P'), two('Q'))).toEqual(['info field-type-renamed A.p']);
  });

  const color = (type: string, values: string, extra = '') =>
    proto(
      `enums:\n  Color:\n    type: ${type}\n${extra}    values: { ${values} }\n` +
        packets(packet('{ name: c, type: Color }')),
    );

  it('flags a changed enum underlying type as breaking', () => {
    const changes = diff(color('u8', 'RED: 0'), color('u16', 'RED: 0'));
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'breaking enum-type-changed Color',
    ]);
    expect(changes[0]!.usedBy).toEqual(['A']);
  });

  it('flags removed and renumbered enum values as breaking', () => {
    expect(brief(color('u8', 'RED: 0, BLUE: 1'), color('u8', 'RED: 0'))).toEqual([
      'breaking enum-value-removed Color.BLUE',
    ]);
    expect(brief(color('u8', 'RED: 0, BLUE: 1'), color('u8', 'RED: 0, BLUE: 2'))).toEqual([
      'breaking enum-value-renumbered Color.BLUE',
    ]);
  });

  it('treats an added enum value as compatible, wherever it sits', () => {
    expect(brief(color('u8', 'RED: 0'), color('u8', 'RED: 0, BLUE: 1'))).toEqual([
      'compatible enum-value-added Color.BLUE',
    ]);
    expect(brief(color('u8', 'RED: 5'), color('u8', 'BLUE: 1, RED: 5'))).toEqual([
      'compatible enum-value-added Color.BLUE',
    ]);
  });

  it('reports a renamed enum value as info', () => {
    expect(brief(color('u8', 'RED: 0'), color('u8', 'CRIMSON: 0'))).toEqual([
      'info enum-value-renamed Color.CRIMSON',
    ]);
  });

  it('reports enum doc changes as info and ignores value order', () => {
    expect(
      brief(color('u8', 'RED: 0, BLUE: 1'), color('u8', 'BLUE: 1, RED: 0', '    doc: x\n')),
    ).toEqual(['info doc-changed Color']);
  });

  it('downgrades enum breakage that no packet reaches', () => {
    const unused = (values: string) =>
      proto(
        `enums:\n  Color:\n    type: u8\n    values: { ${values} }\n` +
          packets(packet('{ name: a, type: u8 }')),
      );
    expect(brief(unused('RED: 0, BLUE: 1'), unused('RED: 0'))).toEqual([
      'info enum-value-removed Color.BLUE',
    ]);
  });

  it('keeps enum layout changes out of the field line', () => {
    // The field still says Color; only the enum itself reports the wider type.
    expect(brief(color('u8', 'RED: 0'), color('u32', 'RED: 0'))).toEqual([
      'breaking enum-type-changed Color',
    ]);
  });

  it('sees an enum swapped for a primitive of the same width as info', () => {
    const before = color('u8', 'RED: 0');
    const after = proto(
      'enums:\n  Color:\n    type: u8\n    values: { RED: 0 }\n' +
        packets(packet('{ name: c, type: u8 }')),
    );
    expect(brief(before, after)).toEqual(['info field-type-renamed A.c']);
  });
});

describe('diff bit fields', () => {
  const team =
    'enums:\n  Team:\n    type: i8\n    values: { RED: 0, BLUE: 1 }\n  Mood:\n    type: u8\n    values: { CALM: 1 }\n';
  const flags = (bits: string, type = 'u8') =>
    proto(team + packets(packet(`{ name: f, type: ${type}, bits: [${bits}] }`)));
  const base = flags('{ name: a, type: bool }, { name: b, bits: 3 }');

  it('flags changed sizes, order and types as breaking', () => {
    expect(brief(base, flags('{ name: a, type: bool }, { name: b, bits: 4 }'))).toEqual([
      'breaking bit-field-resized A.f.b',
    ]);
    expect(
      brief(
        flags('{ name: a, bits: 2 }, { name: b, bits: 2 }'),
        flags('{ name: b, bits: 2 }, { name: a, bits: 2 }'),
      ),
    ).toEqual(['breaking bit-field-moved A.f.a', 'breaking bit-field-moved A.f.b']);
    expect(brief(base, flags('{ name: a, bits: 1 }, { name: b, bits: 3 }'))).toEqual([
      'breaking bit-field-type-changed A.f.a',
    ]);
    expect(brief(base, flags('{ name: a, type: Team, bits: 1 }, { name: b, bits: 3 }'))).toEqual([
      'breaking bit-field-type-changed A.f.a',
    ]);
  });

  it('flags a changed underlying integer as breaking', () => {
    expect(brief(base, flags('{ name: a, type: bool }, { name: b, bits: 3 }', 'u16'))).toEqual([
      'breaking field-type-changed A.f',
    ]);
  });

  it('treats a new bit field in unused high bits as compatible', () => {
    const changes = diff(
      base,
      flags('{ name: a, type: bool }, { name: b, bits: 3 }, { name: c, bits: 4 }'),
    );
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'compatible bit-field-added A.f.c',
    ]);
    expect(changes[0]!.message).toBe(
      "packet 'A' field 'f.c': added (bits 4-7) in unused bits, which old versions write as 0 and ignore",
    );
  });

  it('flags a new bit field as breaking when 0 is not a value of its enum or bits shift', () => {
    expect(
      brief(
        base,
        flags('{ name: a, type: bool }, { name: b, bits: 3 }, { name: c, type: Mood, bits: 1 }'),
      ),
    ).toEqual(['breaking bit-field-added A.f.c']);
    expect(
      brief(base, flags('{ name: c, bits: 1 }, { name: a, type: bool }, { name: b, bits: 3 }')),
    ).toEqual([
      'breaking bit-field-moved A.f.a',
      'breaking bit-field-moved A.f.b',
      'breaking bit-field-added A.f.c',
    ]);
  });

  it('flags a removed bit field as breaking', () => {
    expect(brief(base, flags('{ name: a, type: bool }'))).toEqual([
      'breaking bit-field-removed A.f.b',
    ]);
  });

  it('reports renamed bit fields and doc changes as info', () => {
    expect(brief(base, flags('{ name: a, type: bool }, { name: c, bits: 3, doc: x }'))).toEqual([
      'info bit-field-renamed A.f.c',
      'info doc-changed A.f.c',
    ]);
  });

  it('reports enum changes through bit fields, but not their underlying type', () => {
    const before = flags('{ name: t, type: Team, bits: 1 }');
    const after = proto(
      'enums:\n  Team:\n    type: i16\n    values: { RED: 1, BLUE: 0 }\n  Mood:\n    type: u8\n    values: { CALM: 1 }\n' +
        packets(packet('{ name: f, type: u8, bits: [{ name: t, type: Team, bits: 1 }] }')),
    );
    const changes = diff(before, after);
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'info enum-type-changed Team',
      'breaking enum-value-renumbered Team.RED',
      'breaking enum-value-renumbered Team.BLUE',
    ]);
    expect(changes[0]!.message).toContain('only used in bit fields');
    expect(changes[1]!.usedBy).toEqual(['A']);
  });

  it('treats a group at the same position with the same integer as renamed', () => {
    const group = (name: string, bits: string) =>
      proto(packets(packet(`{ name: ${name}, type: u8, bits: [${bits}] }`)));
    expect(
      brief(
        group('flags', '{ name: a, type: bool }'),
        group('state', '{ name: a, type: bool }, { name: z, type: bool }'),
      ),
    ).toEqual(['info field-renamed A.state', 'compatible bit-field-added A.state.z']);
  });

  it('points at the bit field in both files', () => {
    const [change] = diff(base, flags('{ name: a, type: bool }, { name: b, bits: 4 }'));
    expect(change!.old).toEqual({ line: 13, column: 75 });
    expect(change!.new).toEqual({ line: 13, column: 75 });
  });
});

describe('diff conditional fields', () => {
  const kinds = (values = 'A: 0, B: 1') =>
    `enums:\n  Kind:\n    type: u8\n    values: { ${values} }\n`;
  const fields = (rest: string, values?: string) =>
    proto(
      kinds(values) +
        packets(
          packet(
            `{ name: k, type: Kind }, { name: on, type: bool }, { name: n, type: u8 }, ${rest}`,
          ),
        ),
    );
  const base = fields('{ name: x, type: u16, if: on }');

  it('flags an added, removed or changed condition as breaking', () => {
    const plain = fields('{ name: x, type: u16 }');
    const added = diff(plain, base);
    expect(added.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'breaking condition-added A.x',
    ]);
    expect(added[0]!.message).toBe(
      "packet 'A' field 'x': now only present when 'on' is true; old versions always read it",
    );
    expect(brief(base, plain)).toEqual(['breaking condition-removed A.x']);
    expect(brief(base, fields('{ name: x, type: u16, if: { field: k, equals: B } }'))).toEqual([
      'breaking condition-changed A.x',
    ]);
    const values = (list: string) =>
      fields(`{ name: x, type: u16, if: { field: n, in: [${list}] } }`);
    const changed = diff(values('1, 2'), values('1, 2, 3'));
    expect(changed.map((c) => c.rule)).toEqual(['condition-changed']);
    expect(changed[0]!.message).toBe(
      "packet 'A' field 'x': condition changed from 'n' is one of 1, 2 to 'n' is one of 1, 2, 3",
    );
  });

  it('compares conditions by value and by the position of the field they test', () => {
    const values = (list: string) =>
      fields(`{ name: x, type: u16, if: { field: k, in: [${list}] } }`);
    expect(diff(values('A, B'), values('B, A'))).toEqual([]);
    expect(
      diff(values('B'), fields('{ name: x, type: u16, if: { field: k, equals: B } }')),
    ).toEqual([]);
    // Renaming the tested field keeps the condition; the rename itself is info.
    const renamed = proto(
      kinds() +
        packets(
          packet(
            '{ name: k, type: Kind }, { name: enabled, type: bool }, { name: n, type: u8 }, { name: x, type: u16, if: enabled }',
          ),
        ),
    );
    expect(brief(base, renamed)).toEqual(['info field-renamed A.enabled']);
  });

  const grown = (rest: string) =>
    proto(
      packets(
        packet(
          `{ name: g, type: u8, bits: [{ name: a, type: bool }, { name: z, type: bool }] }, ${rest}`,
        ),
      ),
    );
  const before = (rest: string) =>
    proto(packets(packet(`{ name: g, type: u8, bits: [{ name: a, type: bool }] }, ${rest}`)));

  it('matches the tested field by pairing, not by its flattened position', () => {
    // The new bit field shifts every later member by one; the condition still tests the flag.
    expect(
      brief(
        before('{ name: flag, type: bool }, { name: x, type: u8, if: flag }'),
        grown('{ name: has_x, type: bool }, { name: x, type: u8, if: has_x }'),
      ),
    ).toEqual(['info field-renamed A.has_x', 'compatible bit-field-added A.g.z']);
  });

  it('flags a condition that moved to another field even when a bit field group grows', () => {
    expect(
      brief(
        before('{ name: p, type: bool }, { name: q, type: bool }, { name: x, type: u8, if: q }'),
        grown('{ name: pp, type: bool }, { name: qq, type: bool }, { name: x, type: u8, if: pp }'),
      ),
    ).toEqual([
      'info field-renamed A.pp',
      'info field-renamed A.qq',
      'compatible bit-field-added A.g.z',
      'breaking condition-changed A.x',
    ]);
  });

  it('follows a condition on a renamed bit field', () => {
    const group = (bit: string, test: string) =>
      proto(
        packets(
          packet(
            `{ name: g, type: u8, bits: [{ name: ${bit}, type: bool }] }, { name: x, type: u8, if: ${test} }`,
          ),
        ),
      );
    expect(brief(group('on', 'on'), group('enabled', 'enabled'))).toEqual([
      'info bit-field-renamed A.g.enabled',
    ]);
  });

  it('flags a new conditional field as breaking', () => {
    expect(
      brief(
        fields('{ name: y, type: u8 }'),
        fields('{ name: x, type: u16, if: on }, { name: y, type: u8 }'),
      ),
    ).toEqual(['breaking field-added A.x']);
  });

  it('treats a new field as compatible when it is only present for new enum values', () => {
    const before = fields('{ name: y, type: u8 }');
    const after = fields(
      '{ name: x, type: u16, if: { field: k, equals: C } }, { name: y, type: u8 }',
      'A: 0, B: 1, C: 2',
    );
    const changes = diff(before, after);
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'compatible enum-value-added Kind.C',
      'compatible field-added A.x',
    ]);
    expect(changes[1]!.message).toBe(
      "packet 'A' field 'x': added (u16) only when 'k' is C, which old versions do not define",
    );
    // B is already defined, so old versions send it and the bytes would shift.
    expect(
      brief(
        before,
        fields(
          '{ name: x, type: u16, if: { field: k, in: [B, C] } }, { name: y, type: u8 }',
          'A: 0, B: 1, C: 2',
        ),
      ),
    ).toEqual(['compatible enum-value-added Kind.C', 'breaking field-added A.x']);
  });

  it('sees a condition inside a struct through the packets that use it', () => {
    const struct = (field: string) =>
      proto(
        `structs:\n  S:\n    fields: [{ name: on, type: bool }, ${field}]\n` +
          packets(packet('{ name: s, type: S }')),
      );
    const changes = diff(struct('{ name: x, type: u8 }'), struct('{ name: x, type: u8, if: on }'));
    expect(changes.map((c) => `${c.severity} ${c.rule} ${c.path}`)).toEqual([
      'breaking condition-added S.x',
    ]);
    expect(changes[0]!.usedBy).toEqual(['A']);
  });
});

describe('diff locations', () => {
  it('takes line numbers from the new file, and the old file where it exists', () => {
    const before =
      'name: t\npackets:\n  - { name: A, opcode: 1, direction: c2s, fields: [{ name: a, type: u8 }] }\n';
    const after =
      'name: t\n\n\npackets:\n  - { name: A, opcode: 1, direction: c2s, fields: [{ name: a, type: u16 }] }\n';
    const [change] = diff(before, after);
    expect(change!.old?.line).toBe(3);
    expect(change!.new?.line).toBe(5);
  });

  it('points a removal at the old file and an addition at the new one', () => {
    const one = 'name: t\npackets:\n  - { name: A, opcode: 1, direction: c2s, fields: [] }\n';
    const two = `${one}  - { name: B, opcode: 2, direction: c2s, fields: [] }\n`;
    expect(diff(two, one)[0]).toMatchObject({ rule: 'packet-removed', old: { line: 4 } });
    expect(diff(two, one)[0]!.new).toBeUndefined();
    expect(diff(one, two)[0]).toMatchObject({ rule: 'packet-added', new: { line: 4 } });
  });

  it('formats text grouped by severity', () => {
    const one = 'name: t\npackets:\n  - { name: A, opcode: 1, direction: c2s, fields: [] }\n';
    const two = `${one}  - { name: B, opcode: 2, direction: c2s, fields: [] }\n`;
    expect(formatDiff('old.yaml', 'new.yaml', diff(two, one))).toEqual([
      'breaking (1)',
      "  old.yaml:4:13: packet 'B' (0x02, c2s) removed",
      '',
      '1 breaking, 0 compatible, 0 info',
    ]);
    expect(formatDiff('a', 'b', [])).toEqual(['no differences']);
  });
});
