import {
  PRIMITIVE_SIZES,
  findEnum,
  wireSize,
  type ElementType,
  type Enum,
  type Field,
  type FieldType,
  type Packet,
  type PrimitiveType,
  type Protocol,
  type Struct,
} from '../model.js';
import { hex, pascalCase, type GeneratedFile } from './common.js';

export interface JavaOptions {
  /** Java package of the generated classes; derived from the protocol name when omitted. */
  package?: string;
}

const KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends false final finally float for goto if implements import instanceof int ' +
    'interface long native new null package private protected public return short static ' +
    'strictfp super switch synchronized this throw throws transient true try void volatile while _'
  ).split(' '),
);

// Names the generated files import or declare themselves.
const RESERVED_CLASS_NAMES = [
  'Packet',
  'Object',
  'String',
  'Byte',
  'Short',
  'Integer',
  'Long',
  'Float',
  'Double',
  'Boolean',
  'Math',
  'Override',
  'List',
  'ArrayList',
  'Arrays',
  'Objects',
  'ByteBuffer',
  'ByteOrder',
  'BufferUnderflowException',
  'IllegalArgumentException',
  'StandardCharsets',
  'Supplier',
];

const PRIMITIVE_JAVA: Record<PrimitiveType, { type: string; boxed: string; zero: string }> = {
  u8: { type: 'short', boxed: 'Short', zero: '(short) 0' },
  u16: { type: 'int', boxed: 'Integer', zero: '0' },
  u32: { type: 'long', boxed: 'Long', zero: '0L' },
  u64: { type: 'long', boxed: 'Long', zero: '0L' },
  i8: { type: 'byte', boxed: 'Byte', zero: '(byte) 0' },
  i16: { type: 'short', boxed: 'Short', zero: '(short) 0' },
  i32: { type: 'int', boxed: 'Integer', zero: '0' },
  i64: { type: 'long', boxed: 'Long', zero: '0L' },
  f32: { type: 'float', boxed: 'Float', zero: '0f' },
  f64: { type: 'double', boxed: 'Double', zero: '0d' },
  bool: { type: 'boolean', boxed: 'Boolean', zero: 'false' },
};

const BUFFER_METHODS: Partial<Record<PrimitiveType, string>> = {
  u64: 'Long',
  i8: '',
  i16: 'Short',
  i32: 'Int',
  i64: 'Long',
  f32: 'Float',
  f64: 'Double',
};

const INDENT = '    ';

export function defaultJavaPackage(protocolName: string): string {
  return protocolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isValidJavaPackage(name: string): boolean {
  return name
    .split('.')
    .every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !KEYWORDS.has(part));
}

export function generateJava(protocol: Protocol, options: JavaOptions = {}): GeneratedFile[] {
  const javaPackage = options.package ?? defaultJavaPackage(protocol.name);
  if (!isValidJavaPackage(javaPackage)) {
    throw new Error(`'${javaPackage}' is not a valid Java package name`);
  }
  const generator = new JavaGenerator(protocol, javaPackage);
  const directory = javaPackage.replace(/\./g, '/');
  return generator.files().map(([name, content]) => ({
    path: `${directory}/${name}.java`,
    content,
  }));
}

class JavaGenerator {
  private readonly prefix: string;
  private readonly codec: string;
  private readonly protocolClass: string;

  constructor(
    private readonly protocol: Protocol,
    private readonly javaPackage: string,
  ) {
    this.prefix = pascalCase(protocol.name);
    this.codec = `${this.prefix}Codec`;
    this.protocolClass = `${this.prefix}Protocol`;
    const reserved = new Set([...RESERVED_CLASS_NAMES, this.codec, this.protocolClass]);
    for (const { name } of [...protocol.enums, ...protocol.structs, ...protocol.packets]) {
      if (reserved.has(name)) {
        throw new Error(`'${name}' clashes with a class used by the generated Java code`);
      }
    }
  }

