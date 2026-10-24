import {
  PRIMITIVE_SIZES,
  bitEnums,
  bitGroups,
  bitLayout,
  bitMember,
  conditionTarget,
  fieldMembers,
  findEnum,
  hasConditions,
  memberFields,
  wireSize,
  type BitsType,
  type Condition,
  type ElementType,
  type Enum,
  type Field,
  type FieldType,
  type MemberField,
  type MemberType,
  type Packet,
  type PrimitiveType,
  type Protocol,
  type Struct,
} from '../model.js';
import {
  camelCase,
  enumMemberName,
  hex,
  pascalCase,
  uniqueName,
  type GeneratedFile,
} from './common.js';

// Names the generated files use unqualified, or that would hide one of them inside a module.
const RESERVED_TYPE_NAMES = [
  'Packet',
  'PacketReader',
  'PacketWriter',
  'PacketErrors',
  'TruncatedPacketError',
  'InvalidPacketError',
  'Index',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'Function',
  'Infinity',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'TypeError',
  'Uint8Array',
];

// Members the generated classes declare themselves or inherit from Object.
const RESERVED_MEMBERS = [
  'constructor',
  'opcode',
  'bodySize',
  'encodedSize',
  'writeTo',
  'readFrom',
  'encode',
  'equals',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__proto__',
];

// Words that cannot name a constructor parameter in a module.
const RESERVED_WORDS = new Set(
  (
    'arguments await break case catch class const continue debugger default delete do else enum ' +
    'eval export extends false finally for function if implements import in instanceof interface ' +
    'let new null package private protected public return static super switch this throw true ' +
    'try typeof var void while with yield undefined NaN Infinity'
  ).split(' '),
);

const PRIMITIVE_TS: Record<PrimitiveType, string> = {
  u8: 'number',
  u16: 'number',
  u32: 'number',
  u64: 'bigint',
  i8: 'number',
  i16: 'number',
  i32: 'number',
  i64: 'bigint',
  f32: 'number',
  f64: 'number',
  bool: 'boolean',
};

const WIRE_NAMES: Record<PrimitiveType, string> = {
  u8: 'U8',
  u16: 'U16',
  u32: 'U32',
  u64: 'U64',
  i8: 'I8',
  i16: 'I16',
  i32: 'I32',
  i64: 'I64',
  f32: 'F32',
  f64: 'F64',
  bool: 'Bool',
};

const VIEW_NAMES: Record<PrimitiveType, string> = {
  u8: 'Uint8',
  u16: 'Uint16',
  u32: 'Uint32',
  u64: 'BigUint64',
  i8: 'Int8',
  i16: 'Int16',
  i32: 'Int32',
  i64: 'BigInt64',
  f32: 'Float32',
  f64: 'Float64',
  bool: 'Uint8',
};

const INT_LIMITS: Partial<Record<PrimitiveType, [string, string]>> = {
  u8: ['0', '0xff'],
  u16: ['0', '0xffff'],
  u32: ['0', '0xffffffff'],
  u64: ['0n', '0xffffffffffffffffn'],
  i8: ['-0x80', '0x7f'],
  i16: ['-0x8000', '0x7fff'],
  i32: ['-0x80000000', '0x7fffffff'],
  i64: ['-0x8000000000000000n', '0x7fffffffffffffffn'],
};

const INDENT = '  ';

const CHECK_BITS = `export function checkBits(value: number, bits: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new RangeError(\`\${field} out of range for \${bits} bits: \${value}\`);
  }
  return value;
}`;

const CONDITION_HELPERS = `export function checkPresent(value: unknown, present: boolean, field: string): void {
  if (present && value === undefined) {
    throw new RangeError(\`\${field} is required by its condition\`);
  }
  if (!present && value !== undefined) {
    throw new RangeError(\`\${field} must be undefined because its condition is false\`);
  }
}

export function optionalEqual<T>(
  a: T | undefined,
  b: T | undefined,
  same: (x: T, y: T) => boolean,
): boolean {
  return a === undefined || b === undefined ? a === b : same(a, b);
}`;

// Editors treat NEL, LS and PS as line breaks too, so each doc line needs its own comment prefix.
const LINE_BREAKS = new RegExp('\r\n|[\r\n' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']');

interface Import {
  from: string;
  line: string;
}

export function generateTypeScript(protocol: Protocol): GeneratedFile[] {
  const generator = new TypeScriptGenerator(protocol);
  return generator.files().map(([name, content]) => ({ path: `${name}.ts`, content }));
}

class TypeScriptGenerator {
  private readonly prefix: string;
  private readonly codec: string;
  private readonly protocolConst: string;
  private readonly memberNames = new Map<MemberField, string>();
  private readonly enumMembers = new Map<string, string[]>();

