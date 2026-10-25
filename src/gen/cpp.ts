import {
  PRIMITIVE_SIZES,
  bitEnums,
  bitGroups,
  bitLayout,
  bitMember,
  conditionTarget,
  fieldMembers,
  findEnum,
  findStruct,
  hasConditions,
  memberFields,
  wireSize,
  type BitsType,
  type Condition,
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

export interface CppOptions {
  /** C++ namespace of the generated types; derived from the protocol name when omitted. */
  namespace?: string;
}

const KEYWORDS = new Set(
  (
    'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t ' +
    'char16_t char32_t class compl concept const consteval constexpr constinit const_cast ' +
    'continue co_await co_return co_yield decltype default delete do double dynamic_cast else ' +
    'enum explicit export extern false float for friend goto if inline int long mutable ' +
    'namespace new noexcept not not_eq nullptr operator or or_eq private protected public ' +
    'register reinterpret_cast requires return short signed sizeof static static_assert ' +
    'static_cast struct switch template this thread_local throw true try typedef typeid ' +
    'typename union unsigned using virtual void volatile wchar_t while xor xor_eq'
  ).split(' '),
);

// Lowercase names that platform headers define as macros, which would rewrite a member of that name.
const MACRO_NAMES = ['assert', 'errno', 'far', 'interface', 'linux', 'max', 'min', 'near', 'small'];

// Names the generated files use unqualified, or that would hide one of them inside the namespace.
const RESERVED_TYPE_NAMES = [
  'Packet',
  'PacketErrors',
  'PacketReader',
  'PacketWriter',
  'PacketError',
  'TruncatedPacketError',
  'InvalidPacketError',
  'UnknownOpcodeError',
  'UnknownEnumValueError',
  'PacketRangeError',
  'Structs',
  // Upper-case macros from the C library and the Windows headers.
  'BOOL',
  'DELETE',
  'EOF',
  'ERROR',
  'FALSE',
  'IN',
  'NULL',
  'OPTIONAL',
  'OUT',
  'TRUE',
  'VOID',
];

// Members the generated classes declare themselves.
const RESERVED_MEMBERS = [
  'OpcodeValue',
  'opcode',
  'bodySize',
  'encodedSize',
  'writeTo',
  'readFrom',
  'encode',
  'unix',
  ...MACRO_NAMES,
];

const PRIMITIVE_CPP: Record<PrimitiveType, string> = {
  u8: 'std::uint8_t',
  u16: 'std::uint16_t',
  u32: 'std::uint32_t',
  u64: 'std::uint64_t',
  i8: 'std::int8_t',
  i16: 'std::int16_t',
  i32: 'std::int32_t',
  i64: 'std::int64_t',
  f32: 'float',
  f64: 'double',
  bool: 'bool',
};

const ENUM_BASE_CPP: Record<EnumBaseType, string> = {
  u8: 'std::uint8_t',
  u16: 'std::uint16_t',
  u32: 'std::uint32_t',
  i8: 'std::int8_t',
  i16: 'std::int16_t',
  i32: 'std::int32_t',
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

const CHECK_BITS = `
// Throws PacketRangeError if the value of a bit field does not fit in its bits. The value is
// signed and 64 bits wide so that a negative enum is rejected even in a 32-bit field.
inline std::uint32_t checkBits(std::int64_t value, unsigned bits, const char* field) {
    if (value < 0 || (value >> bits) != 0) {
        throw PacketRangeError(std::string(field) + " out of range for " + std::to_string(bits) +
                               " bits: " + std::to_string(value));
    }
    return static_cast<std::uint32_t>(value);
}
`;

const CHECK_PRESENT = `
// Throws PacketRangeError unless a conditional field holds a value exactly when its condition is true.
template <typename T>
void checkPresent(const std::optional<T>& value, bool present, const char* field) {
    if (present && !value.has_value()) {
        throw PacketRangeError(std::string(field) + " is required by its condition");
    }
    if (!present && value.has_value()) {
        throw PacketRangeError(std::string(field) + " must be empty because its condition is false");
    }
}
`;

const SAME_OPTIONAL = `
template <typename T>
bool same(const std::optional<T>& a, const std::optional<T>& b) {
    return a.has_value() == b.has_value() && (!a.has_value() || same(*a, *b));
}
`;

// Editors treat NEL, LS and PS as line breaks too, so each doc line needs its own comment prefix.
const LINE_BREAKS = new RegExp('\r\n|[\r\n' + String.fromCharCode(0x85, 0x2028, 0x2029) + ']');

export function defaultCppNamespace(protocolName: string): string {
  return pascalCase(protocolName);
}

/** Accepts `A::B` and `A.B`, so the same option works for the C# and C++ targets. */
export function cppNamespaceParts(name: string): string[] {
  return name.split(/::|\./);
}

export function isValidCppNamespace(name: string): boolean {
  return cppNamespaceParts(name).every(
    (part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !KEYWORDS.has(part) && part !== 'std',
  );
}

export function generateCpp(protocol: Protocol, options: CppOptions = {}): GeneratedFile[] {
  const cppNamespace = options.namespace ?? defaultCppNamespace(protocol.name);
  if (!isValidCppNamespace(cppNamespace)) {
    throw new Error(`'${cppNamespace}' is not a valid C++ namespace name`);
  }
  const generator = new CppGenerator(protocol, cppNamespace);
  return generator.files().map(([name, content]) => ({ path: `${name}.hpp`, content }));
}

interface Message {
  /** The class definition, with member functions only declared. */
  declaration: string;
  /** The out-of-line definitions, each marked inline. */
  definitions: string;
}

class CppGenerator {
  private readonly prefix: string;
  private readonly protocolClass: string;
  private readonly memberNames = new Map<MemberField, string>();
  private readonly paramNames = new Map<MemberField, string>();
  private readonly enumMembers = new Map<string, string[]>();

  constructor(
    private readonly protocol: Protocol,
    private readonly cppNamespace: string,
  ) {
    this.prefix = pascalCase(protocol.name);
    this.protocolClass = `${this.prefix}Protocol`;
    // Compared without case because the generated files may land on a case-insensitive file system.
    const reserved = new Set(
      [...RESERVED_TYPE_NAMES, this.protocolClass].map((n) => n.toLowerCase()),
    );
    for (const { name } of [...protocol.enums, ...protocol.structs, ...protocol.packets]) {
      if (reserved.has(name.toLowerCase())) {
        throw new Error(`'${name}' clashes with a name used by the generated C++ code`);
      }
    }
    for (const definition of protocol.enums) {
      const used = new Set<string>();
      this.enumMembers.set(
        definition.name,
        definition.values.map((v) => uniqueName(enumMemberName(v.name), used)),
      );
    }
    for (const { fields: declared } of [...protocol.structs, ...protocol.packets]) {
      const fields = memberFields(declared);
      const used = new Set(RESERVED_MEMBERS);
      for (const field of fields) {
        this.memberNames.set(
          field,
          uniqueName(camelCase(field.name), used, (candidate) => KEYWORDS.has(candidate)),
        );
      }
      // A constructor parameter must not share a name with any member, or the initializer list
      // would read the parameter twice.
      const taken = new Set(fields.map((f) => this.member(f)));
      for (const field of fields) {
        let param = `${this.member(field)}In`;
        while (taken.has(param)) param += 'In';
        taken.add(param);
        this.paramNames.set(field, param);
      }
    }
  }

  files(): [string, string][] {
    const { protocol } = this;
    return [
      ['PacketErrors', this.errorClasses()],
      ['PacketReader', this.readerClass()],
      ['PacketWriter', this.writerClass()],
      ['Packet', this.packetBase()],
      [this.protocolClass, this.protocolEntryPoint()],
      ...protocol.enums.map((e): [string, string] => [e.name, this.enumType(e)]),
      ...(protocol.structs.length > 0
        ? ([['Structs', this.structsFile()]] as [string, string][])
        : []),
      ...protocol.packets.map((p): [string, string] => [p.name, this.packetFile(p)]),
    ];
  }

  private member(field: MemberField): string {
    return this.memberNames.get(field)!;
  }

  private opcodeType(): string {
    return PRIMITIVE_CPP[this.protocol.opcode];
  }

  private errorClasses(): string {
    return this.file(
      ['<cstdint>', '<stdexcept>', '<string>'],
      [],
      `/** Base class of every error the generated code throws. */
class PacketError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/** Thrown when the data ends before the packet does. */
class TruncatedPacketError : public PacketError {
public:
    TruncatedPacketError() : PacketError("The data ends before the packet does.") {}
};

/** Thrown when the data holds an unknown opcode or an invalid value. */
class InvalidPacketError : public PacketError {
public:
    using PacketError::PacketError;
};

/** Thrown when the opcode does not belong to any packet sent in that direction. */
class UnknownOpcodeError : public InvalidPacketError {
public:
    UnknownOpcodeError(const char* sender, std::uint32_t opcode)
        : InvalidPacketError(describe(sender, opcode)), opcode_(opcode) {}

    /** The opcode that was read. */
    std::uint32_t opcode() const { return opcode_; }

private:
    static std::string describe(const char* sender, std::uint32_t opcode) {
        static const char digits[] = "0123456789abcdef";
        std::string text;
        do {
            text.insert(text.begin(), digits[opcode & 0xF]);
            opcode >>= 4;
        } while (opcode != 0);
        return std::string("unknown ") + sender + " opcode: 0x" + text;
    }

    std::uint32_t opcode_;
};

/** Thrown when an enum field holds a value the enum does not define. */
class UnknownEnumValueError : public InvalidPacketError {
public:
    UnknownEnumValueError(const char* enumName, long long value)
        : InvalidPacketError(std::string("unknown ") + enumName + " value: " + std::to_string(value)) {}
};

/** Thrown when writing a value that does not fit the wire format, such as a too long string. */
class PacketRangeError : public PacketError {
public:
    using PacketError::PacketError;
};`,
    );
  }

  private readerClass(): string {
    const little = this.protocol.endian === 'little';
    const accumulate = little
      ? 'value |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);'
      : 'value = (value << 8) | bytes[i];';
    const unsigned = (type: PrimitiveType): string =>
      `    ${PRIMITIVE_CPP[type]} read${WIRE_NAMES[type]}() {
        return static_cast<${PRIMITIVE_CPP[type]}>(readUnsigned<${PRIMITIVE_SIZES[type]}>());
    }`;
    const signed = (type: PrimitiveType): string =>
      `    ${PRIMITIVE_CPP[type]} read${WIRE_NAMES[type]}() {
        return toSigned<${PRIMITIVE_CPP[type]}>(readUnsigned<${PRIMITIVE_SIZES[type]}>());
    }`;
    return this.file(
      [
        '<array>',
        '<cstddef>',
        '<cstdint>',
        '<cstring>',
        '<limits>',
        '<string>',
        '<type_traits>',
        '<vector>',
      ],
      ['PacketErrors.hpp'],
      `static_assert(
    sizeof(float) == 4 && sizeof(double) == 8 && std::numeric_limits<float>::is_iec559 &&
        std::numeric_limits<double>::is_iec559,
    "The generated code needs IEEE 754 floating point numbers");

/**
 * Reads packet values from a buffer, in the byte order of the ${this.protocol.name} protocol.
 *
 * The reader does not own the buffer, which must outlive it.
 */
class PacketReader {
public:
    PacketReader(const std::uint8_t* data, std::size_t size) : data_(data), size_(size) {}

    explicit PacketReader(const std::vector<std::uint8_t>& data)
        : data_(data.data()), size_(data.size()) {}

    /** Number of bytes read so far. */
    std::size_t position() const { return position_; }

    /** Number of bytes left to read. */
    std::size_t remaining() const { return size_ - position_; }

    std::uint8_t readU8() { return *take(1); }

${unsigned('u16')}

${unsigned('u32')}

${unsigned('u64')}

    std::int8_t readI8() { return toSigned<std::int8_t>(*take(1)); }

${signed('i16')}

${signed('i32')}

${signed('i64')}

    float readF32() {
        const std::uint32_t bits = readU32();
        float value;
        std::memcpy(&value, &bits, sizeof value);
        return value;
    }

    double readF64() {
        const std::uint64_t bits = readU64();
        double value;
        std::memcpy(&value, &bits, sizeof value);
        return value;
    }

    bool readBool() { return *take(1) != 0; }

    /** Reads a length or count prefix of 1, 2 or 4 bytes. */
    std::size_t readLength(unsigned prefixSize) {
        std::uint32_t length;
        switch (prefixSize) {
            case 1:
                length = readU8();
                break;
            case 2:
                length = readU16();
                break;
            default:
                length = readU32();
                break;
        }
        if (length > 0x7fffffffu) {
            throw InvalidPacketError("length too large: " + std::to_string(length));
        }
        return static_cast<std::size_t>(length);
    }

    /** The bytes are copied as they are; they are not checked to be valid UTF-8. */
    std::string readString(unsigned prefixSize) {
        const std::size_t length = readLength(prefixSize);
        const std::uint8_t* bytes = take(length);
        if (length == 0) {
            return std::string();
        }
        return std::string(reinterpret_cast<const char*>(bytes), length);
    }

    std::vector<std::uint8_t> readBytes(unsigned prefixSize) {
        const std::size_t length = readLength(prefixSize);
        // The range is checked before allocating so a corrupt prefix cannot request a huge array.
        const std::uint8_t* bytes = take(length);
        if (length == 0) {
            return std::vector<std::uint8_t>();
        }
        return std::vector<std::uint8_t>(bytes, bytes + length);
    }

    template <std::size_t N>
    std::array<std::uint8_t, N> readFixedBytes() {
        const std::uint8_t* bytes = take(N);
        std::array<std::uint8_t, N> result{};
        for (std::size_t i = 0; i < N; ++i) {
            result[i] = bytes[i];
        }
        return result;
    }

    /** Reserves room for a count read from the wire, without trusting it for the capacity. */
    template <typename T>
    void reserveFor(std::vector<T>& list, std::size_t count) const {
        list.reserve(count < remaining() ? count : remaining());
    }

private:
    const std::uint8_t* take(std::size_t count) {
        if (count > size_ - position_) {
            throw TruncatedPacketError();
        }
        const std::uint8_t* start = data_ + position_;
        position_ += count;
        return start;
    }

    template <std::size_t N>
    std::uint64_t readUnsigned() {
        const std::uint8_t* bytes = take(N);
        std::uint64_t value = 0;
        for (std::size_t i = 0; i < N; ++i) {
            ${accumulate}
        }
        return value;
    }

    // Spelled out so that no value depends on how the compiler converts out-of-range integers.
    template <typename S>
    static S toSigned(std::uint64_t bits) {
        using U = std::make_unsigned_t<S>;
        const U value = static_cast<U>(bits);
        if (value <= static_cast<U>((std::numeric_limits<S>::max)())) {
            return static_cast<S>(value);
        }
        return static_cast<S>(-static_cast<std::int64_t>(static_cast<U>(~value)) - 1);
    }

    const std::uint8_t* data_;
    std::size_t size_;
    std::size_t position_ = 0;
};`,
    );
  }

  private writerClass(): string {
    const little = this.protocol.endian === 'little';
    const shift = little ? '8 * i' : '8 * (N - 1 - i)';
    const unsigned = (type: PrimitiveType): string =>
      `    void write${WIRE_NAMES[type]}(${PRIMITIVE_CPP[type]} value) { writeUnsigned<${PRIMITIVE_SIZES[type]}>(value); }`;
    const signed = (type: PrimitiveType, unsignedType: PrimitiveType): string =>
      `    void write${WIRE_NAMES[type]}(${PRIMITIVE_CPP[type]} value) {
        writeUnsigned<${PRIMITIVE_SIZES[type]}>(static_cast<${PRIMITIVE_CPP[unsignedType]}>(value));
    }`;
    return this.file(
      ['<array>', '<cstddef>', '<cstdint>', '<cstring>', '<limits>', '<string>', '<vector>'],
      ['PacketErrors.hpp'],
      `/** Writes packet values into a growing buffer, in the byte order of the ${this.protocol.name} protocol. */
class PacketWriter {
public:
    /** Creates a writer with room for \`capacity\` bytes; it grows when more are written. */
    explicit PacketWriter(std::size_t capacity = 0) { bytes_.reserve(capacity); }

    /** Number of bytes written so far. */
    std::size_t position() const { return bytes_.size(); }

    /** The bytes written so far. */
    const std::vector<std::uint8_t>& bytes() const { return bytes_; }

    /** Returns the bytes written so far and leaves the writer empty. */
    std::vector<std::uint8_t> release() {
        std::vector<std::uint8_t> result;
        result.swap(bytes_);
        return result;
    }

    void writeU8(std::uint8_t value) { bytes_.push_back(value); }

${unsigned('u16')}

${unsigned('u32')}

${unsigned('u64')}

    void writeI8(std::int8_t value) { bytes_.push_back(static_cast<std::uint8_t>(value)); }

${signed('i16', 'u16')}

${signed('i32', 'u32')}

${signed('i64', 'u64')}

    void writeF32(float value) {
        std::uint32_t bits;
        std::memcpy(&bits, &value, sizeof bits);
        writeU32(bits);
    }

    void writeF64(double value) {
        std::uint64_t bits;
        std::memcpy(&bits, &value, sizeof bits);
        writeU64(bits);
    }

    void writeBool(bool value) { bytes_.push_back(value ? 1 : 0); }

    /**
     * Writes a length or count prefix of 1, 2 or 4 bytes.
     * Throws PacketRangeError if the length does not fit in the prefix.
     */
    void writeLength(std::size_t length, unsigned prefixSize) {
        const std::uint64_t max =
            prefixSize == 4 ? 0xffffffffu : (std::uint64_t{1} << (8 * prefixSize)) - 1;
        if (static_cast<std::uint64_t>(length) > max) {
            throw PacketRangeError("length " + std::to_string(length) + " does not fit in a " +
                                   std::to_string(prefixSize) + "-byte prefix");
        }
        switch (prefixSize) {
            case 1:
                writeU8(static_cast<std::uint8_t>(length));
                break;
            case 2:
                writeU16(static_cast<std::uint16_t>(length));
                break;
            default:
                writeU32(static_cast<std::uint32_t>(length));
                break;
        }
    }

    void writeString(const std::string& value, unsigned prefixSize) {
        writeLength(value.size(), prefixSize);
        for (char c : value) {
            bytes_.push_back(static_cast<std::uint8_t>(c));
        }
    }

    void writeBytes(const std::vector<std::uint8_t>& value, unsigned prefixSize) {
        writeLength(value.size(), prefixSize);
        bytes_.insert(bytes_.end(), value.begin(), value.end());
    }

    template <std::size_t N>
    void writeFixedBytes(const std::array<std::uint8_t, N>& value) {
        bytes_.insert(bytes_.end(), value.begin(), value.end());
    }

private:
    template <std::size_t N>
    void writeUnsigned(std::uint64_t value) {
        for (std::size_t i = 0; i < N; ++i) {
            bytes_.push_back(static_cast<std::uint8_t>((value >> (${shift})) & 0xff));
        }
    }

    std::vector<std::uint8_t> bytes_;
};`,
    );
  }

  private packetBase(): string {
    const opcodeSize = PRIMITIVE_SIZES[this.protocol.opcode];
    const opcodeMethod = WIRE_NAMES[this.protocol.opcode];
    const bits = bitGroups(this.protocol).length > 0;
    const conditions = hasConditions(this.protocol);
    const standard = [
      '<array>',
      '<cstddef>',
      '<cstdint>',
      ...(conditions ? ['<optional>'] : []),
      ...(bits || conditions ? ['<string>'] : []),
      '<vector>',
    ];
    return this.file(
      standard,
      ['PacketErrors.hpp', 'PacketReader.hpp', 'PacketWriter.hpp'],
      `namespace detail {
${bits ? CHECK_BITS : ''}${conditions ? CHECK_PRESENT : ''}
// Equality that treats two NaN values as equal, so a decoded packet equals the one that was sent.
template <typename T>
bool same(const T& a, const T& b) {
    return a == b;
}

inline bool same(float a, float b) {
    return a == b || (a != a && b != b);
}

inline bool same(double a, double b) {
    return a == b || (a != a && b != b);
}

template <typename T>
bool same(const std::vector<T>& a, const std::vector<T>& b) {
    if (a.size() != b.size()) {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (!same(a[i], b[i])) {
            return false;
        }
    }
    return true;
}

template <typename T, std::size_t N>
bool same(const std::array<T, N>& a, const std::array<T, N>& b) {
    for (std::size_t i = 0; i < N; ++i) {
        if (!same(a[i], b[i])) {
            return false;
        }
    }
    return true;
}
${conditions ? SAME_OPTIONAL : ''}
template <std::size_t N, typename T>
std::array<T, N> filled(const T& value) {
    std::array<T, N> result{};
    for (std::size_t i = 0; i < N; ++i) {
        result[i] = value;
    }
    return result;
}

}  // namespace detail

/**
 * A packet of the ${this.protocol.name} protocol.
 *
 * Decoding returns a pointer to this type; check opcode() and cast to the packet class.
 */
class Packet {
public:
    virtual ~Packet() = default;

    /** The opcode that identifies this packet on the wire. */
    virtual ${this.opcodeType()} opcode() const = 0;

    /** Number of bytes writeTo writes. The opcode is not included. */
    virtual std::size_t bodySize() const = 0;

    /** Writes the packet body, without the opcode. */
    virtual void writeTo(PacketWriter& writer) const = 0;

    /** Returns the opcode followed by the body. */
    std::vector<std::uint8_t> encode() const {
        PacketWriter writer(${opcodeSize} + bodySize());
        writer.write${opcodeMethod}(opcode());
        writeTo(writer);
        return writer.release();
    }

protected:
    Packet() = default;
    Packet(const Packet&) = default;
    Packet(Packet&&) = default;
    Packet& operator=(const Packet&) = default;
    Packet& operator=(Packet&&) = default;
};`,
    );
  }

  private protocolEntryPoint(): string {
    const { protocol } = this;
    const opcodeMethod = WIRE_NAMES[protocol.opcode];
    const version =
      protocol.version === undefined
        ? ''
        : `\n    static constexpr const char* ProtocolVersion = ${cppString(protocol.version)};`;
    const decoder = (direction: 'c2s' | 's2c', method: string, sender: string): string => {
      const cases = protocol.packets
        .filter((p) => p.direction === direction)
        .map(
          (p) =>
            `            case ${p.name}::OpcodeValue:\n                return std::make_unique<${p.name}>(${p.name}::readFrom(reader));`,
        );
      const unknown = `throw UnknownOpcodeError("${sender}", opcode);`;
      // A switch with only a default label draws a warning from some compilers.
      const dispatch =
        cases.length === 0
          ? `        ${unknown}`
          : `        switch (opcode) {\n${cases.join('\n')}\n            default:\n                ${unknown}\n        }`;
      return `    /**
     * Decodes a packet sent by the ${sender}, starting at the reader's position.
     * Bytes after the packet are left unread.
     *
     * Throws UnknownOpcodeError, UnknownEnumValueError or InvalidPacketError if the data is
     * invalid, and TruncatedPacketError if it ends too early.
     */
    static std::unique_ptr<Packet> ${method}(PacketReader& reader) {
        const ${this.opcodeType()} opcode = reader.read${opcodeMethod}();
${dispatch}
    }

    static std::unique_ptr<Packet> ${method}(const std::uint8_t* data, std::size_t size) {
        PacketReader reader(data, size);
        return ${method}(reader);
    }

    static std::unique_ptr<Packet> ${method}(const std::vector<std::uint8_t>& data) {
        PacketReader reader(data);
        return ${method}(reader);
    }`;
    };
    const includes = protocol.packets.map((p) => `${p.name}.hpp`).sort();
    return this.file(
      ['<cstddef>', '<cstdint>', '<memory>', '<vector>'],
      ['Packet.hpp', 'PacketReader.hpp', ...includes],
      `${cppDoc(protocol.doc, '')}struct ${this.protocolClass} final {
    static constexpr const char* ProtocolName = ${cppString(protocol.name)};${version}

    ${this.protocolClass}() = delete;

    /** Encodes the opcode followed by the packet body. */
    static std::vector<std::uint8_t> encode(const Packet& packet) { return packet.encode(); }

${decoder('c2s', 'decodeFromClient', 'client')}

${decoder('s2c', 'decodeFromServer', 'server')}
};`,
    );
  }

  private enumType(definition: Enum): string {
    const names = this.enumMembers.get(definition.name)!;
    const base = ENUM_BASE_CPP[definition.type];
    const members = definition.values
      .map((v, i) => `${INDENT}${names[i]} = ${intLiteral(v.value, definition.type)},`)
      .join('\n');
    const values = [...new Set(definition.values.map((v) => v.value))];
    const cases = values
      .map((v) => `${INDENT}${INDENT}case ${intLiteral(v, definition.type)}:`)
      .join('\n');
    const bitCases = values.map((v) => `${INDENT}${INDENT}case ${v}u:`).join('\n');
    const fromBits = bitEnums(this.protocol).has(definition.name)
      ? `

/** Checks a value taken from a bit field, throwing UnknownEnumValueError if ${definition.name} does not define it. */
inline ${definition.name} bitsTo${definition.name}(std::uint32_t value) {
    switch (value) {
${bitCases}
            return static_cast<${definition.name}>(value);
        default:
            throw UnknownEnumValueError("${definition.name}", value);
    }
}`
      : '';
    return this.file(
      ['<cstdint>'],
      ['PacketReader.hpp'],
      `${cppDoc(definition.doc, '')}enum class ${definition.name} : ${base} {
${members}
};

/** Reads a ${definition.name}, throwing UnknownEnumValueError for a value the enum does not define. */
inline ${definition.name} read${definition.name}(PacketReader& reader) {
    const ${base} value = reader.read${WIRE_NAMES[definition.type]}();
    switch (value) {
${cases}
            return static_cast<${definition.name}>(value);
        default:
            throw UnknownEnumValueError("${definition.name}", value);
    }
}${fromBits}`,
    );
  }

  // All structs share one file because two structs may hold arrays of each other, which no
  // include order can satisfy when every type has its own header.
  private structsFile(): string {
    const { structs } = this.protocol;
    const ordered = this.orderStructs();
    const messages = new Map(ordered.map((s) => [s.name, this.message(s.name, s.doc, s.fields)]));
    const forward = structs.map((s) => `struct ${s.name};`).join('\n');
    const declarations = ordered.map((s) => messages.get(s.name)!.declaration).join('\n\n');
    const definitions = ordered.map((s) => messages.get(s.name)!.definitions).join('\n\n');
    const deps = [
      'Packet.hpp',
      ...this.dependencies(structs.flatMap((s) => s.fields)).filter(
        (header) => header !== 'Structs.hpp',
      ),
    ];
    return this.file([], deps, `${forward}\n\n${declarations}\n\n${definitions}`, (body) =>
      this.standardIncludes(body),
    );
  }

  // A struct needs the complete type of every struct it holds directly or in a fixed array;
  // arrays with a length prefix only need the name to be declared.
  private orderStructs(): Struct[] {
    const result: Struct[] = [];
    const done = new Set<string>();
    const visit = (struct: Struct): void => {
      if (done.has(struct.name)) return;
      done.add(struct.name);
      for (const { type } of struct.fields) {
        const held =
          type.kind === 'struct'
            ? type.name
            : type.kind === 'fixedArray' && type.element.kind === 'struct'
              ? type.element.name
              : undefined;
        if (held !== undefined) visit(findStruct(this.protocol, held));
      }
      result.push(struct);
    };
    this.protocol.structs.forEach(visit);
    return result;
  }

  private packetFile(packet: Packet): string {
    const { declaration, definitions } = this.message(
      packet.name,
      packet.doc,
      packet.fields,
      packet,
    );
    return this.file(
      [],
      ['Packet.hpp', ...this.dependencies(packet.fields)],
      `${declaration}\n\n${definitions}`,
      (body) => this.standardIncludes(body),
    );
  }

  /** Headers that declare the structs and enums the fields use. */
  private dependencies(fields: Field[]): string[] {
    const headers = new Set<string>();
    const visit = (type: ElementType): void => {
      if (type.kind === 'struct') headers.add('Structs.hpp');
      if (type.kind === 'enum') headers.add(`${type.name}.hpp`);
    };
    for (const { type } of memberFields(fields)) {
      visit(type.kind === 'array' || type.kind === 'fixedArray' ? type.element : type);
    }
    return [...headers];
  }

  private standardIncludes(body: string): string[] {
    const found: string[] = [];
    const uses: [RegExp, string][] = [
      [/std::size_t/, '<cstddef>'],
      [/std::u?int\d+_t/, '<cstdint>'],
      [/std::string/, '<string>'],
      [/std::vector/, '<vector>'],
      [/std::array/, '<array>'],
      [/std::optional/, '<optional>'],
      [/std::move/, '<utility>'],
    ];
    for (const [pattern, header] of uses) {
      if (pattern.test(body)) found.push(header);
    }
    return found;
  }

  private message(
    name: string,
    doc: string | undefined,
    fields: Field[],
    packet?: Packet,
  ): Message {
    const members: string[] = [];
    const opcodeDigits = this.protocol.opcode === 'u8' ? 2 : 4;
    const exposed = memberFields(fields);
    if (packet) {
      members.push(
        `${INDENT}static constexpr ${this.opcodeType()} OpcodeValue = ${hex(packet.opcode, opcodeDigits)};`,
      );
    }
    if (exposed.length > 0) {
      members.push(
        exposed
          .map((field) => {
            const declaration = `${this.memberType(field)} ${this.member(field)}`;
            // A conditional field starts empty, as it is while its condition is false.
            const initialized = field.condition
              ? `${declaration}{}`
              : this.initializer(declaration, field.type);
            return cppDoc(field.doc, INDENT) + `${INDENT}${initialized};`;
          })
          .join('\n'),
      );
    }
    const params = exposed.map((f) => `${this.memberType(f)} ${this.paramNames.get(f)!}`);
    const constructors = [`${INDENT}${name}() = default;`];
    if (exposed.length > 0) {
      const explicit = exposed.length === 1 ? 'explicit ' : '';
      const signature = `${INDENT}${explicit}${name}(${params.join(', ')});`;
      constructors.push(
        signature.length <= 100
          ? signature
          : `${INDENT}${explicit}${name}(\n${params.map((p) => `${INDENT}${INDENT}${p}`).join(',\n')});`,
      );
    }
    members.push(constructors.join('\n'));
    const override = packet ? ' override' : '';
    if (packet) {
      members.push(`${INDENT}${this.opcodeType()} opcode() const override { return OpcodeValue; }`);
    }
    const sizeName = packet ? 'bodySize' : 'encodedSize';
    members.push(
      packet
        ? `${INDENT}std::size_t ${sizeName}() const${override};`
        : `${INDENT}/** Number of bytes writeTo writes. */\n${INDENT}std::size_t ${sizeName}() const;`,
    );
    members.push(
      `${INDENT}${packet ? '' : '/** Writes this struct. */\n' + INDENT}void writeTo(PacketWriter& writer_) const${override};`,
    );
    members.push(
      `${INDENT}/** Reads a ${name} starting at the reader's position. */\n${INDENT}static ${name} readFrom(PacketReader& reader);`,
    );
    members.push(
      `${INDENT}bool operator==(const ${name}& other_) const;\n${INDENT}bool operator!=(const ${name}& other_) const { return !(*this == other_); }`,
    );

    const direction = packet?.direction === 'c2s' ? 'client to server' : 'server to client';
    const opcodeDoc = packet
      ? `Opcode ${hex(packet.opcode, opcodeDigits)}, sent from ${direction}.`
      : undefined;
    const classDoc =
      doc !== undefined && opcodeDoc !== undefined ? `${doc}\n\n${opcodeDoc}` : (doc ?? opcodeDoc);
    const bases = packet ? ' final : public Packet' : '';
    const declaration = `${cppDoc(classDoc, '')}struct ${name}${bases} {\n${members.join('\n\n')}\n};`;

    const definitions = [
      ...(exposed.length > 0 ? [this.constructorDefinition(name, exposed, params)] : []),
      this.sizeDefinition(name, sizeName, fields),
      this.writeDefinition(name, fields),
      this.readDefinition(name, fields),
      this.equalsDefinition(name, exposed),
    ];
    return { declaration, definitions: definitions.join('\n\n') };
  }

  private constructorDefinition(name: string, fields: MemberField[], params: string[]): string {
    const initializers = fields.map((field) => {
      const argument = this.paramNames.get(field)!;
      const { type } = field;
      const value =
        type.kind === 'primitive' || type.kind === 'enum' ? argument : `std::move(${argument})`;
      return `${this.member(field)}(${value})`;
    });
    const signature = `inline ${name}::${name}(${params.join(', ')})`;
    const wrapped =
      signature.length <= 100
        ? signature
        : `inline ${name}::${name}(\n${params.map((p) => `${INDENT}${INDENT}${p}`).join(',\n')})`;
    const oneLine = `${INDENT}: ${initializers.join(', ')} {}`;
    const list =
      oneLine.length <= 100 ? oneLine : `${INDENT}: ${initializers.join(`,\n${INDENT}  `)} {}`;
    return `${wrapped}\n${list}`;
  }

  private sizeDefinition(name: string, method: string, fields: Field[]): string {
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
      const presence = `this->${this.member(fieldMembers(field)[0]!)}`;
      const inner = [...(size.fixed > 0 ? [`size_ += ${size.fixed};`] : []), ...size.statements];
      statements.push(
        `if (${presence}.has_value()) {`,
        ...inner.map((line) => `${INDENT}${line}`),
        '}',
      );
    }
    const body =
      statements.length === 0
        ? indentLines([`return ${fixed};`])
        : indentLines([`std::size_t size_ = ${fixed};`, ...statements, 'return size_;']);
    return `inline std::size_t ${name}::${method}() const {\n${body}}`;
  }

  private fieldSize(field: Field): { fixed: number; statements: string[] } {
    const { type } = field;
    const size = wireSize(type, this.protocol);
    if (size.fixed) return { fixed: size.min, statements: [] };
    const value = this.value(field as MemberField);
    if (type.kind !== 'array' && type.kind !== 'fixedArray') {
      return { fixed: 0, statements: [`size_ += ${this.variableSize(type, value)};`] };
    }
    const element = wireSize(type.element, this.protocol);
    const fixed = type.kind === 'array' ? PRIMITIVE_SIZES[type.length] : 0;
    if (element.fixed) {
      const count = `${value}.size()`;
      return {
        fixed,
        statements: [`size_ += ${element.min === 1 ? count : `${count} * ${element.min}`};`],
      };
    }
    return {
      fixed,
      statements: [
        `for (const auto& item_ : ${value}) {`,
        `${INDENT}size_ += ${this.variableSize(type.element, 'item_')};`,
        '}',
      ],
    };
  }

  /** The member as its plain type; a conditional one is only read once it is known to be set. */
  private value(field: MemberField, owner = 'this->'): string {
    const value = `${owner}${this.member(field)}`;
    if (!field.condition) return value;
    const { kind } = field.type;
    return kind === 'primitive' || kind === 'enum' || kind === 'fixedBytes'
      ? `*${value}`
      : `(*${value})`;
  }

  private variableSize(type: FieldType, value: string): string {
    switch (type.kind) {
      case 'string':
      case 'bytes':
        return `${PRIMITIVE_SIZES[type.length]} + ${value}.size()`;
      case 'struct':
        return `${value}.encodedSize()`;
      default:
        return String(wireSize(type, this.protocol).min);
    }
  }

  // Locals and parameters of the generated functions end in an underscore, which a member only
  // does after clashing with a keyword or reserved name, so they never shadow one (-Wshadow).
  private writeDefinition(name: string, fields: Field[]): string {
    const statements = fields.flatMap((field) => {
      const body = this.writeField(field);
      if (!field.condition) return body;
      const present = `${camelCase(field.name)}Present_`;
      const checks = fieldMembers(field).map((member) => {
        const name = this.member(member);
        return `detail::checkPresent(this->${name}, ${present}, ${cppString(name)});`;
      });
      return [
        `const bool ${present} = ${this.condition(fields, field.condition, 'this->')};`,
        ...checks,
        `if (${present}) {`,
        ...body.map((line) => `${INDENT}${line}`),
        '}',
      ];
    });
    const parameter = fields.length === 0 ? 'PacketWriter&' : 'PacketWriter& writer_';
    return `inline void ${name}::writeTo(${parameter}) const {\n${indentLines(statements)}}`;
  }

  private writeField(field: Field): string[] {
    const { type } = field;
    if (type.kind === 'bits') return this.writeBits(field, type, `${camelCase(field.name)}Bits_`);
    const value = this.value(field as MemberField);
    if (type.kind !== 'array' && type.kind !== 'fixedArray') {
      return [`${this.write(type, value)};`];
    }
    return [
      ...(type.kind === 'array'
        ? [`writer_.writeLength(${value}.size(), ${PRIMITIVE_SIZES[type.length]});`]
        : []),
      `for (const auto& item_ : ${value}) {`,
      `${INDENT}${this.write(type.element, 'item_')};`,
      '}',
    ];
  }

  private writeBits(group: Field, type: BitsType, local: string): string[] {
    const statements = [`std::uint32_t ${local} = 0;`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const member = bitMember(field, group.condition);
      const name = this.member(member);
      const shift = offset === 0 ? '' : ` << ${offset}`;
      if (field.type.kind === 'bool') {
        const bit = `${this.value(member)} ? 1u : 0u`;
        statements.push(`${local} |= ${offset === 0 ? bit : `(${bit})${shift}`};`);
        continue;
      }
      const value =
        field.type.kind === 'enum'
          ? `static_cast<std::int64_t>(${this.value(member)})`
          : this.value(member);
      statements.push(
        `${local} |= detail::checkBits(${value}, ${field.bits}, ${cppString(name)})${shift};`,
      );
    }
    const value =
      type.base === 'u32' ? local : `static_cast<${PRIMITIVE_CPP[type.base]}>(${local})`;
    statements.push(`writer_.write${WIRE_NAMES[type.base]}(${value});`);
    return statements;
  }

  private write(type: ElementType, value: string): string {
    switch (type.kind) {
      case 'primitive':
        return `writer_.write${WIRE_NAMES[type.name]}(${value})`;
      case 'string':
        return `writer_.writeString(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'bytes':
        return `writer_.writeBytes(${value}, ${PRIMITIVE_SIZES[type.length]})`;
      case 'fixedBytes':
        return `writer_.writeFixedBytes(${value})`;
      case 'struct':
        return `${value}.writeTo(writer_)`;
      case 'enum': {
        const base = findEnum(this.protocol, type.name).type;
        return `writer_.write${WIRE_NAMES[base]}(static_cast<${ENUM_BASE_CPP[base]}>(${value}))`;
      }
    }
  }

  private readDefinition(name: string, fields: Field[]): string {
    if (fields.length === 0) {
      return `inline ${name} ${name}::readFrom(PacketReader&) {\n${INDENT}return ${name}();\n}`;
    }
    const statements = fields.flatMap((field) => {
      const body = this.readField(field);
      if (!field.condition) return body;
      return [
        `if (${this.condition(fields, field.condition, 'result.')}) {`,
        ...body.map((line) => `${INDENT}${line}`),
        '}',
      ];
    });
    return `inline ${name} ${name}::readFrom(PacketReader& reader) {
${INDENT}${name} result;
${indentLines(statements)}${INDENT}return result;
}`;
  }

  private readField(field: Field): string[] {
    const { type } = field;
    if (type.kind === 'bits') return this.readBits(field, type, `${camelCase(field.name)}Bits_`);
    const member = this.member(field as MemberField);
    // An array is filled in place, so a conditional one is given its value first.
    const array = type.kind === 'array' || type.kind === 'fixedArray';
    const start = field.condition && array ? [`result.${member}.emplace();`] : [];
    const target = this.value(field as MemberField, 'result.');
    if (type.kind === 'array') {
      const count = `${member}Count_`;
      return [
        `const std::size_t ${count} = reader.readLength(${PRIMITIVE_SIZES[type.length]});`,
        ...start,
        `reader.reserveFor(${target}, ${count});`,
        `for (std::size_t i = 0; i < ${count}; ++i) {`,
        `${INDENT}${target}.push_back(${this.read(type.element)});`,
        '}',
      ];
    }
    if (type.kind === 'fixedArray') {
      return [
        ...start,
        `for (auto& item_ : ${target}) {`,
        `${INDENT}item_ = ${this.read(type.element)};`,
        '}',
      ];
    }
    return [`result.${member} = ${this.read(type)};`];
  }

  /** Tests a condition on `owner`; a target that is itself empty never matches. */
  private condition(fields: Field[], condition: Condition, owner: string): string {
    const target = conditionTarget(fields, condition);
    const value = `${owner}${this.member(target)}`;
    if (condition.kind === 'true') return target.condition ? `${value} == true` : value;
    // Comparing an empty std::optional with a value gives false.
    return condition.values.map((v) => `${value} == ${this.literal(target.type, v)}`).join(' || ');
  }

  private literal(type: MemberType, value: number): string {
    if (type.kind === 'enum') {
      const { values } = findEnum(this.protocol, type.name);
      const index = values.findIndex((v) => v.value === value);
      return `${type.name}::${this.enumMembers.get(type.name)![index]}`;
    }
    if (type.kind === 'primitive' && (type.name === 'u32' || type.name === 'u64')) {
      return `${value}u`;
    }
    return intLiteral(value, 'i32');
  }

  private readBits(group: Field, type: BitsType, local: string): string[] {
    const statements = [`const std::uint32_t ${local} = reader.read${WIRE_NAMES[type.base]}();`];
    for (const { field, offset } of bitLayout(type.fields)) {
      const target = `result.${this.member(bitMember(field, group.condition))}`;
      const shifted = offset === 0 ? local : `(${local} >> ${offset})`;
      const bits = `${shifted} & ${hex(2 ** field.bits - 1)}u`;
      if (field.type.kind === 'bool') {
        statements.push(`${target} = (${bits}) != 0;`);
      } else if (field.type.kind === 'enum') {
        statements.push(`${target} = bitsTo${field.type.name}(${bits});`);
      } else if (field.bits > 16) {
        statements.push(`${target} = ${bits};`);
      } else {
        const cast = PRIMITIVE_CPP[field.bits > 8 ? 'u16' : 'u8'];
        statements.push(`${target} = static_cast<${cast}>(${bits});`);
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
        return `reader.readFixedBytes<${type.size}>()`;
      case 'struct':
        return `${type.name}::readFrom(reader)`;
      case 'enum':
        return `read${type.name}(reader)`;
    }
  }

  private equalsDefinition(name: string, fields: MemberField[]): string {
    if (fields.length === 0) {
      return `inline bool ${name}::operator==(const ${name}&) const {\n${INDENT}return true;\n}`;
    }
    const comparisons = fields.map((field) => {
      const n = this.member(field);
      const { type } = field;
      const floating = type.kind === 'primitive' && (type.name === 'f32' || type.name === 'f64');
      if (floating || type.kind === 'array' || type.kind === 'fixedArray') {
        return `detail::same(this->${n}, other_.${n})`;
      }
      return `this->${n} == other_.${n}`;
    });
    return `inline bool ${name}::operator==(const ${name}& other_) const {
${INDENT}return ${comparisons.join(`\n${INDENT}${INDENT}&& `)};
}`;
  }

  /** The declared type of a member; a conditional one is a std::optional. */
  private memberType(field: MemberField): string {
    const type = this.cppType(field.type);
    return field.condition ? `std::optional<${type}>` : type;
  }

  private cppType(type: MemberType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVE_CPP[type.name];
      case 'string':
        return 'std::string';
      case 'bytes':
        return 'std::vector<std::uint8_t>';
      case 'fixedBytes':
        return `std::array<std::uint8_t, ${type.size}>`;
      case 'struct':
      case 'enum':
        return type.name;
      case 'array':
        return `std::vector<${this.cppType(type.element)}>`;
      case 'fixedArray':
        return `std::array<${this.cppType(type.element)}, ${type.size}>`;
    }
  }

  // Value-initialization gives zero, which an enum may not define, so enums start at their first value.
  private initializer(declaration: string, type: MemberType): string {
    if (type.kind === 'enum') {
      return `${declaration}{${type.name}::${this.enumMembers.get(type.name)![0]}}`;
    }
    if (type.kind === 'fixedArray' && type.element.kind === 'enum') {
      const first = this.enumMembers.get(type.element.name)![0];
      return `${declaration} = detail::filled<${type.size}>(${type.element.name}::${first})`;
    }
    return `${declaration}{}`;
  }

  private file(
    standard: string[],
    local: string[],
    body: string,
    scan?: (body: string) => string[],
  ): string {
    const headers = [...new Set([...standard, ...(scan ? scan(body) : [])])].sort();
    const includes = [...headers.map((h) => `#include ${h.startsWith('<') ? h : `<${h}>`}`)].join(
      '\n',
    );
    const locals = [...new Set(local)].sort().map((h) => `#include "${h}"`);
    const lines = [
      `// Generated by pktspec from ${this.protocol.name}. Do not edit.`,
      '#pragma once',
      '',
      ...(includes ? [includes] : []),
      ...(locals.length > 0 ? [...(includes ? [''] : []), locals.join('\n')] : []),
    ];
    const namespace = cppNamespaceParts(this.cppNamespace).join('::');
    return `${lines.join('\n')}\n\nnamespace ${namespace} {\n\n${body}\n\n}  // namespace ${namespace}\n`;
  }
}

function intLiteral(value: number, type: EnumBaseType): string {
  if (type === 'u32') return `${value}u`;
  // The literal 2147483648 does not fit in an int, so the minimum is built from its neighbour.
  if (type === 'i32' && value === -0x80000000) return '(-2147483647 - 1)';
  return String(value);
}

/** Indents method body lines; each line ends with a newline so an empty body stays empty. */
function indentLines(lines: string[]): string {
  return lines.map((line) => `${INDENT}${line}\n`).join('');
}

/** Replaces every character a compiler with a legacy source code page could misread. */
function asciiOnly(text: string): string {
  return text.replace(/[^ -~]/gu, (c) => {
    const code = c.codePointAt(0)!;
    if (code < 0x80) return '\\x' + code.toString(16).padStart(2, '0');
    return code > 0xffff
      ? '\\U' + code.toString(16).padStart(8, '0')
      : '\\u' + code.toString(16).padStart(4, '0');
  });
}

function cppDoc(text: string | undefined, indent: string): string {
  if (text === undefined) return '';
  // A block comment avoids the line splice that a trailing backslash causes in a line comment.
  const lines = text
    .trim()
    .split(LINE_BREAKS)
    .map((line) => asciiOnly(line).replace(/\*\//g, '*\\/').replace(/\/\*/g, '/\\*'));
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  const body = lines.map((line) => (line === '' ? `${indent} *` : `${indent} * ${line}`));
  return `${indent}/**\n${body.join('\n')}\n${indent} */\n`;
}

/** Writes a narrow string literal as ASCII, with every other UTF-8 byte as an octal escape. */
function cppString(value: string): string {
  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (byte === 0x22 || byte === 0x5c || byte === 0x3f) {
      result += '\\' + c;
    } else if (byte >= 0x20 && byte < 0x7f) {
      result += c;
    } else {
      result += '\\' + byte.toString(8).padStart(3, '0');
    }
  }
  return `"${result}"`;
}