  files(): [string, string][] {
    return [
      ['Packet', this.packetInterface()],
      [this.codec, this.codecClass()],
      [this.protocolClass, this.protocolEntryPoint()],
      ...this.protocol.enums.map((e): [string, string] => [e.name, this.enumClass(e)]),
      ...this.protocol.structs.map((s): [string, string] => [s.name, this.structClass(s)]),
      ...this.protocol.packets.map((p): [string, string] => [p.name, this.packetClass(p)]),
    ];
  }

  private packetInterface(): string {
    return this.file(
      ['java.nio.ByteBuffer'],
      `/** A packet of the ${this.protocol.name} protocol. */
public interface Packet {
    /** The opcode that identifies this packet on the wire. */
    int opcode();

    /** Number of bytes {@link #writeTo} writes. The opcode is not included. */
    int bodySize();

    /**
     * Writes the packet body, without the opcode.
     *
     * <p>The buffer must use {@link ${this.protocolClass}#BYTE_ORDER}.
     */
    void writeTo(ByteBuffer buf);

    /** Returns the opcode followed by the body. */
    default byte[] encode() {
        return ${this.protocolClass}.encode(this);
    }
}`,
    );
  }

  private codecClass(): string {
    return this.file(
      [
        'java.nio.BufferUnderflowException',
        'java.nio.ByteBuffer',
        'java.nio.charset.StandardCharsets',
        'java.util.ArrayList',
        'java.util.List',
        'java.util.function.Supplier',
      ],
      `/** Encoding helpers shared by the generated classes. */
final class ${this.codec} {
    private ${this.codec}() {}

    static void writeU8(ByteBuffer buf, int value) {
        if (value < 0 || value > 0xFF) {
            throw new IllegalArgumentException("u8 out of range: " + value);
        }
        buf.put((byte) value);
    }

    static short readU8(ByteBuffer buf) {
        return (short) (buf.get() & 0xFF);
    }

    static void writeU16(ByteBuffer buf, int value) {
        if (value < 0 || value > 0xFFFF) {
            throw new IllegalArgumentException("u16 out of range: " + value);
        }
        buf.putShort((short) value);
    }

    static int readU16(ByteBuffer buf) {
        return buf.getShort() & 0xFFFF;
    }

    static void writeU32(ByteBuffer buf, long value) {
        if (value < 0 || value > 0xFFFFFFFFL) {
            throw new IllegalArgumentException("u32 out of range: " + value);
        }
        buf.putInt((int) value);
    }

    static long readU32(ByteBuffer buf) {
        return buf.getInt() & 0xFFFFFFFFL;
    }

    static void writeBool(ByteBuffer buf, boolean value) {
        buf.put(value ? (byte) 1 : (byte) 0);
    }

    static boolean readBool(ByteBuffer buf) {
        return buf.get() != 0;
    }

    static void writeLength(ByteBuffer buf, int length, int prefixSize) {
        long max = prefixSize == 4 ? 0xFFFFFFFFL : (1L << (prefixSize * 8)) - 1;
        if (length > max) {
            throw new IllegalArgumentException(
                    "length " + length + " does not fit in a " + prefixSize + "-byte prefix");
        }
        switch (prefixSize) {
            case 1:
                buf.put((byte) length);
                break;
            case 2:
                buf.putShort((short) length);
                break;
            default:
                buf.putInt(length);
                break;
        }
    }

    static int readLength(ByteBuffer buf, int prefixSize) {
        long length;
        switch (prefixSize) {
            case 1:
                length = readU8(buf);
                break;
            case 2:
                length = readU16(buf);
                break;
            default:
                length = readU32(buf);
                break;
        }
        if (length > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("length too large: " + length);
        }
        return (int) length;
    }

    static int stringSize(String value, int prefixSize) {
        return prefixSize + value.getBytes(StandardCharsets.UTF_8).length;
    }

    static void writeString(ByteBuffer buf, String value, int prefixSize) {
        writeBytes(buf, value.getBytes(StandardCharsets.UTF_8), prefixSize);
    }

    static String readString(ByteBuffer buf, int prefixSize) {
        return new String(readBytes(buf, prefixSize), StandardCharsets.UTF_8);
    }

    static void writeBytes(ByteBuffer buf, byte[] value, int prefixSize) {
        writeLength(buf, value.length, prefixSize);
        buf.put(value);
    }

    static byte[] readBytes(ByteBuffer buf, int prefixSize) {
        int length = readLength(buf, prefixSize);
        // Checked before allocating so a corrupt prefix cannot request a huge array.
        if (length > buf.remaining()) {
            throw new BufferUnderflowException();
        }
        return readFixedBytes(buf, length);
    }

    static void writeFixedBytes(ByteBuffer buf, byte[] value, int size, String field) {
        if (value.length != size) {
            throw new IllegalArgumentException(
                    field + " must be " + size + " bytes, got " + value.length);
        }
        buf.put(value);
    }

    static byte[] readFixedBytes(ByteBuffer buf, int size) {
        byte[] value = new byte[size];
        buf.get(value);
        return value;
    }

    static void checkCount(List<?> list, int count, String field) {
        if (list.size() != count) {
            throw new IllegalArgumentException(
                    field + " must have " + count + " elements, got " + list.size());
        }
    }

    static <T> List<T> newList(int count, ByteBuffer buf) {
        // A count read from the wire is not trusted for the initial capacity.
        return new ArrayList<>(Math.min(count, buf.remaining()));
    }

    static <T> List<T> repeat(int count, Supplier<T> element) {
        List<T> list = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            list.add(element.get());
        }
        return list;
    }
}`,
    );
  }