  constructor(private readonly protocol: Protocol) {
    this.prefix = pascalCase(protocol.name);
    this.codec = `${this.prefix}Codec`;
    this.protocolConst = `${this.prefix}Protocol`;
    // Compared without case because the generated files may land on a case-insensitive file system.
    const reserved = new Set(
      [...RESERVED_TYPE_NAMES, this.codec, this.protocolConst].map((n) => n.toLowerCase()),
    );
    for (const { name } of [...protocol.enums, ...protocol.structs, ...protocol.packets]) {
      if (reserved.has(name.toLowerCase())) {
        throw new Error(`'${name}' clashes with a name used by the generated TypeScript code`);
      }
    }
    for (const definition of protocol.enums) {
      const used = new Set<string>();
      this.enumMembers.set(
        definition.name,
        definition.values.map((v) => uniqueName(enumMemberName(v.name), used)),
      );
    }
    for (const { fields } of [...protocol.structs, ...protocol.packets]) {
      const used = new Set(RESERVED_MEMBERS);
      for (const field of memberFields(fields)) {
        this.memberNames.set(field, uniqueName(camelCase(field.name), used));
      }
    }
  }

  files(): [string, string][] {
    const types = [
      ...this.protocol.enums.map((e) => e.name),
      ...this.protocol.structs.map((s) => s.name),
      ...this.protocol.packets.map((p) => p.name),
    ];
    const barrel = [
      'Packet',
      'PacketErrors',
      'PacketReader',
      'PacketWriter',
      this.protocolConst,
      ...types,
    ];
    return [
      ['Packet', this.packetInterface()],
      ['PacketErrors', this.errorClasses()],
      ['PacketReader', this.readerClass()],
      ['PacketWriter', this.writerClass()],
      [this.codec, this.codecModule()],
      [this.protocolConst, this.protocolEntryPoint()],
      ...this.protocol.enums.map((e): [string, string] => [e.name, this.enumType(e)]),
      ...this.protocol.structs.map((s): [string, string] => [s.name, this.structClass(s)]),
      ...this.protocol.packets.map((p): [string, string] => [p.name, this.packetClass(p)]),
      ['index', this.file([], barrel.map((name) => `export * from './${name}.js';`).join('\n'))],
    ];
  }

  private member(field: MemberField): string {
    return this.memberNames.get(field)!;
  }

  private parameter(field: MemberField): string {
    const member = this.member(field);
    return RESERVED_WORDS.has(member) ? `${member}_` : member;
  }

  private packetInterface(): string {
    return this.file(
      [typeImport('PacketWriter')],
      `/** A packet of the ${this.protocol.name} protocol. */
export interface Packet {
  /** The opcode that identifies this packet on the wire. */
  readonly opcode: number;

  /** Number of bytes writeTo writes. The opcode is not included. */
  bodySize(): number;

  /** Writes the packet body, without the opcode. */
  writeTo(writer: PacketWriter): void;

  /** Returns the opcode followed by the body. */
  encode(): Uint8Array;

  equals(other: unknown): boolean;
}`,
    );
  }

  private errorClasses(): string {
    return this.file(
      [],
      `/** Thrown when the data ends before the packet does. */
export class TruncatedPacketError extends Error {
  constructor(message = 'The data ends before the packet does.') {
    super(message);
    this.name = 'TruncatedPacketError';
  }
}

/** Thrown when the data holds an unknown opcode or an invalid value. */
export class InvalidPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPacketError';
  }
}`,
    );
  }

  private littleEndian(): string {
    return this.protocol.endian === 'big' ? 'false' : 'true';
  }

  private readerClass(): string {
    const primitive = (type: PrimitiveType): string => {
      const size = PRIMITIVE_SIZES[type];
      const order = size === 1 ? '' : `, ${this.littleEndian()}`;
      return `  read${WIRE_NAMES[type]}(): ${PRIMITIVE_TS[type]} {
    return this.view.get${VIEW_NAMES[type]}(this.take(${size})${order});
  }`;
    };
    const methods = (['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64'] as const)
      .map(primitive)
      .join('\n\n');
    return this.file(
      [
        {
          from: './PacketErrors.js',
          line: "import { InvalidPacketError, TruncatedPacketError } from './PacketErrors.js';",
        },
      ],
      `const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Reads packet values from a buffer, in the byte order of the ${this.protocol.name} protocol. */
export class PacketReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Number of bytes read so far. */
  get position(): number {
    return this.offset;
  }

  /** Number of bytes left to read. */
  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(count: number): number {
    if (count > this.bytes.length - this.offset) {
      throw new TruncatedPacketError();
    }
    const start = this.offset;
    this.offset += count;
    return start;
  }

${methods}

  readBool(): boolean {
    return this.view.getUint8(this.take(1)) !== 0;
  }

  /** Reads a length or count prefix of 1, 2 or 4 bytes. */
  readLength(prefixSize: number): number {
    let length: number;
    switch (prefixSize) {
      case 1:
        length = this.readU8();
        break;
      case 2:
        length = this.readU16();
        break;
      default:
        length = this.readU32();
        break;
    }
    if (length > 0x7fffffff) {
      throw new InvalidPacketError(\`length too large: \${length}\`);
    }
    return length;
  }

  readString(prefixSize: number): string {
    const length = this.readLength(prefixSize);
    const start = this.take(length);
    return decoder.decode(this.bytes.subarray(start, start + length));
  }

  readBytes(prefixSize: number): Uint8Array {
    return this.readFixedBytes(this.readLength(prefixSize));
  }

  readFixedBytes(size: number): Uint8Array {
    // The range is checked before copying so a corrupt prefix cannot request a huge array.
    const start = this.take(size);
    return new Uint8Array(this.bytes.subarray(start, start + size));
  }
}`,
    );
  }

