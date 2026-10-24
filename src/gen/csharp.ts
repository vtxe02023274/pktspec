import {
  PRIMITIVE_SIZES,
  bitEnums,
  bitGroups,
  bitLayout,
  bitMember,
  findEnum,
  memberFields,
  wireSize,
  type BitsType,
  type ElementType,
  type Enum,
  type EnumBaseType,
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

export interface CSharpOptions {
  /** C# namespace of the generated types; derived from the protocol name when omitted. */
  namespace?: string;
}

const KEYWORDS = new Set(
  (
    'abstract as base bool break byte case catch char checked class const continue decimal ' +
    'default delegate do double else enum event explicit extern false finally fixed float for ' +
    'foreach goto if implicit in int interface internal is lock long namespace new null object ' +
    'operator out override params private protected public readonly ref return sbyte sealed ' +
    'short sizeof stackalloc static string struct switch this throw true try typeof uint ulong ' +
    'unchecked unsafe ushort using virtual void volatile while'
  ).split(' '),
);

// Names the generated files use unqualified, or that would hide one of them inside the namespace.
const RESERVED_TYPE_NAMES = [
  'IPacket',
  'PacketReader',
  'PacketWriter',
  'Encode',
  'DecodeFromClient',
  'DecodeFromServer',
  'ProtocolName',
  'ProtocolVersion',
  'System',
  'Action',
  'Array',
  'ArgumentException',
  'BitConverter',
  'BinaryPrimitives',
  'Boolean',
  'Byte',
  'CultureInfo',
  'Convert',
  'Double',
  'Encoding',
  'EndOfStreamException',
  'EqualityComparer',
  'Func',
  'HashCode',
  'IEquatable',
  'Int16',
  'Int32',
  'Int64',
  'InvalidDataException',
  'InvalidOperationException',
  'List',
  'Math',
  'Object',
  'ReadOnlyMemory',
  'ReadOnlySpan',
  'SByte',
  'Single',
  'Span',
  'String',
  'UInt16',
  'UInt32',
  'UInt64',
];

// Members the generated classes declare themselves or inherit from object.
const RESERVED_MEMBERS = [
  'Opcode',
  'OpcodeValue',
  'BodySize',
  'EncodedSize',
  'WriteTo',
  'ReadFrom',
  'Encode',
  'Equals',
  'GetHashCode',
  'ToString',
  'GetType',
  'MemberwiseClone',
  'Finalize',
  'ReferenceEquals',
];

const PRIMITIVE_CS: Record<PrimitiveType, string> = {
  u8: 'byte',
  u16: 'ushort',
  u32: 'uint',
  u64: 'ulong',
  i8: 'sbyte',
  i16: 'short',
  i32: 'int',
  i64: 'long',
  f32: 'float',
  f64: 'double',
  bool: 'bool',
};

const ENUM_BASE_CS: Record<EnumBaseType, string> = {
  u8: 'byte',
  u16: 'ushort',
  u32: 'uint',
  i8: 'sbyte',
  i16: 'short',
  i32: 'int',
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

const INDENT = '    ';

const CHECK_BITS = `    /// <exception cref="ArgumentException">The value does not fit in <paramref name="bits"/> bits.</exception>
    internal static uint CheckBits(ulong value, int bits, string field)
    {
        if (value >= 1UL << bits)
        {
            throw new ArgumentException($"{field} out of range for {bits} bits: {value}");
        }
        return (uint)value;
    }`;

export function defaultCSharpNamespace(protocolName: string): string {
  return pascalCase(protocolName);
}

export function isValidCSharpNamespace(name: string): boolean {
  return name
    .split('.')
    .every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !KEYWORDS.has(part));
}

export function generateCSharp(protocol: Protocol, options: CSharpOptions = {}): GeneratedFile[] {
  const csNamespace = options.namespace ?? defaultCSharpNamespace(protocol.name);
  if (!isValidCSharpNamespace(csNamespace)) {
    throw new Error(`'${csNamespace}' is not a valid C# namespace name`);
  }
  const generator = new CSharpGenerator(protocol, csNamespace);
  return generator.files().map(([name, content]) => ({ path: `${name}.cs`, content }));
}

class CSharpGenerator {
  private readonly prefix: string;
  private readonly codec: string;
  private readonly protocolClass: string;
  private readonly typeNames: Set<string>;
  private readonly memberNames = new Map<MemberField, string>();
  private readonly enumMembers = new Map<string, string[]>();

  constructor(
    private readonly protocol: Protocol,
    private readonly csNamespace: string,
  ) {
    this.prefix = pascalCase(protocol.name);
    this.codec = `${this.prefix}Codec`;
    this.protocolClass = `${this.prefix}Protocol`;
    // Compared without case because the generated files may land on a case-insensitive file system.
    const reserved = new Set(
      [...RESERVED_TYPE_NAMES, this.codec, this.protocolClass].map((n) => n.toLowerCase()),
    );
    for (const { name } of [...protocol.enums, ...protocol.structs, ...protocol.packets]) {
      if (reserved.has(name.toLowerCase())) {
        throw new Error(`'${name}' clashes with a type used by the generated C# code`);
      }
    }
    this.typeNames = new Set(
      [...protocol.enums, ...protocol.structs, ...protocol.packets].map((t) => t.name),
    );
    for (const definition of protocol.enums) {
      const used = new Set<string>();
      this.enumMembers.set(
        definition.name,
        definition.values.map((v) => uniqueName(enumMemberName(v.name), used)),
      );
    }
    for (const { name, fields } of [...protocol.structs, ...protocol.packets]) {
      const used = new Set([...RESERVED_MEMBERS, name]);
      for (const field of memberFields(fields)) {
        const base = pascalCase(field.name);
        const member = uniqueName(base, used, (candidate) => this.hidesType(candidate, field.type));
        this.memberNames.set(field, member);
      }
    }
  }

  files(): [string, string][] {
    return [
      ['IPacket', this.packetInterface()],
      ['PacketReader', this.readerClass()],
      ['PacketWriter', this.writerClass()],
      [this.codec, this.codecClass()],
      [this.protocolClass, this.protocolEntryPoint()],
      ...this.protocol.enums.map((e): [string, string] => [e.name, this.enumType(e)]),
      ...this.protocol.structs.map((s): [string, string] => [s.name, this.structClass(s)]),
      ...this.protocol.packets.map((p): [string, string] => [p.name, this.packetClass(p)]),
    ];
  }

  // A member named like a type breaks static calls on that type, unless it is the Color Color case.
  private hidesType(name: string, type: MemberType): boolean {
    if (!this.typeNames.has(name)) return false;
    return !((type.kind === 'struct' || type.kind === 'enum') && type.name === name);
  }

  private member(field: MemberField): string {
    return this.memberNames.get(field)!;
  }

  private packetInterface(): string {
    return this.file(
      [],
      `/// <summary>A packet of the ${this.protocol.name} protocol.</summary>
public interface IPacket
{
    /// <summary>The opcode that identifies this packet on the wire.</summary>
    int Opcode { get; }

    /// <summary>Number of bytes <see cref="WriteTo"/> writes. The opcode is not included.</summary>
    int BodySize();

    /// <summary>Writes the packet body, without the opcode.</summary>
    void WriteTo(PacketWriter writer);

    /// <summary>Returns the opcode followed by the body.</summary>
    byte[] Encode();
}`,
    );
  }

  private readerClass(): string {
    const order = this.protocol.endian === 'big' ? 'BigEndian' : 'LittleEndian';
    const primitive = (type: string, method: string): string =>
      `    public ${PRIMITIVE_CS[type as PrimitiveType]} Read${WIRE_NAMES[type as PrimitiveType]}()
    {
        return BinaryPrimitives.Read${method}${order}(Take(${PRIMITIVE_SIZES[type as PrimitiveType]}));
    }`;
    return this.file(
      ['System', 'System.Buffers.Binary', 'System.IO', 'System.Text'],
      `/// <summary>Reads packet values from a buffer, in the byte order of the ${this.protocol.name} protocol.</summary>
public sealed class PacketReader
{
    private readonly ReadOnlyMemory<byte> data;
    private int position;

    public PacketReader(ReadOnlyMemory<byte> data)
    {
        this.data = data;
    }

    /// <summary>Number of bytes read so far.</summary>
    public int Position => position;

    /// <summary>Number of bytes left to read.</summary>
    public int Remaining => data.Length - position;

    private ReadOnlySpan<byte> Take(int count)
    {
        if (count > data.Length - position)
        {
            throw new EndOfStreamException("The data ends before the packet does.");
        }
        ReadOnlySpan<byte> span = data.Span.Slice(position, count);
        position += count;
        return span;
    }

    public byte ReadU8()
    {
        return Take(1)[0];
    }

${primitive('u16', 'UInt16')}

${primitive('u32', 'UInt32')}

${primitive('u64', 'UInt64')}

    public sbyte ReadI8()
    {
        return (sbyte)Take(1)[0];
    }

${primitive('i16', 'Int16')}

${primitive('i32', 'Int32')}

${primitive('i64', 'Int64')}

    public float ReadF32()
    {
        return BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32${order}(Take(4)));
    }

    public double ReadF64()
    {
        return BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64${order}(Take(8)));
    }

    public bool ReadBool()
    {
        return Take(1)[0] != 0;
    }

    /// <summary>Reads a length or count prefix of 1, 2 or 4 bytes.</summary>
    public int ReadLength(int prefixSize)
    {
        uint length;
        switch (prefixSize)
        {
            case 1:
                length = ReadU8();
                break;
            case 2:
                length = ReadU16();
                break;
            default:
                length = ReadU32();
                break;
        }
        if (length > int.MaxValue)
        {
            throw new InvalidDataException("length too large: " + length);
        }
        return (int)length;
    }

    public string ReadString(int prefixSize)
    {
        int length = ReadLength(prefixSize);
        return Encoding.UTF8.GetString(Take(length));
    }

    public byte[] ReadBytes(int prefixSize)
    {
        return ReadFixedBytes(ReadLength(prefixSize));
    }

    public byte[] ReadFixedBytes(int size)
    {
        // The span is taken before allocating so a corrupt prefix cannot request a huge array.
        return Take(size).ToArray();
    }
}`,
    );
  }

  private writerClass(): string {
    const order = this.protocol.endian === 'big' ? 'BigEndian' : 'LittleEndian';
    const primitive = (type: PrimitiveType, method: string): string =>
      `    public void Write${WIRE_NAMES[type]}(${PRIMITIVE_CS[type]} value)
    {
        BinaryPrimitives.Write${method}${order}(Next(${PRIMITIVE_SIZES[type]}), value);
    }`;
    return this.file(
      ['System', 'System.Buffers.Binary', 'System.Text'],
      `/// <summary>Writes packet values into a fixed-size buffer, in the byte order of the ${this.protocol.name} protocol.</summary>
public sealed class PacketWriter
{
    private readonly byte[] buffer;
    private int position;

    /// <summary>Creates a writer with room for <paramref name="size"/> bytes.</summary>
    public PacketWriter(int size)
    {
        buffer = new byte[size];
    }

    /// <summary>Number of bytes written so far.</summary>
    public int Position => position;

    /// <summary>Returns the bytes written so far.</summary>
    public byte[] ToArray()
    {
        return position == buffer.Length ? buffer : buffer.AsSpan(0, position).ToArray();
    }

    private Span<byte> Next(int count)
    {
        if (count > buffer.Length - position)
        {
            throw new InvalidOperationException("The buffer is too small for the packet.");
        }
        Span<byte> span = buffer.AsSpan(position, count);
        position += count;
        return span;
    }

    public void WriteU8(byte value)
    {
        Next(1)[0] = value;
    }

${primitive('u16', 'UInt16')}

${primitive('u32', 'UInt32')}

${primitive('u64', 'UInt64')}

    public void WriteI8(sbyte value)
    {
        Next(1)[0] = (byte)value;
    }

${primitive('i16', 'Int16')}

${primitive('i32', 'Int32')}

${primitive('i64', 'Int64')}

    public void WriteF32(float value)
    {
        BinaryPrimitives.WriteInt32${order}(Next(4), BitConverter.SingleToInt32Bits(value));
    }

    public void WriteF64(double value)
    {
        BinaryPrimitives.WriteInt64${order}(Next(8), BitConverter.DoubleToInt64Bits(value));
    }

    public void WriteBool(bool value)
    {
        Next(1)[0] = value ? (byte)1 : (byte)0;
    }

    /// <summary>Writes a length or count prefix of 1, 2 or 4 bytes.</summary>
    /// <exception cref="ArgumentException">The length does not fit in the prefix.</exception>
    public void WriteLength(int length, int prefixSize)
    {
        long max = prefixSize == 4 ? 0xFFFFFFFFL : (1L << (prefixSize * 8)) - 1;
        if (length > max)
        {
            throw new ArgumentException($"length {length} does not fit in a {prefixSize}-byte prefix");
        }
        switch (prefixSize)
        {
            case 1:
                WriteU8((byte)length);
                break;
            case 2:
                WriteU16((ushort)length);
                break;
            default:
                WriteU32((uint)length);
                break;
        }
    }

    public void WriteString(string value, int prefixSize)
    {
        WriteBytes(Encoding.UTF8.GetBytes(value), prefixSize);
    }

    public void WriteBytes(byte[] value, int prefixSize)
    {
        WriteLength(value.Length, prefixSize);
        value.AsSpan().CopyTo(Next(value.Length));
    }

    /// <exception cref="ArgumentException">The array is not exactly <paramref name="size"/> bytes long.</exception>
    public void WriteFixedBytes(byte[] value, int size, string field)
    {
        if (value.Length != size)
        {
            throw new ArgumentException($"{field} must be {size} bytes, got {value.Length}");
        }
        value.AsSpan().CopyTo(Next(size));
    }
}`,
    );
  }

  private codecClass(): string {
    const inBits = bitEnums(this.protocol);
    const enumReaders = this.protocol.enums.flatMap((e) => [
      this.enumReader(e),
      ...(inBits.has(e.name) ? [this.bitEnumReader(e)] : []),
    ]);
    const checkBits = bitGroups(this.protocol).length > 0 ? `\n\n${CHECK_BITS}` : '';
    return this.file(
      ['System', 'System.Collections.Generic', 'System.Globalization', 'System.IO', 'System.Text'],
      `/// <summary>Helpers shared by the generated classes.</summary>
internal static class ${this.codec}
{
    internal static int StringSize(string value, int prefixSize)
    {
        return prefixSize + Encoding.UTF8.GetByteCount(value);
    }

    internal static void CheckCount<T>(List<T> list, int count, string field)
    {
        if (list.Count != count)
        {
            throw new ArgumentException($"{field} must have {count} elements, got {list.Count}");
        }
    }

    internal static List<T> NewList<T>(int count, PacketReader reader)
    {
        // A count read from the wire is not trusted for the initial capacity.
        return new List<T>(Math.Min(count, reader.Remaining));
    }

    internal static List<T> Repeat<T>(int count, Func<T> element)
    {
        var list = new List<T>(count);
        for (int i = 0; i < count; i++)
        {
            list.Add(element());
        }
        return list;
    }

    internal static bool BytesEqual(byte[] a, byte[] b)
    {
        return a.AsSpan().SequenceEqual(b);
    }

    internal static bool ListEqual<T>(List<T> a, List<T> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }
        var comparer = EqualityComparer<T>.Default;
        for (int i = 0; i < a.Count; i++)
        {
            if (!comparer.Equals(a[i], b[i]))
            {
                return false;
            }
        }
        return true;
    }

    internal static int BytesHash(byte[] value)
    {
        var hash = new HashCode();
        foreach (byte item in value)
        {
            hash.Add(item);
        }
        return hash.ToHashCode();
    }

    internal static int ListHash<T>(List<T> value)
    {
        var hash = new HashCode();
        foreach (T item in value)
        {
            hash.Add(item);
        }
        return hash.ToHashCode();
    }

    internal static string Format<T>(T value)
    {
        return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
    }

    internal static string Format(byte[] value)
    {
        var parts = new string[value.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            parts[i] = value[i].ToString(CultureInfo.InvariantCulture);
        }
        return "[" + string.Join(", ", parts) + "]";
    }

    internal static string Format<T>(List<T> value)
    {
        var parts = new string[value.Count];
        for (int i = 0; i < parts.Length; i++)
        {
            parts[i] = Format(value[i]);
        }
        return "[" + string.Join(", ", parts) + "]";
    }${checkBits}${enumReaders.map((r) => `\n\n${r}`).join('')}
}`,
    );
  }

  private enumReader(definition: Enum): string {
    const base = ENUM_BASE_CS[definition.type];
    const values = [...new Set(definition.values.map((v) => v.value))];
    const cases = values.map((v) => `${INDENT}${INDENT}${INDENT}case ${v}:`).join('\n');
    return `    internal static ${definition.name} Read${definition.name}(PacketReader reader)
    {
        ${base} value = reader.Read${WIRE_NAMES[definition.type]}();
        switch (value)
        {
${cases}
                return (${definition.name})value;
            default:
                throw new InvalidDataException("unknown ${definition.name} value: " + value);
        }
    }`;
  }

  private bitEnumReader(definition: Enum): string {
    const values = [...new Set(definition.values.map((v) => v.value))];
    const cases = values.map((v) => `${INDENT}${INDENT}${INDENT}case ${v}:`).join('\n');
    return `    internal static ${definition.name} BitsTo${definition.name}(uint value)
    {
        switch (value)
        {
${cases}
                return (${definition.name})value;
            default:
                throw new InvalidDataException("unknown ${definition.name} value: " + value);
        }
    }`;
  }

  private protocolEntryPoint(): string {
    const { protocol } = this;
    const opcodeSize = PRIMITIVE_SIZES[protocol.opcode];
    const opcodeMethod = protocol.opcode === 'u8' ? 'U8' : 'U16';
    const opcodeType = protocol.opcode === 'u8' ? 'byte' : 'ushort';
    const maxOpcode = protocol.opcode === 'u8' ? '0xFF' : '0xFFFF';
    const version =
      protocol.version === undefined
        ? ''
        : `\n    public const string ProtocolVersion = ${csharpString(protocol.version)};`;
    const decoder = (direction: 'c2s' | 's2c', method: string, sender: string): string => {
      const cases = protocol.packets
        .filter((p) => p.direction === direction)
        .map(
          (p) =>
            `            case ${p.name}.OpcodeValue:\n                return ${p.name}.ReadFrom(reader);`,
        );
      return `    /// <summary>Decodes a packet sent by the ${sender}.</summary>
    /// <exception cref="InvalidDataException">The opcode is unknown or a value is invalid.</exception>
    /// <exception cref="EndOfStreamException">The data ends too early.</exception>
    public static IPacket ${method}(ReadOnlyMemory<byte> data)
    {
        return ${method}(new PacketReader(data));
    }

    /// <summary>
    /// Decodes a packet sent by the ${sender}, starting at the reader's position.
    /// Bytes after the packet are left unread.
    /// </summary>
    /// <exception cref="InvalidDataException">The opcode is unknown or a value is invalid.</exception>
    /// <exception cref="EndOfStreamException">The data ends too early.</exception>
    public static IPacket ${method}(PacketReader reader)
    {
        int opcode = reader.Read${opcodeMethod}();
        switch (opcode)
        {
${[...cases, `            default:\n                throw new InvalidDataException("unknown ${sender} opcode: 0x" + opcode.ToString("x"));`].join('\n')}
        }
    }`;
    };

    return this.file(
      ['System', 'System.IO'],
      `${xmlDoc(protocol.doc, '')}public static class ${this.protocolClass}
{
    public const string ProtocolName = ${csharpString(protocol.name)};${version}

    /// <summary>Encodes the opcode followed by the packet body.</summary>
    public static byte[] Encode(IPacket packet)
    {
        int opcode = packet.Opcode;
        if (opcode < 0 || opcode > ${maxOpcode})
        {
            throw new ArgumentException("opcode out of range: " + opcode);
        }
        var writer = new PacketWriter(${opcodeSize} + packet.BodySize());
        writer.Write${opcodeMethod}((${opcodeType})opcode);
        packet.WriteTo(writer);
        return writer.ToArray();
    }

${decoder('c2s', 'DecodeFromClient', 'client')}

${decoder('s2c', 'DecodeFromServer', 'server')}
}`,
    );
  }

  private enumType(definition: Enum): string {
    const names = this.enumMembers.get(definition.name)!;
    const members = definition.values
      .map((v, i) => `${INDENT}${names[i]} = ${v.value},`)
      .join('\n');
    return this.file(
      [],
      `${xmlDoc(definition.doc, '')}public enum ${definition.name} : ${ENUM_BASE_CS[definition.type]}
{
${members}
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
    const exposed = memberFields(fields);
    if (packet) {
      members.push(`    public const int OpcodeValue = ${hex(packet.opcode, opcodeDigits)};`);
    }
    if (exposed.length > 0) {
      members.push(
        exposed
          .map((field) => {
            const initializer = this.defaultValue(field.type);
            const declaration = `public ${this.csType(field.type)} ${this.member(field)} { get; set; }`;
            return (
              xmlDoc(field.doc, INDENT) +
              `${INDENT}${declaration}${initializer ? ` = ${initializer};` : ''}`
            );
          })
          .join('\n'),
      );
    }
    members.push(this.constructors(name, exposed));
    if (packet) {
      members.push(`    /// <inheritdoc />
    public int Opcode => OpcodeValue;`);
    }
    members.push(this.sizeMethod(fields, packet !== undefined));
    members.push(this.writeMethod(fields, packet !== undefined));
    if (packet) {
      members.push(`    /// <inheritdoc />
    public byte[] Encode()
    {
        return ${this.protocolClass}.Encode(this);
    }`);
    }
    members.push(this.readMethod(name, fields));
    members.push(this.equalsMethods(name, exposed));
    members.push(this.hashCodeMethod(exposed));
    members.push(this.toStringMethod(name, exposed));

    const direction = packet?.direction === 'c2s' ? 'client to server' : 'server to client';
    const opcodeDoc = packet
      ? `Opcode ${hex(packet.opcode, opcodeDigits)}, sent from ${direction}.`
      : undefined;
    const classDoc =
      doc !== undefined && opcodeDoc !== undefined
        ? `${xmlDoc(doc, '')}${xmlDoc(opcodeDoc, '', 'remarks')}`
        : xmlDoc(doc ?? opcodeDoc, '');
    const bases = packet ? `IPacket, IEquatable<${name}>` : `IEquatable<${name}>`;
    const body = members.join('\n\n');
    const usings = ['System'];
    if (/\bList</.test(body)) usings.push('System.Collections.Generic');
    return this.file(usings, `${classDoc}public sealed class ${name} : ${bases}\n{\n${body}\n}`);
  }

  private constructors(name: string, fields: MemberField[]): string {
    if (fields.length === 0) return `    public ${name}()\n    {\n    }`;
    const empty = `    public ${name}()\n    {\n    }`;
    const parameters = fields.map((f) => `${this.csType(f.type)} ${this.parameter(f)}`);
    const assignments = fields.map((f) => `        this.${this.member(f)} = ${this.parameter(f)};`);
    const signature = `    public ${name}(${parameters.join(', ')})`;
    const wrapped =
      signature.length <= 100
        ? signature
        : `    public ${name}(\n${parameters.map((p) => `        ${p}`).join(',\n')})`;
    return `${empty}\n\n${wrapped}\n    {\n${assignments.join('\n')}\n    }`;
  }

  private parameter(field: MemberField): string {
    const member = this.member(field);
    const camel = member.charAt(0).toLowerCase() + member.slice(1);
    return KEYWORDS.has(camel) ? `@${camel}` : camel;
  }

  private sizeMethod(fields: Field[], isPacket: boolean): string {
    let fixed = 0;
    const statements: string[] = [];
    for (const field of fields) {
      const { type } = field;
      const size = wireSize(type, this.protocol);
      if (size.fixed) {
        fixed += size.min;
        continue;
      }
      const value = `this.${this.member(field as MemberField)}`;
      if (type.kind === 'array' || type.kind === 'fixedArray') {
        const element = wireSize(type.element, this.protocol);
        const prefix = type.kind === 'array' ? PRIMITIVE_SIZES[type.length] : 0;
        fixed += prefix;
        if (element.fixed) {
          const count = `${value}.Count`;
          statements.push(`size += ${element.min === 1 ? count : `${count} * ${element.min}`};`);
        } else {
          statements.push(
            `foreach (${this.csType(type.element)} item in ${value})`,
            '{',
            `${INDENT}size += ${this.variableSize(type.element, 'item')};`,
            '}',
          );
        }
      } else {
        statements.push(`size += ${this.variableSize(type, value)};`);
      }
    }
    const signature = isPacket ? 'public int BodySize()' : 'public int EncodedSize()';
    const doc = isPacket
      ? '    /// <inheritdoc />\n'
      : '    /// <summary>Number of bytes <see cref="WriteTo"/> writes.</summary>\n';
    const body =
      statements.length === 0
        ? `        return ${fixed};\n`
        : indentLines([`int size = ${fixed};`, ...statements, 'return size;']);
    return `${doc}    ${signature}\n    {\n${body}    }`;
  }

  private variableSize(type: FieldType, value: string): string {
    switch (type.kind) {
      case 'string':
        return `${this.codec}.StringSize(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `${PRIMITIVE_SIZES[type.length]} + ${value}.Length`;
      case 'struct':
        return `${value}.EncodedSize()`;
      default:
        return String(wireSize(type, this.protocol).min);
    }
  }

  private writeMethod(fields: Field[], isPacket: boolean): string {
    const statements = fields.flatMap((field) => {
      const { type } = field;
      if (type.kind === 'bits') return this.writeBits(type, `${camelCase(field.name)}Bits`);
      const name = this.member(field as MemberField);
      const value = `this.${name}`;
      if (type.kind !== 'array' && type.kind !== 'fixedArray') {
        return [`${this.write(type, value, name)};`];
      }
      const header =
        type.kind === 'array'
          ? `writer.WriteLength(${value}.Count, ${PRIMITIVE_SIZES[type.length]});`
          : `${this.codec}.CheckCount(${value}, ${type.size}, ${csharpString(name)});`;
      return [
        header,
        `foreach (${this.csType(type.element)} item in ${value})`,
        '{',
        `${INDENT}${this.write(type.element, 'item', name)};`,
        '}',
      ];
    });
    const doc = isPacket
      ? '    /// <inheritdoc />\n'
      : '    /// <summary>Writes this struct.</summary>\n';
    return `${doc}    public void WriteTo(PacketWriter writer)\n    {\n${indentLines(statements)}    }`;
  }

  private writeBits(type: BitsType, local: string): string[] {
    const statements = [`uint ${local} = 0;`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const member = this.member(bitMember(field));
      const shift = offset === 0 ? '' : ` << ${offset}`;
      if (field.type.kind === 'bool') {
        const bit = `this.${member} ? 1u : 0u`;
        statements.push(`${local} |= ${offset === 0 ? bit : `(${bit})${shift}`};`);
        continue;
      }
      // An enum has no implicit conversion, and a negative one must still fail the check.
      const value = field.type.kind === 'enum' ? `(ulong)this.${member}` : `this.${member}`;
      statements.push(
        `${local} |= ${this.codec}.CheckBits(${value}, ${field.bits}, ${csharpString(member)})${shift};`,
      );
    }
    const value = type.base === 'u32' ? local : `(${PRIMITIVE_CS[type.base]})${local}`;
    statements.push(`writer.Write${WIRE_NAMES[type.base]}(${value});`);
    return statements;
  }

  private write(type: ElementType, value: string, field: string): string {
    switch (type.kind) {
      case 'primitive':
        return `writer.Write${WIRE_NAMES[type.name]}(${value})`;
      case 'string':
        return `writer.WriteString(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `writer.WriteBytes(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `writer.WriteFixedBytes(${value}, ${type.size}, ${csharpString(field)})`;
      case 'struct':
        return `${value}.WriteTo(writer)`;
      case 'enum': {
        const base = findEnum(this.protocol, type.name).type;
        return `writer.Write${WIRE_NAMES[base]}((${ENUM_BASE_CS[base]})${value})`;
      }
    }
  }

  private readMethod(name: string, fields: Field[]): string {
    const statements = fields.flatMap((field) => {
      const { type } = field;
      if (type.kind === 'bits') return this.readBits(type, `${camelCase(field.name)}Bits`);
      const member = this.member(field as MemberField);
      const target = `result.${member}`;
      if (type.kind === 'array') {
        const count = `${member.charAt(0).toLowerCase()}${member.slice(1)}Count`;
        return [
          `int ${count} = reader.ReadLength(${PRIMITIVE_SIZES[type.length]});`,
          `${target} = ${this.codec}.NewList<${this.csType(type.element)}>(${count}, reader);`,
          `for (int i = 0; i < ${count}; i++)`,
          '{',
          `${INDENT}${target}.Add(${this.read(type.element)});`,
          '}',
        ];
      }
      if (type.kind === 'fixedArray') {
        return [
          `${target} = new List<${this.csType(type.element)}>(${type.size});`,
          `for (int i = 0; i < ${type.size}; i++)`,
          '{',
          `${INDENT}${target}.Add(${this.read(type.element)});`,
          '}',
        ];
      }
      return [`${target} = ${this.read(type)};`];
    });
    return `    /// <summary>Reads a <see cref="${name}"/> starting at the reader's position.</summary>
    public static ${name} ReadFrom(PacketReader reader)
    {
        ${name} result = new ${name}();
${indentLines(statements)}        return result;
    }`;
  }

  private readBits(type: BitsType, local: string): string[] {
    const statements = [`uint ${local} = reader.Read${WIRE_NAMES[type.base]}();`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const target = `result.${this.member(bitMember(field))}`;
      const shifted = offset === 0 ? local : `(${local} >> ${offset})`;
      const bits = `${shifted} & ${hex(2 ** field.bits - 1)}u`;
      if (field.type.kind === 'bool') {
        statements.push(`${target} = (${bits}) != 0;`);
      } else if (field.type.kind === 'enum') {
        statements.push(`${target} = ${this.codec}.BitsTo${field.type.name}(${bits});`);
      } else if (field.bits > 16) {
        statements.push(`${target} = ${bits};`);
      } else {
        const cast = field.bits > 8 ? 'ushort' : 'byte';
        statements.push(`${target} = (${cast})(${bits});`);
      }
    }
    return statements;
  }

  private read(type: ElementType): string {
    switch (type.kind) {
      case 'primitive':
        return `reader.Read${WIRE_NAMES[type.name]}()`;
      case 'string':
        return `reader.ReadString(${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `reader.ReadBytes(${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `reader.ReadFixedBytes(${type.size})`;
      case 'struct':
        return `${type.name}.ReadFrom(reader)`;
      case 'enum':
        return `${this.codec}.Read${type.name}(reader)`;
    }
  }

  private equalsMethods(name: string, fields: MemberField[]): string {
    const comparisons = fields.map((field) => {
      const n = this.member(field);
      const { type } = field;
      if (type.kind === 'primitive' && (type.name === 'f32' || type.name === 'f64')) {
        return `this.${n}.Equals(other.${n})`;
      }
      if (type.kind === 'primitive' || type.kind === 'enum' || type.kind === 'string') {
        return `this.${n} == other.${n}`;
      }
      if (type.kind === 'bytes' || type.kind === 'fixedBytes') {
        return `${this.codec}.BytesEqual(this.${n}, other.${n})`;
      }
      if (type.kind === 'array' || type.kind === 'fixedArray') {
        return `${this.codec}.ListEqual(this.${n}, other.${n})`;
      }
      return `Equals(this.${n}, other.${n})`;
    });
    const expression = ['other is not null', ...comparisons].join('\n            && ');
    return `    public bool Equals(${name}? other)
    {
        if (ReferenceEquals(this, other))
        {
            return true;
        }
        return ${expression};
    }

    public override bool Equals(object? obj)
    {
        return Equals(obj as ${name});
    }`;
  }

  private hashCodeMethod(fields: MemberField[]): string {
    if (fields.length === 0) {
      return `    public override int GetHashCode()
    {
        return 0;
    }`;
    }
    const additions = fields.map((field) => {
      const n = this.member(field);
      const { type } = field;
      if (type.kind === 'bytes' || type.kind === 'fixedBytes') {
        return `hash.Add(${this.codec}.BytesHash(this.${n}));`;
      }
      if (type.kind === 'array' || type.kind === 'fixedArray') {
        return `hash.Add(${this.codec}.ListHash(this.${n}));`;
      }
      return `hash.Add(this.${n});`;
    });
    return `    public override int GetHashCode()
    {
        var hash = new HashCode();
${indentLines(additions)}        return hash.ToHashCode();
    }`;
  }

  private toStringMethod(name: string, fields: MemberField[]): string {
    const parts = fields.map((field, index) => {
      const n = this.member(field);
      const label = csharpString(`${index === 0 ? '' : ', '}${n}=`);
      return `${label} + ${this.codec}.Format(this.${n})`;
    });
    const expression =
      fields.length === 0
        ? csharpString(`${name}{}`)
        : [csharpString(`${name}{`), ...parts, csharpString('}')].join('\n            + ');
    return `    public override string ToString()
    {
        return ${expression};
    }`;
  }

  private csType(type: MemberType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVE_CS[type.name];
      case 'string':
        return 'string';
      case 'bytes':
      case 'fixedBytes':
        return 'byte[]';
      case 'struct':
      case 'enum':
        return type.name;
      case 'array':
      case 'fixedArray':
        return `List<${this.csType(type.element)}>`;
    }
  }

  private defaultValue(type: MemberType): string | undefined {
    switch (type.kind) {
      case 'primitive':
        return undefined;
      case 'string':
        return '""';
      case 'bytes':
        return 'Array.Empty<byte>()';
      case 'fixedBytes':
        return `new byte[${type.size}]`;
      case 'struct':
        return `new ${type.name}()`;
      case 'enum':
        return `${type.name}.${this.enumMembers.get(type.name)![0]}`;
      case 'array':
        return `new List<${this.csType(type.element)}>()`;
      case 'fixedArray': {
        const element = type.element;
        if (element.kind === 'primitive') {
          const cs = PRIMITIVE_CS[element.name];
          return `new List<${cs}>(new ${cs}[${type.size}])`;
        }
        return `${this.codec}.Repeat(${type.size}, () => ${this.defaultValue(element)})`;
      }
    }
  }

  private file(usings: string[], body: string): string {
    const usingLines = [...new Set(usings)].sort().map((name) => `using ${name};`);
    const header = `// <auto-generated>\n// Generated by pktspec from ${this.protocol.name}. Do not edit.\n// </auto-generated>\n#nullable enable\n`;
    const wrapped = body
      .split('\n')
      .map((line) => (line === '' ? line : `${INDENT}${line}`))
      .join('\n');
    return `${header}\n${usingLines.length > 0 ? usingLines.join('\n') + '\n\n' : ''}namespace ${this.csNamespace}\n{\n${wrapped}\n}\n`;
  }
}

/** Indents method body lines; each line ends with a newline so an empty body stays empty. */
function indentLines(lines: string[]): string {
  return lines.map((line) => `${INDENT}${INDENT}${line}\n`).join('');
}

function xmlDoc(text: string | undefined, indent: string, tag = 'summary'): string {
  if (text === undefined) return '';
  const escaped = text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // C# also ends a line at NEL, LS and PS, which would end the comment early.
  const lines = escaped.split(/\r\n|[\r\n\u0085\u2028\u2029]/);
  if (lines.length === 1) return `${indent}/// <${tag}>${lines[0]}</${tag}>\n`;
  const body = lines.map((line) => (line === '' ? `${indent}///` : `${indent}/// ${line}`));
  return `${indent}/// <${tag}>\n${body.join('\n')}\n${indent}/// </${tag}>\n`;
}

function csharpString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