  private protocolEntryPoint(): string {
    const { protocol, codec } = this;
    const opcodeSize = PRIMITIVE_SIZES[protocol.opcode];
    const opcodeMethod = protocol.opcode === 'u8' ? 'U8' : 'U16';
    const order = protocol.endian === 'big' ? 'BIG_ENDIAN' : 'LITTLE_ENDIAN';
    const version =
      protocol.version === undefined
        ? ''
        : `    public static final String VERSION = ${javaString(protocol.version)};\n`;
    const decoder = (direction: 'c2s' | 's2c', method: string, sender: string): string => {
      const cases = protocol.packets
        .filter((p) => p.direction === direction)
        .map(
          (p) =>
            `            case ${p.name}.OPCODE:\n                return ${p.name}.readFrom(buf);`,
        );
      return `    /** Decodes a packet sent by the ${sender}. */
    public static Packet ${method}(byte[] data) {
        return ${method}(ByteBuffer.wrap(data).order(BYTE_ORDER));
    }

    /**
     * Decodes a packet sent by the ${sender}, starting at the buffer's position.
     *
     * <p>The buffer must use {@link #BYTE_ORDER}. Bytes after the packet are left unread.
     *
     * @throws IllegalArgumentException if the opcode is unknown or a value is invalid
     * @throws java.nio.BufferUnderflowException if the data ends too early
     */
    public static Packet ${method}(ByteBuffer buf) {
        int opcode = ${codec}.read${opcodeMethod}(buf);
        switch (opcode) {
${[...cases, `            default:\n                throw new IllegalArgumentException(\n                        "unknown ${sender} opcode: 0x" + Integer.toHexString(opcode));`].join('\n')}
        }
    }`;
    };

    return this.file(
      ['java.nio.ByteBuffer', 'java.nio.ByteOrder'],
      `${javadoc(protocol.doc, '')}public final class ${this.protocolClass} {
    public static final String NAME = ${javaString(protocol.name)};
${version}
    /** Byte order of every multi-byte value, including the opcode. */
    public static final ByteOrder BYTE_ORDER = ByteOrder.${order};

    private ${this.protocolClass}() {}

    /** Encodes the opcode followed by the packet body. */
    public static byte[] encode(Packet packet) {
        ByteBuffer buf = ByteBuffer.allocate(${opcodeSize} + packet.bodySize()).order(BYTE_ORDER);
        ${codec}.write${opcodeMethod}(buf, packet.opcode());
        packet.writeTo(buf);
        return buf.array();
    }

${decoder('c2s', 'decodeFromClient', 'client')}

${decoder('s2c', 'decodeFromServer', 'server')}
}`,
    );
  }