  private writerClass(): string {
    const primitive = (type: PrimitiveType): string => {
      const size = PRIMITIVE_SIZES[type];
      const order = size === 1 ? '' : `, ${this.littleEndian()}`;
      const limits = INT_LIMITS[type];
      const check = limits
        ? `    ${PRIMITIVE_TS[type] === 'bigint' ? 'checkBigInt' : 'checkInteger'}(value, ${limits[0]}, ${limits[1]}, '${type}');\n`
        : '';
      return `  write${WIRE_NAMES[type]}(value: ${PRIMITIVE_TS[type]}): void {
${check}    this.view.set${VIEW_NAMES[type]}(this.next(${size}), value${order});
  }`;
    };
    const methods = (['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64'] as const)
      .map(primitive)
      .join('\n\n');
    return this.file(
      [],
      `const encoder = new TextEncoder();

function checkInteger(value: number, min: number, max: number, type: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(\`\${type} out of range: \${value}\`);
  }
}

function checkBigInt(value: bigint, min: bigint, max: bigint, type: string): void {
  if (typeof value !== 'bigint' || value < min || value > max) {
    throw new RangeError(\`\${type} out of range: \${value}\`);
  }
}

/** Writes packet values into a fixed-size buffer, in the byte order of the ${this.protocol.name} protocol. */
export class PacketWriter {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  /** Creates a writer with room for \`size\` bytes. */
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  /** Number of bytes written so far. */
  get position(): number {
    return this.offset;
  }

  /** Returns the bytes written so far. */
  toUint8Array(): Uint8Array {
    return this.offset === this.bytes.length ? this.bytes : this.bytes.slice(0, this.offset);
  }

  private next(count: number): number {
    if (count > this.bytes.length - this.offset) {
      throw new RangeError('The buffer is too small for the packet.');
    }
    const start = this.offset;
    this.offset += count;
    return start;
  }

${methods}

  writeBool(value: boolean): void {
    this.view.setUint8(this.next(1), value ? 1 : 0);
  }

  /** Writes a length or count prefix of 1, 2 or 4 bytes. */
  writeLength(length: number, prefixSize: number): void {
    const max = prefixSize === 1 ? 0xff : prefixSize === 2 ? 0xffff : 0xffffffff;
    if (length > max) {
      throw new RangeError(\`length \${length} does not fit in a \${prefixSize}-byte prefix\`);
    }
    switch (prefixSize) {
      case 1:
        this.writeU8(length);
        break;
      case 2:
        this.writeU16(length);
        break;
      default:
        this.writeU32(length);
        break;
    }
  }

  writeString(value: string, prefixSize: number): void {
    this.writeBytes(encoder.encode(value), prefixSize);
  }

  writeBytes(value: Uint8Array, prefixSize: number): void {
    this.writeLength(value.length, prefixSize);
    this.bytes.set(value, this.next(value.length));
  }

  writeFixedBytes(value: Uint8Array, size: number, field: string): void {
    if (value.length !== size) {
      throw new RangeError(\`\${field} must be \${size} bytes, got \${value.length}\`);
    }
    this.bytes.set(value, this.next(size));
  }
}`,
    );
  }

  private codecModule(): string {
    const inBits = bitEnums(this.protocol);
    const enumReaders = this.protocol.enums.flatMap((e) => [
      this.enumReader(e),
      ...(inBits.has(e.name) ? [this.bitEnumReader(e)] : []),
    ]);
    const checkBits =
      (bitGroups(this.protocol).length > 0 ? `\n\n${CHECK_BITS}` : '') +
      (hasConditions(this.protocol) ? `\n\n${CONDITION_HELPERS}` : '');
    const imports: Import[] = [
      {
        from: './PacketErrors.js',
        line: "import { InvalidPacketError } from './PacketErrors.js';",
      },
      typeImport('PacketReader'),
      ...this.protocol.enums.map((e) => typeImport(e.name)),
    ];
    return this.file(
      imports,
      `/** Helpers shared by the generated classes. */
export function stringSize(value: string, prefixSize: number): number {
  let size = prefixSize;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) {
      size += 1;
    } else if (unit < 0x800) {
      size += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(value, i + 1)) {
      size += 4;
      i++;
    } else {
      // A lone surrogate is written as U+FFFD, which takes three bytes like any other BMP character.
      size += 3;
    }
  }
  return size;
}

function isLowSurrogate(value: string, index: number): boolean {
  if (index >= value.length) {
    return false;
  }
  const unit = value.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export function checkCount(list: readonly unknown[], count: number, field: string): void {
  if (list.length !== count) {
    throw new RangeError(\`\${field} must have \${count} elements, got \${list.length}\`);
  }
}

export function repeat<T>(count: number, element: () => T): T[] {
  return Array.from({ length: count }, () => element());
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function listEqual<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!same(a[i] as T, b[i] as T)) {
      return false;
    }
  }
  return true;
}

export function format(value: unknown): string {
  if (value instanceof Uint8Array) {
    return \`[\${Array.from(value).join(', ')}]\`;
  }
  if (Array.isArray(value)) {
    return \`[\${value.map((item) => format(item)).join(', ')}]\`;
  }
  return String(value);
}${checkBits}${enumReaders.map((r) => `\n\n${r}`).join('')}`,
    );
  }

  private enumReader(definition: Enum): string {
    const values = [...new Set(definition.values.map((v) => v.value))];
    const cases = values.map((v) => `${INDENT}${INDENT}case ${v}:`).join('\n');
    return `export function read${definition.name}(reader: PacketReader): ${definition.name} {
  const value = reader.read${WIRE_NAMES[definition.type]}();
  switch (value) {
${cases}
      return value as ${definition.name};
    default:
      throw new InvalidPacketError(\`unknown ${definition.name} value: \${value}\`);
  }
}`;
  }

  private bitEnumReader(definition: Enum): string {
    const values = [...new Set(definition.values.map((v) => v.value))];
    const cases = values.map((v) => `${INDENT}${INDENT}case ${v}:`).join('\n');
    return `/** Checks a value taken from a bit field against the values of ${definition.name}. */
export function bitsTo${definition.name}(value: number): ${definition.name} {
  switch (value) {
${cases}
      return value as ${definition.name};
    default:
      throw new InvalidPacketError(\`unknown ${definition.name} value: \${value}\`);
  }
}`;
  }

  private protocolEntryPoint(): string {
    const { protocol } = this;
    const opcodeSize = PRIMITIVE_SIZES[protocol.opcode];
    const opcodeMethod = WIRE_NAMES[protocol.opcode];
    const version =
      protocol.version === undefined ? '' : `\n  VERSION: ${tsString(protocol.version)},`;
    const decoder = (direction: 'c2s' | 's2c', method: string, sender: string): string => {
      const cases = protocol.packets
        .filter((p) => p.direction === direction)
        .map((p) => `      case ${p.name}.OPCODE:\n        return ${p.name}.readFrom(reader);`);
      return `  /**
   * Decodes a packet sent by the ${sender}, starting at the reader's position.
   * Bytes after the packet are left unread.
   *
   * Throws InvalidPacketError if the opcode is unknown or a value is invalid, and
   * TruncatedPacketError if the data ends too early.
   */
  ${method}(input: Uint8Array | PacketReader): Packet {
    const reader = input instanceof PacketReader ? input : new PacketReader(input);
    const opcode = reader.read${opcodeMethod}();
    switch (opcode) {
${[...cases, `      default:\n        throw new InvalidPacketError(\`unknown ${sender} opcode: 0x\${opcode.toString(16)}\`);`].join('\n')}
    }
  },`;
    };
    const imports: Import[] = [
      valueImport('PacketReader'),
      valueImport('PacketWriter'),
      typeImport('Packet'),
      {
        from: './PacketErrors.js',
        line: "import { InvalidPacketError } from './PacketErrors.js';",
      },
      ...protocol.packets.map((p) => valueImport(p.name)),
    ];
    return this.file(
      imports,
      `${jsdoc(protocol.doc, '')}export const ${this.protocolConst} = {
  NAME: ${tsString(protocol.name)},${version}

  /** Encodes the opcode followed by the packet body. */
  encode(packet: Packet): Uint8Array {
    const writer = new PacketWriter(${opcodeSize} + packet.bodySize());
    writer.write${opcodeMethod}(packet.opcode);
    packet.writeTo(writer);
    return writer.toUint8Array();
  },

${decoder('c2s', 'decodeFromClient', 'client')}

${decoder('s2c', 'decodeFromServer', 'server')}
} as const;`,
    );
  }

  private enumType(definition: Enum): string {
    const names = this.enumMembers.get(definition.name)!;
    const members = definition.values.map((v, i) => `${INDENT}${names[i]}: ${v.value},`).join('\n');
    return this.file(
      [],
      `${jsdoc(definition.doc, '')}export const ${definition.name} = {
${members}
} as const;