  private enumClass(definition: Enum): string {
    const valueType = definition.type === 'u32' ? 'long' : 'int';
    const suffix = definition.type === 'u32' ? 'L' : '';
    const names = definition.values.map((v) => identifier(v.name));
    const constants = definition.values
      .map((v, i) => `${INDENT}${names[i]}(${v.value}${suffix})`)
      .join(',\n');
    // Constants and fields share one namespace, so the wire value field steps aside for a constant.
    let field = 'value';
    while (names.includes(field)) field += '_';
    return this.file(
      [],
      `${javadoc(definition.doc, '')}public enum ${definition.name} {
${constants};

    private final ${valueType} ${field};

    ${definition.name}(${valueType} value) {
        this.${field} = value;
    }

    /** The value used on the wire. */
    public ${valueType} value() {
        return ${field};
    }

    /**
     * Returns the constant with the given wire value.
     *
     * @throws IllegalArgumentException if no constant has that value
     */
    public static ${definition.name} fromValue(${valueType} value) {
        for (${definition.name} constant : values()) {
            if (constant.${field} == value) {
                return constant;
            }
        }
        throw new IllegalArgumentException("unknown ${definition.name} value: " + value);
    }
}`,
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
    if (packet) {
      members.push(`    public static final int OPCODE = ${hex(packet.opcode, opcodeDigits)};`);
    }
    if (fields.length > 0) {
      members.push(
        fields
          .map((field) => {
            const initializer = this.defaultValue(field.type);
            const declaration = `public ${this.javaType(field.type)} ${fieldName(field.name)}`;
            return (
              javadoc(field.doc, INDENT) +
              `${INDENT}${declaration}${initializer ? ` = ${initializer}` : ''};`
            );
          })
          .join('\n'),
      );
    }
    members.push(this.constructors(name, fields));
    if (packet) {
      members.push(`    @Override
    public int opcode() {
        return OPCODE;
    }`);
    }
    members.push(this.sizeMethod(fields, packet !== undefined));
    members.push(this.writeMethod(fields, packet !== undefined));
    members.push(this.readMethod(name, fields));
    members.push(this.equalsMethod(name, fields));
    members.push(this.hashCodeMethod(fields));
    members.push(this.toStringMethod(name, fields));

    const direction = packet?.direction === 'c2s' ? 'client to server' : 'server to client';
    const opcodeDoc = packet
      ? `Opcode {@code ${hex(packet.opcode, opcodeDigits)}}, sent from ${direction}.`
      : undefined;
    const classDoc = doc && opcodeDoc ? `${doc}\n\n<p>${opcodeDoc}` : (doc ?? opcodeDoc);
    const header = packet
      ? `public final class ${name} implements Packet {`
      : `public final class ${name} {`;
    const body = members.join('\n\n');
    return this.file(
      ['java.nio.ByteBuffer', ...javaUtilImports(body)],
      `${javadoc(classDoc, '')}${header}\n${body}\n}`,
    );
  }

  private constructors(name: string, fields: Field[]): string {
    const empty = `    public ${name}() {}`;
    if (fields.length === 0) return empty;
    const parameters = fields.map((f) => `${this.javaType(f.type)} ${fieldName(f.name)}`);
    const assignments = fields.map(
      (f) => `        this.${fieldName(f.name)} = ${fieldName(f.name)};`,
    );
    const signature = `    public ${name}(${parameters.join(', ')}) {`;
    const wrapped =
      signature.length <= 100
        ? signature
        : `    public ${name}(\n${parameters.map((p) => `            ${p}`).join(',\n')}) {`;
    return `${empty}\n\n${wrapped}\n${assignments.join('\n')}\n    }`;
  }

  private sizeMethod(fields: Field[], isPacket: boolean): string {
    let fixed = 0;
    const statements: string[] = [];
    for (const field of fields) {
      const value = `this.${fieldName(field.name)}`;
      const { type } = field;
      const size = wireSize(type, this.protocol);
      if (size.fixed) {
        fixed += size.min;
      } else if (type.kind === 'array' || type.kind === 'fixedArray') {
        const element = wireSize(type.element, this.protocol);
        const prefix = type.kind === 'array' ? PRIMITIVE_SIZES[type.length] : 0;
        fixed += prefix;
        if (element.fixed) {
          const count = `${value}.size()`;
          statements.push(`size += ${element.min === 1 ? count : `${count} * ${element.min}`};`);
        } else {
          statements.push(
            `for (${this.javaType(type.element)} item : ${value}) {`,
            `${INDENT}size += ${this.variableSize(type.element, 'item')};`,
            '}',
          );
        }
      } else {
        statements.push(`size += ${this.variableSize(type, value)};`);
      }
    }
    const method = isPacket ? '@Override\n    public int bodySize()' : 'public int encodedSize()';
    const doc = isPacket ? '' : '    /** Number of bytes {@link #writeTo} writes. */\n';
    const body =
      statements.length === 0
        ? `        return ${fixed};\n`
        : indentLines([`int size = ${fixed};`, ...statements, 'return size;']);
    return `${doc}    ${method} {\n${body}    }`;
  }

  private variableSize(type: ElementType, value: string): string {
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
      const name = fieldName(field.name);
      const value = `this.${name}`;
      const { type } = field;
      if (type.kind !== 'array' && type.kind !== 'fixedArray') {
        return [`${this.write(type, value, name)};`];
      }
      const header =
        type.kind === 'array'
          ? `${this.codec}.writeLength(buf, ${value}.size(), ${PRIMITIVE_SIZES[type.length]});`
          : `${this.codec}.checkCount(${value}, ${type.size}, ${javaString(name)});`;
      return [
        header,
        `for (${this.javaType(type.element)} item : ${value}) {`,
        `${INDENT}${this.write(type.element, 'item', name)};`,
        '}',
      ];
    });
    const doc = isPacket
      ? '    @Override\n'
      : `    /**
     * Writes this struct.
     *
     * <p>The buffer must use {@link ${this.protocolClass}#BYTE_ORDER}.
     */
`;
    return `${doc}    public void writeTo(ByteBuffer buf) {\n${indentLines(statements)}    }`;
  }

  private write(type: ElementType, value: string, field: string): string {
    switch (type.kind) {
      case 'primitive':
        return this.writePrimitive(type.name, value);
      case 'string':
        return `${this.codec}.writeString(buf, ${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `${this.codec}.writeBytes(buf, ${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `${this.codec}.writeFixedBytes(buf, ${value}, ${type.size}, ${javaString(field)})`;
      case 'struct':
        return `${value}.writeTo(buf)`;
      case 'enum': {
        const base = findEnum(this.protocol, type.name).type;
        const cast = base === 'i8' ? '(byte) ' : base === 'i16' ? '(short) ' : '';
        return this.writePrimitive(base, `${cast}${value}.value()`);
      }
    }
  }

  private writePrimitive(type: PrimitiveType, value: string): string {
    switch (type) {
      case 'u8':
      case 'u16':
      case 'u32':
        return `${this.codec}.write${type.toUpperCase()}(buf, ${value})`;
      case 'bool':
        return `${this.codec}.writeBool(buf, ${value})`;
      default:
        return `buf.put${BUFFER_METHODS[type]}(${value})`;
    }
  }

  private readMethod(name: string, fields: Field[]): string {
    const statements = fields.flatMap((field) => {
      const target = `result.${fieldName(field.name)}`;
      const { type } = field;
      if (type.kind === 'array') {
        const count = `${fieldName(field.name)}Count`;
        return [
          `int ${count} = ${this.codec}.readLength(buf, ${PRIMITIVE_SIZES[type.length]});`,
          `${target} = ${this.codec}.newList(${count}, buf);`,
          `for (int i = 0; i < ${count}; i++) {`,
          `${INDENT}${target}.add(${this.read(type.element)});`,
          '}',
        ];
      }
      if (type.kind === 'fixedArray') {
        return [
          `${target} = new ArrayList<>(${type.size});`,
          `for (int i = 0; i < ${type.size}; i++) {`,
          `${INDENT}${target}.add(${this.read(type.element)});`,
          '}',
        ];
      }
      return [`${target} = ${this.read(type)};`];
    });
    return `    /**
     * Reads a {@code ${name}} starting at the buffer's position.
     *
     * <p>The buffer must use {@link ${this.protocolClass}#BYTE_ORDER}.
     */
    public static ${name} readFrom(ByteBuffer buf) {
        ${name} result = new ${name}();
${indentLines(statements)}        return result;
    }`;
  }

  private read(type: ElementType): string {
    switch (type.kind) {
      case 'primitive':
        return this.readPrimitive(type.name);
      case 'string':
        return `${this.codec}.readString(buf, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `${this.codec}.readBytes(buf, ${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `${this.codec}.readFixedBytes(buf, ${type.size})`;
      case 'struct':
        return `${type.name}.readFrom(buf)`;
      case 'enum':
        return `${type.name}.fromValue(${this.readPrimitive(findEnum(this.protocol, type.name).type)})`;
    }
  }

  private readPrimitive(type: PrimitiveType): string {
    switch (type) {
      case 'u8':
      case 'u16':
      case 'u32':
        return `${this.codec}.read${type.toUpperCase()}(buf)`;
      case 'bool':
        return `${this.codec}.readBool(buf)`;
      default:
        return `buf.get${BUFFER_METHODS[type]}()`;
    }
  }

  private equalsMethod(name: string, fields: Field[]): string {
    if (fields.length === 0) {
      return `    @Override
    public boolean equals(Object o) {
        return o instanceof ${name};
    }`;
    }
    const comparisons = fields.map((field) => {
      const n = fieldName(field.name);
      const { type } = field;
      if (type.kind === 'primitive' && type.name === 'f32') {
        return `Float.compare(this.${n}, other.${n}) == 0`;
      }
      if (type.kind === 'primitive' && type.name === 'f64') {
        return `Double.compare(this.${n}, other.${n}) == 0`;
      }
      if (type.kind === 'primitive' || type.kind === 'enum') return `this.${n} == other.${n}`;
      if (type.kind === 'bytes' || type.kind === 'fixedBytes') {
        return `Arrays.equals(this.${n}, other.${n})`;
      }
      return `Objects.equals(this.${n}, other.${n})`;
    });
    return `    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ${name})) {
            return false;
        }
        ${name} other = (${name}) o;
        return ${comparisons.join('\n                && ')};
    }`;
  }

  private hashCodeMethod(fields: Field[]): string {
    const values = fields.map((field) => {
      const n = fieldName(field.name);
      const isBytes = field.type.kind === 'bytes' || field.type.kind === 'fixedBytes';
      return isBytes ? `Arrays.hashCode(${n})` : n;
    });
    const expression = fields.length === 0 ? '0' : `Objects.hash(${values.join(', ')})`;
    return `    @Override
    public int hashCode() {
        return ${expression};
    }`;
  }

  private toStringMethod(name: string, fields: Field[]): string {
    const parts = fields.map((field, index) => {
      const n = fieldName(field.name);
      const isBytes = field.type.kind === 'bytes' || field.type.kind === 'fixedBytes';
      const label = javaString(`${index === 0 ? '' : ', '}${n}=`);
      return `${label} + ${isBytes ? `Arrays.toString(${n})` : n}`;
    });
    const expression =
      fields.length === 0
        ? javaString(`${name}{}`)
        : [javaString(`${name}{`), ...parts, javaString('}')].join('\n                + ');
    return `    @Override
    public String toString() {
        return ${expression};
    }`;
  }

  private javaType(type: FieldType, boxed = false): string {
    switch (type.kind) {
      case 'primitive':
        return boxed ? PRIMITIVE_JAVA[type.name].boxed : PRIMITIVE_JAVA[type.name].type;
      case 'string':
        return 'String';
      case 'bytes':
      case 'fixedBytes':
        return 'byte[]';
      case 'struct':
      case 'enum':
        return type.name;
      case 'array':
      case 'fixedArray':
        return `List<${this.javaType(type.element, true)}>`;
    }
  }

  private defaultValue(type: FieldType): string | undefined {
    switch (type.kind) {
      case 'primitive':
        return undefined;
      case 'string':
        return '""';
      case 'bytes':
        return 'new byte[0]';
      case 'fixedBytes':
        return `new byte[${type.size}]`;
      case 'struct':
        return `new ${type.name}()`;
      case 'enum':
        return `${type.name}.${identifier(findEnum(this.protocol, type.name).values[0]!.name)}`;
      case 'array':
        return 'new ArrayList<>()';
      case 'fixedArray': {
        const element = type.element;
        const supplier =
          element.kind === 'struct'
            ? `${element.name}::new`
            : `() -> ${element.kind === 'primitive' ? PRIMITIVE_JAVA[element.name].zero : this.defaultValue(element)}`;
        return `${this.codec}.repeat(${type.size}, ${supplier})`;
      }
    }
  }

  private file(imports: string[], body: string): string {
    const importLines = [...new Set(imports)].sort().map((name) => `import ${name};`);
    const header = `// Generated by pktspec from ${this.protocol.name}. Do not edit.\npackage ${this.javaPackage};\n`;
    return `${header}\n${importLines.length > 0 ? importLines.join('\n') + '\n\n' : ''}${body}\n`;
  }
}

/** Indents method body lines; each line ends with a newline so an empty body stays empty. */
function indentLines(lines: string[]): string {
  return lines.map((line) => `${INDENT}${INDENT}${line}\n`).join('');
}

function javaUtilImports(body: string): string[] {
  const imports: string[] = [];
  if (/\bArrayList</.test(body)) imports.push('java.util.ArrayList');
  if (/\bArrays\./.test(body)) imports.push('java.util.Arrays');
  if (/\bList</.test(body)) imports.push('java.util.List');
  if (/\bObjects\./.test(body)) imports.push('java.util.Objects');
  return imports;
}

function fieldName(name: string): string {
  const parts = name.split('_').filter((part) => part !== '');
  const camel = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
  return identifier(camel);
}

function identifier(name: string): string {
  return KEYWORDS.has(name) ? `${name}_` : name;
}

function javadoc(text: string | undefined, indent: string): string {
  if (text === undefined) return '';
  const escaped = text
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/<(?!\/?p>)/g, '&lt;')
    .replace(/(?<!<\/?p)>/g, '&gt;')
    .replace(/\*\//g, '*&#47;')
    // javac decodes \u escapes before it reads comments, so a backslash in a doc can break the file.
    .replace(/\\/g, '&#92;');
  const lines = asciiOnly(escaped).split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  const body = lines.map((line) => (line === '' ? `${indent} *` : `${indent} * ${line}`));
  return `${indent}/**\n${body.join('\n')}\n${indent} */\n`;
}

function javaString(value: string): string {
  return asciiOnly(JSON.stringify(value));
}

/** Keeps generated files ASCII so javac reads them the same under any default encoding. */
function asciiOnly(text: string): string {
  return text.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