export type ${definition.name} = (typeof ${definition.name})[keyof typeof ${definition.name}];`,
    );
  }

  private structClass(struct: Struct): string {
    return this.messageClass(struct.name, struct.doc, struct.fields, undefined);
  }

  private packetClass(packet: Packet): string {
    return this.messageClass(packet.name, packet.doc, packet.fields, packet);
  }

  private messageClass(
    name: string,
    doc: string | undefined,
    fields: Field[],
    packet: Packet | undefined,
  ): string {
    const members: string[] = [];
    const opcodeDigits = this.protocol.opcode === 'u8' ? 2 : 4;
    const exposed = memberFields(fields);
    if (packet) {
      members.push(`  static readonly OPCODE = ${hex(packet.opcode, opcodeDigits)};`);
    }
    if (exposed.length > 0) {
      members.push(
        exposed
          .map(
            (field) =>
              jsdoc(field.doc, INDENT) +
              `${INDENT}${this.member(field)}: ${this.memberType(field)};`,
          )
          .join('\n'),
      );
      members.push(this.constructorMethod(exposed));
    }
    if (packet) {
      members.push(`  get opcode(): number {
    return ${name}.OPCODE;
  }`);
    }
    members.push(this.sizeMethod(fields, packet !== undefined));
    members.push(this.writeMethod(fields, packet !== undefined));
    if (packet) {
      members.push(`  encode(): Uint8Array {
    return ${this.protocolConst}.encode(this);
  }`);
    }
    members.push(this.readMethod(name, fields));
    members.push(this.equalsMethod(name, exposed));
    members.push(this.toStringMethod(name, exposed));

    const direction = packet?.direction === 'c2s' ? 'client to server' : 'server to client';
    const opcodeDoc = packet
      ? `Opcode ${hex(packet.opcode, opcodeDigits)}, sent from ${direction}.`
      : undefined;
    const classDoc =
      doc !== undefined && opcodeDoc !== undefined ? `${doc}\n\n${opcodeDoc}` : (doc ?? opcodeDoc);
    const body = members.join('\n\n');

    const imports: Import[] = [typeImport('PacketReader'), typeImport('PacketWriter')];
    if (new RegExp(`\\b${this.codec}\\.`).test(body)) {
      imports.push({
        from: `./${this.codec}.js`,
        line: `import * as ${this.codec} from './${this.codec}.js';`,
      });
    }
    if (packet) {
      imports.push(typeImport('Packet'), valueImport(this.protocolConst));
    }
    for (const dependency of this.dependencies(exposed)) {
      if (dependency !== name) imports.push(valueImport(dependency));
    }
    const header = packet ? `export class ${name} implements Packet {` : `export class ${name} {`;
    return this.file(imports, `${jsdoc(classDoc, '')}${header}\n${body}\n}`);
  }

  private dependencies(fields: MemberField[]): string[] {
    const names = new Set<string>();
    for (const { type } of fields) {
      const element = type.kind === 'array' || type.kind === 'fixedArray' ? type.element : type;
      if (element.kind === 'struct' || element.kind === 'enum') names.add(element.name);
    }
    return [...names];
  }

  private constructorMethod(fields: MemberField[]): string {
    const parameters = fields.map(
      (f) =>
        `${this.parameter(f)}: ${this.memberType(f)} = ${f.condition ? 'undefined' : this.defaultValue(f.type)}`,
    );
    const assignments = fields.map(
      (f) => `${INDENT}${INDENT}this.${this.member(f)} = ${this.parameter(f)};`,
    );
    const signature = `  constructor(${parameters.join(', ')}) {`;
    const wrapped =
      signature.length <= 100
        ? signature
        : `  constructor(\n${parameters.map((p) => `    ${p},`).join('\n')}\n  ) {`;
    return `${wrapped}\n${assignments.join('\n')}\n  }`;
  }

  private sizeMethod(fields: Field[], isPacket: boolean): string {
    let fixed = 0;
    const statements: string[] = [];
    for (const field of fields) {
      const size = this.fieldSize(field);
      if (!field.condition) {
        fixed += size.fixed;
        statements.push(...size.statements);
        continue;
      }
      // Counted by what the field holds, so that writeTo is the one to report a mismatch.
      const presence = `this.${this.member(fieldMembers(field)[0]!)}`;
      const inner = [...(size.fixed > 0 ? [`size += ${size.fixed};`] : []), ...size.statements];
      statements.push(
        `if (${presence} !== undefined) {`,
        ...inner.map((line) => `${INDENT}${line}`),
        '}',
      );
    }
    const signature = isPacket ? 'bodySize(): number' : 'encodedSize(): number';
    const doc = isPacket ? '' : '  /** Number of bytes writeTo writes. */\n';
    const body =
      statements.length === 0
        ? `    return ${fixed};\n`
        : indentLines([`let size = ${fixed};`, ...statements, 'return size;']);
    return `${doc}  ${signature} {\n${body}  }`;
  }

  private fieldSize(field: Field): { fixed: number; statements: string[] } {
    const { type } = field;
    const size = wireSize(type, this.protocol);
    if (size.fixed) return { fixed: size.min, statements: [] };
    const value = `this.${this.member(field as MemberField)}`;
    if (type.kind !== 'array' && type.kind !== 'fixedArray') {
      return { fixed: 0, statements: [`size += ${this.variableSize(type, value)};`] };
    }
    const element = wireSize(type.element, this.protocol);
    const fixed = type.kind === 'array' ? PRIMITIVE_SIZES[type.length] : 0;
    if (element.fixed) {
      const count = `${value}.length`;
      return {
        fixed,
        statements: [`size += ${element.min === 1 ? count : `${count} * ${element.min}`};`],
      };
    }
    return {
      fixed,
      statements: [
        `for (const item of ${value}) {`,
        `${INDENT}size += ${this.variableSize(type.element, 'item')};`,
        '}',
      ],
    };
  }

  private variableSize(type: FieldType, value: string): string {
    switch (type.kind) {
      case 'string':
        return `${this.codec}.stringSize(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `${PRIMITIVE_SIZES[type.length]} + ${value}.length`;
      case 'struct':
        return `${value}.encodedSize()`;
      default:
        return String(wireSize(type, this.protocol).min);
    }
  }

  private writeMethod(fields: Field[], isPacket: boolean): string {
    const statements = fields.flatMap((field) => {
      const body = this.writeField(field);
      if (!field.condition) return body;
      const present = `${camelCase(field.name)}Present`;
      const checks = fieldMembers(field).map((member) => {
        const name = this.member(member);
        return `${this.codec}.checkPresent(this.${name}, ${present}, ${tsString(name)});`;
      });
      return [
        `const ${present} = ${this.condition(fields, field.condition, 'this')};`,
        ...checks,
        `if (${present}) {`,
        ...body.map((line) => `${INDENT}${line}`),
        '}',
      ];
    });
    const doc = isPacket ? '' : '  /** Writes this struct. */\n';
    const writer = fields.length === 0 ? '_writer' : 'writer';
    const signature = `  writeTo(${writer}: PacketWriter): void {`;
    return `${doc}${signature}${statements.length === 0 ? '}' : `\n${indentLines(statements)}  }`}`;
  }

  private writeField(field: Field): string[] {
    const { type } = field;
    if (type.kind === 'bits') return this.writeBits(field, type, `${camelCase(field.name)}Bits`);
    const name = this.member(field as MemberField);
    const value = this.value(field as MemberField);
    if (type.kind !== 'array' && type.kind !== 'fixedArray') {
      return [`${this.write(type, value, name)};`];
    }
    const header =
      type.kind === 'array'
        ? `writer.writeLength(${value}.length, ${PRIMITIVE_SIZES[type.length]});`
        : `${this.codec}.checkCount(${value}, ${type.size}, ${tsString(name)});`;
    return [
      header,
      `for (const item of ${value}) {`,
      `${INDENT}${this.write(type.element, 'item', name)};`,
      '}',
    ];
  }

  /** The member as its plain type; a conditional one has passed checkPresent before this runs. */
  private value(field: MemberField): string {
    return `this.${this.member(field)}${field.condition ? '!' : ''}`;
  }

  // Bitwise operators work on signed 32-bit integers, so a u32 is brought back with >>> 0.
  private writeBits(group: Field, type: BitsType, local: string): string[] {
    const statements = [`let ${local} = 0;`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const member = bitMember(field, group.condition);
      const name = this.member(member);
      const shift = offset === 0 ? '' : ` << ${offset}`;
      if (field.type.kind === 'bool') {
        const bit = `${this.value(member)} ? 1 : 0`;
        statements.push(`${local} |= ${offset === 0 ? bit : `(${bit})${shift}`};`);
        continue;
      }
      statements.push(
        `${local} |= ${this.codec}.checkBits(${this.value(member)}, ${field.bits}, ${tsString(name)})${shift};`,
      );
    }
    const value = type.base === 'u32' ? `${local} >>> 0` : local;
    statements.push(`writer.write${WIRE_NAMES[type.base]}(${value});`);
    return statements;
  }

  private write(type: ElementType, value: string, field: string): string {
    switch (type.kind) {
      case 'primitive':
        return `writer.write${WIRE_NAMES[type.name]}(${value})`;
      case 'string':
        return `writer.writeString(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `writer.writeBytes(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `writer.writeFixedBytes(${value}, ${type.size}, ${tsString(field)})`;
      case 'struct':
        return `${value}.writeTo(writer)`;
      case 'enum':
        return `writer.write${WIRE_NAMES[findEnum(this.protocol, type.name).type]}(${value})`;
    }
  }

  private readMethod(name: string, fields: Field[]): string {
    const statements = fields.flatMap((field) => {
      const body = this.readField(field);
      if (!field.condition) return body;
      return [
        `if (${this.condition(fields, field.condition, 'result')}) {`,
        ...body.map((line) => `${INDENT}${line}`),
        '}',
      ];
    });
    const reader = fields.length === 0 ? '_reader' : 'reader';
    return `  /** Reads a ${name} starting at the reader's position. */
  static readFrom(${reader}: PacketReader): ${name} {
    const result = new ${name}();
${indentLines(statements)}    return result;
  }`;
  }

  private readField(field: Field): string[] {
    const { type } = field;
    if (type.kind === 'bits') return this.readBits(field, type, `${camelCase(field.name)}Bits`);
    const member = this.member(field as MemberField);
    const target = `result.${member}`;
    if (type.kind === 'array') {
      const count = `${member}Count`;
      return [
        `const ${count} = reader.readLength(${PRIMITIVE_SIZES[type.length]});`,
        `${target} = [];`,
        `for (let i = 0; i < ${count}; i++) {`,
        `${INDENT}${target}.push(${this.read(type.element)});`,
        '}',
      ];
    }
    if (type.kind === 'fixedArray') {
      return [
        `${target} = [];`,
        `for (let i = 0; i < ${type.size}; i++) {`,
        `${INDENT}${target}.push(${this.read(type.element)});`,
        '}',
      ];
    }
    return [`${target} = ${this.read(type)};`];
  }

  /** Tests a condition on `owner`; a target that is itself undefined never matches. */
  private condition(fields: Field[], condition: Condition, owner: string): string {
    const target = conditionTarget(fields, condition);
    const value = `${owner}.${this.member(target)}`;
    if (condition.kind === 'true') return target.condition ? `${value} === true` : value;
    return condition.values.map((v) => `${value} === ${this.literal(target.type, v)}`).join(' || ');
  }

  private literal(type: MemberType, value: number): string {
    if (type.kind === 'enum') {
      const { values } = findEnum(this.protocol, type.name);
      const index = values.findIndex((v) => v.value === value);
      return `${type.name}.${this.enumMembers.get(type.name)![index]}`;
    }
    const big = type.kind === 'primitive' && PRIMITIVE_TS[type.name] === 'bigint';
    return big ? `${value}n` : String(value);
  }

  private readBits(group: Field, type: BitsType, local: string): string[] {
    const statements = [`const ${local} = reader.read${WIRE_NAMES[type.base]}();`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const target = `result.${this.member(bitMember(field, group.condition))}`;
      // A mask reaching bit 31 would make the result negative; >>> alone already drops the rest.
      const bits =
        offset + field.bits === 32
          ? `${local} >>> ${offset}`
          : `${offset === 0 ? local : `(${local} >>> ${offset})`} & ${hexLower(2 ** field.bits - 1)}`;
      if (field.type.kind === 'bool') {
        statements.push(`${target} = (${bits}) !== 0;`);
      } else if (field.type.kind === 'enum') {
        statements.push(`${target} = ${this.codec}.bitsTo${field.type.name}(${bits});`);
      } else {
        statements.push(`${target} = ${bits};`);
      }
    }
    return statements;
  }

  private read(type: ElementType): string {
    switch (type.kind) {
      case 'primitive':
        return `reader.read${WIRE_NAMES[type.name]}()`;
      case 'string':
        return `reader.readString(${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `reader.readBytes(${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `reader.readFixedBytes(${type.size})`;
      case 'struct':
        return `${type.name}.readFrom(reader)`;
      case 'enum':
        return `${this.codec}.read${type.name}(reader)`;
    }
  }

  private equalsMethod(name: string, fields: MemberField[]): string {
    if (fields.length === 0) {
      return `  equals(other: unknown): boolean {
    return other instanceof ${name};
  }`;
    }
    const comparisons = fields.map((field) => {
      const n = this.member(field);
      const { type } = field;
      const list = type.kind === 'array' || type.kind === 'fixedArray';
      // Strict equality already handles undefined; the helpers that look inside a value do not.
      const nested =
        list || type.kind === 'bytes' || type.kind === 'fixedBytes' || type.kind === 'struct';
      if (field.condition && nested) {
        const same = list
          ? `(x, y) => ${this.codec}.listEqual(x, y, ${this.comparer(type.element)})`
          : this.comparer(type);
        return `${this.codec}.optionalEqual(this.${n}, other.${n}, ${same})`;
      }
      if (list) {
        return `${this.codec}.listEqual(this.${n}, other.${n}, ${this.comparer(type.element)})`;
      }
      return this.compare(type, `this.${n}`, `other.${n}`);
    });
    const expression = [`other instanceof ${name}`, ...comparisons].join('\n      && ');
    return `  equals(other: unknown): boolean {
    if (this === other) {
      return true;
    }
    return ${expression};
  }`;
  }

  private compare(type: ElementType, a: string, b: string): string {
    switch (type.kind) {
      case 'primitive':
        return type.name === 'f32' || type.name === 'f64'
          ? `Object.is(${a}, ${b})`
          : `${a} === ${b}`;
      case 'bytes':
      case 'fixedBytes':
        return `${this.codec}.bytesEqual(${a}, ${b})`;
      case 'struct':
        return `${a}.equals(${b})`;
      case 'string':
      case 'enum':
        return `${a} === ${b}`;
    }
  }

  private comparer(type: ElementType): string {
    if (type.kind === 'primitive' && (type.name === 'f32' || type.name === 'f64')) {
      return 'Object.is';
    }
    if (type.kind === 'bytes' || type.kind === 'fixedBytes') return `${this.codec}.bytesEqual`;
    return `(x, y) => ${this.compare(type, 'x', 'y')}`;
  }

  private toStringMethod(name: string, fields: MemberField[]): string {
    const parts = fields.map((field, index) => {
      const n = this.member(field);
      const { type } = field;
      const needsFormat =
        type.kind === 'bytes' ||
        type.kind === 'fixedBytes' ||
        type.kind === 'array' ||
        type.kind === 'fixedArray';
      const value = needsFormat ? `${this.codec}.format(this.${n})` : `this.${n}`;
      return `${index === 0 ? '' : ', '}${n}=\${${value}}`;
    });
    return `  toString(): string {
    return \`${name}{${parts.join('')}}\`;
  }`;
  }

  /** The declared type of a member; a conditional one can be undefined. */
  private memberType(field: MemberField): string {
    return `${this.tsType(field.type)}${field.condition ? ' | undefined' : ''}`;
  }

  private tsType(type: MemberType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVE_TS[type.name];
      case 'string':
        return 'string';
      case 'bytes':
      case 'fixedBytes':
        return 'Uint8Array';
      case 'struct':
      case 'enum':
        return type.name;
      case 'array':
      case 'fixedArray':
        return `${this.tsType(type.element)}[]`;
    }
  }

  private defaultValue(type: MemberType): string {
    switch (type.kind) {
      case 'primitive':
        if (type.name === 'bool') return 'false';
        return PRIMITIVE_TS[type.name] === 'bigint' ? '0n' : '0';
      case 'string':
        return "''";
      case 'bytes':
        return 'new Uint8Array(0)';
      case 'fixedBytes':
        return `new Uint8Array(${type.size})`;
      case 'struct':
        return `new ${type.name}()`;
      case 'enum':
        return `${type.name}.${this.enumMembers.get(type.name)![0]}`;
      case 'array':
        return '[]';
      case 'fixedArray':
        return `${this.codec}.repeat(${type.size}, () => ${this.defaultValue(type.element)})`;
    }
  }

  private file(imports: Import[], body: string): string {
    const sorted = [...new Map(imports.map((i) => [i.line, i])).values()].sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : a.line < b.line ? -1 : 1,
    );
    const importLines = sorted.map((i) => i.line);
    const header = `// Generated by pktspec from ${this.protocol.name}. Do not edit.\n`;
    return `${header}${importLines.length > 0 ? '\n' + importLines.join('\n') + '\n' : ''}\n${body}\n`;
  }
}

function hexLower(value: number): string {
  return '0x' + value.toString(16).padStart(2, '0');
}

function valueImport(name: string): Import {
  return { from: `./${name}.js`, line: `import { ${name} } from './${name}.js';` };
}

function typeImport(name: string): Import {
  return { from: `./${name}.js`, line: `import type { ${name} } from './${name}.js';` };
}

/** Indents method body lines; each line ends with a newline so an empty body stays empty. */
function indentLines(lines: string[]): string {
  return lines.map((line) => `${INDENT}${INDENT}${line}\n`).join('');
}

function jsdoc(text: string | undefined, indent: string): string {
  if (text === undefined) return '';
  const escaped = text.trim().replace(/\*\//g, '*\\/');
  const lines = escaped.split(LINE_BREAKS);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  const body = lines.map((line) => (line === '' ? `${indent} *` : `${indent} * ${line}`));
  return `${indent}/**\n${body.join('\n')}\n${indent} */\n`;
}

function tsString(value: string): string {
  const escaped = value.replace(/[^\x20-\x26\x28-\x5b\x5d-\x7e]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case "'":
        return "\\'";
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    }
  });
  return `'${escaped}'`;
}
