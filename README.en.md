# pktspec

[繁體中文](README.md)

Describe your game packets once in YAML, then generate encoders, decoders and docs for each language.

Game servers and clients often keep their packet layouts only in code. Each side has its own reader and writer, and the two drift apart whenever a field changes. With pktspec the protocol has a single definition, and both the code and the docs are generated from it.

```mermaid
flowchart LR
  yaml[protocol.yaml] --> check[pktspec check]
  check --> java[Java classes]
  check --> csharp[C# classes]
  check --> ts[TypeScript classes]
  check --> cpp[C++ headers]
  check --> lua[Wireshark dissector]
  check --> docs[Markdown docs]
```

## Quick start

Requires Node.js 20 or later.

```sh
npx pktspec check protocol.yaml
npx pktspec diff old.yaml new.yaml
npx pktspec gen java protocol.yaml -o out/java --package com.example.chat
npx pktspec gen csharp protocol.yaml -o out/csharp --namespace Example.Chat
npx pktspec gen typescript protocol.yaml -o out/ts
npx pktspec gen cpp protocol.yaml -o out/cpp --namespace Example::Chat
npx pktspec gen wireshark protocol.yaml -o out/wireshark --port 7000
npx pktspec gen docs protocol.yaml -o out/docs
npx pktspec fuzz protocol.yaml -o out/fuzz --seed 1 --count 16
```

Example definitions are in [examples/](examples/), such as `examples/chat-room.yaml`.

| Command                                  | What it does                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pktspec check <file>`                   | Validates a definition and reports errors with line and column                            |
| `pktspec diff <old> <new>`               | Compares two versions and lists wire compatibility changes                                |
| `pktspec gen java <file> -o <dir>`       | Generates Java classes; `--package` sets the package                                      |
| `pktspec gen csharp <file> -o <dir>`     | Generates C# classes; `--namespace` sets the namespace                                    |
| `pktspec gen typescript <file> -o <dir>` | Generates TypeScript classes for browsers and Node.js                                     |
| `pktspec gen cpp <file> -o <dir>`        | Generates C++17 headers using only the standard library; `--namespace` sets the namespace |
| `pktspec gen wireshark <file> -o <dir>`  | Generates a Wireshark Lua dissector; `--port` sets the default port                       |
| `pktspec gen docs <file> -o <dir>`       | Generates a Markdown field reference                                                      |
| `pktspec fuzz <file> -o <dir>`           | Generates fuzz test data (valid and invalid packet samples plus a manifest)               |

Errors use the `file:line:column: error: message` format that editors can jump to:

```
protocol.yaml:12:17: error: opcode 0x03 (c2s) is already used by 'Say' at line 8
```

## Definition format

See [`examples/chat-room.yaml`](examples/chat-room.yaml) for a complete example.

```yaml
name: chat-room # used to name the generated classes
version: 1 # optional
endian: little # little or big, default little
opcode: u16 # u8 or u16, default u16

enums:
  RoomKind:
    type: u8
    values:
      PUBLIC: 0
      PRIVATE: 1

structs:
  User:
    fields:
      - { name: id, type: u32 }
      - { name: nickname, type: string, length: u8 }

packets:
  - name: RoomJoined
    opcode: 0x02
    direction: s2c # c2s: client to server; s2c: server to client
    doc: Sent after the client joins a room.
    fields:
      - name: room_id
        type: u32
      - name: kind
        type: RoomKind
      - name: members
        type: User[]
        length: u8 # type of the array's count prefix
```

- Opcodes only need to be unique within one direction; `c2s` and `s2c` may reuse a number.
- Packet, struct and enum names share one namespace and must differ by more than case, because they become file names. Declaration order does not matter. Names must start with an uppercase letter and cannot reuse a built-in type name.
- Field names may be `snake_case` or `camelCase`; the Java, TypeScript and C++ generators convert them to `camelCase` and the C# generator to `PascalCase`. Underscores are dropped, so a leading underscore must be followed by a letter (`_1st` is rejected).
- `doc` ends up in the Javadoc, in the C# XML doc comments, in the TypeScript JSDoc, in the C++ block comments and in the generated docs.

### Types

| Type              | Syntax                         | Size (bytes)               | Java type                   | C# type                                 | TypeScript type                                         | C++ type                                                       |
| ----------------- | ------------------------------ | -------------------------- | --------------------------- | --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Unsigned integer  | `u8` `u16` `u32` `u64`         | 1 / 2 / 4 / 8              | `short` `int` `long` `long` | `byte` `ushort` `uint` `ulong`          | `number` `number` `number` `bigint`                     | `std::uint8_t` `std::uint16_t` `std::uint32_t` `std::uint64_t` |
| Signed integer    | `i8` `i16` `i32` `i64`         | 1 / 2 / 4 / 8              | `byte` `short` `int` `long` | `sbyte` `short` `int` `long`            | `number` `number` `number` `bigint`                     | `std::int8_t` `std::int16_t` `std::int32_t` `std::int64_t`     |
| Float             | `f32` `f64`                    | 4 / 8                      | `float` `double`            | `float` `double`                        | `number`                                                | `float` `double`                                               |
| Boolean           | `bool`                         | 1                          | `boolean`                   | `bool`                                  | `boolean`                                               | `bool`                                                         |
| String            | `string`, `length: u8/u16/u32` | prefix + UTF-8 bytes       | `String`                    | `string`                                | `string`                                                | `std::string`                                                  |
| Bytes             | `bytes`, `length: u8/u16/u32`  | prefix + n                 | `byte[]`                    | `byte[]`                                | `Uint8Array`                                            | `std::vector<std::uint8_t>`                                    |
| Fixed bytes       | `bytes`, `size: 16`            | 16                         | `byte[]`                    | `byte[]`                                | `Uint8Array`                                            | `std::array<std::uint8_t, N>`                                  |
| Prefixed array    | `T[]`, `length: u8/u16/u32`    | prefix + elements          | `List<T>`                   | `List<T>`                               | `T[]`                                                   | `std::vector<T>`                                               |
| Fixed array       | `T[4]`                         | 4 elements                 | `List<T>`                   | `List<T>`                               | `T[]`                                                   | `std::array<T, N>`                                             |
| Struct            | a name from `structs`          | sum of its fields          | generated class             | generated class                         | generated class                                         | generated `struct`                                             |
| Enum              | a name from `enums`            | its base integer type      | generated `enum`            | generated `enum`, members in PascalCase | `const` object plus a union type, members in PascalCase | generated `enum class`, members in PascalCase                  |
| Bit fields        | `u8` `u16` `u32` with `bits`   | 1 / 2 / 4                  | one member per bit field    | one member per bit field                | one member per bit field                                | one member per bit field                                       |
| Conditional field | any type with `if`             | 0 when the condition fails | boxed type (nullable)       | `T?`                                    | `T \| undefined`                                        | `std::optional<T>`                                             |

- `length` defaults to `u16`. It counts bytes for strings and bytes, and elements for arrays.
- Java has no unsigned integers, so unsigned types use the next larger type. `u64` uses `long`; values above 2^63 appear negative and can be printed with `Long.toUnsignedString`.
- C# has native unsigned integers, so each type maps directly and integers need no range checks.
- C++ uses the fixed-width integers from `<cstdint>`, so integers need no range checks; strings are `std::string` and their bytes are copied as they are, without checking that they are valid UTF-8.
- TypeScript uses `bigint` for `u64` and `i64` and `number` for every other numeric type; writing checks the range and rejects fractions.
- Enum base types can be `u8 u16 u32 i8 i16 i32`.
- Structs may recurse through prefixed arrays (trees, for example), but cannot contain themselves directly or through a fixed array.
- Arrays of `bytes` are not supported yet; wrap the bytes in a struct.

### Bit fields

A `u8`, `u16` or `u32` integer can be split into several fields, listed in order under `bits`:

```yaml
fields:
  - name: state
    type: u16 # the integer underneath, read and written in the protocol's byte order
    bits:
      - { name: alive, type: bool } # bit 0
      - { name: team, type: Team, bits: 2 } # bits 1-2, an enum
      - { name: level, bits: 7 } # bits 3-9, an unsigned integer
```

- Bits are assigned from the least significant bit up, so the first field starts at bit 0. The widths may not add up to more than the integer holds; the high bits left over are written as 0 and ignored when read.
- A bit field's `type` is `bool` (1 bit, `bits` may be left out) or an enum (every value must be between 0 and 2^`bits` - 1, so none can be negative); without `type` it is an unsigned integer and `bits` is required. `bits` is at least 1.
- In the generated code each bit field is an ordinary member, named by the language's usual rules; the group name (`state`) only shows up in the docs, in Wireshark and in `diff`. Bit fields share one namespace with the fields around them. An unsigned bit field gets the smallest unsigned type that holds it, for example 7 bits are a `short` in Java, a `byte` in C# and a `std::uint8_t` in C++.
- Writing a value that does not fit its bits throws the usual range error: `IllegalArgumentException` in Java, `ArgumentException` in C#, `RangeError` in TypeScript and `PacketRangeError` in C++. Reading an enum value the enum does not define throws the same error as an ordinary enum field.
- Bit fields cannot be array elements; wrap them in a struct and use an array of the struct.

### Conditional fields

A field with `if` is only on the wire when an earlier field of the same struct or packet matches:

```yaml
fields:
  - { name: shape, type: Shape }
  - { name: radius, type: f32, if: { field: shape, equals: CIRCLE } } # only for CIRCLE
  - { name: corner, type: Point, if: { field: shape, in: [RECT, POLYGON] } } # for either value
  - { name: has_guild, type: bool }
  - { name: guild, type: Guild, if: has_guild } # only when the bool is true
```

- A condition can only test an earlier field. A `bool` (a `bool` bit field too) is written `if: field_name` and means true; an integer or enum (unsigned and enum bit fields too) takes one value with `equals` or a list with `in`. Enum values are member names; integers must fit the type, a bit field its bits, and `u64` and `i64` are limited to ±(2^53 - 1).
- When the condition fails, the field is not on the wire at all and takes no bytes. A group of bit fields can have a condition too; the whole group comes and goes together.
- The tested field may be conditional itself: while it is absent, every condition on it fails, so conditions can be chained.
- `check` rejects a condition on the field itself, on a later field, on the name of a bit field group, or on a string, float, struct or array; also an unknown enum member, an integer out of range and a value listed twice in `in`. Array elements cannot have conditions of their own.
- In the generated code a conditional field is optional: a nullable boxed type in Java (`Float`, `Long`; reference types stay as they are), a nullable type in C# (`float?`, `string?`), `T | undefined` in TypeScript and `std::optional<T>` in C++, empty by default. Decoding leaves it empty when the condition fails.
- Java uses boxed types rather than `Optional`: `Optional` is not meant for fields (it is discouraged there and not serializable), and the generated classes have public fields, so a boxed type is read and written like any other field.
- Encoding a field whose condition holds but which has no value, or one that has a value while its condition fails, throws the usual write error: `IllegalArgumentException` in Java, `ArgumentException` in C#, `RangeError` in TypeScript and `PacketRangeError` in C++. `bodySize` counts what the fields hold.

## Generated code

The Java output depends only on `java.nio.ByteBuffer` and compiles on Java 8 and later. Each packet gets its own class, plus an entry point that dispatches on the opcode:

```java
Say say = new Say(42, "hello");
byte[] data = say.encode();                    // opcode + body

Packet packet = ChatRoomProtocol.decodeFromClient(data);
if (packet instanceof Say) {
    System.out.println(((Say) packet).text);
}
```

```java
public final class Say implements Packet {
    public static final int OPCODE = 0x0003;

    public long roomId;
    public String text = "";

    @Override
    public void writeTo(ByteBuffer buf) {
        ChatRoomCodec.writeU32(buf, this.roomId);
        ChatRoomCodec.writeString(buf, this.text, 2);
    }

    public static Say readFrom(ByteBuffer buf) {
        Say result = new Say();
        result.roomId = ChatRoomCodec.readU32(buf);
        result.text = ChatRoomCodec.readString(buf, 2);
        return result;
    }
    // plus constructors, bodySize, equals, hashCode and toString
}
```

Writing checks value ranges, string lengths and fixed array sizes, and throws `IllegalArgumentException` instead of silently truncating.

### C#

The C# output is written in C# 9 and compiles against .NET Standard 2.1 (Unity 2021.2 and later, and .NET servers), depending only on types in `System`. Each packet gets its own class, plus an entry point that dispatches on the opcode. The byte order is fixed by the definition:

```csharp
var say = new Say(42, "hello");
byte[] data = say.Encode();                    // opcode + body

IPacket packet = ChatRoomProtocol.DecodeFromClient(data);
if (packet is Say received)
{
    Console.WriteLine(received.Text);
}
```

```csharp
public sealed class Say : IPacket, IEquatable<Say>
{
    public const int OpcodeValue = 0x0003;

    public uint RoomId { get; set; }
    public string Text { get; set; } = "";

    public void WriteTo(PacketWriter writer)
    {
        writer.WriteU32(this.RoomId);
        writer.WriteString(this.Text, 2);
    }

    public static Say ReadFrom(PacketReader reader)
    {
        Say result = new Say();
        result.RoomId = reader.ReadU32();
        result.Text = reader.ReadString(2);
        return result;
    }
    // plus constructors, BodySize, Equals, GetHashCode and ToString
}
```

- Members are always `PascalCase`. A field that clashes with a generated member (`Opcode`, `BodySize`, `WriteTo`), the class name or another type name gets an underscore appended.
- Writing throws `ArgumentException` when a length does not fit its prefix or a fixed array has the wrong number of elements. Reading throws `EndOfStreamException` when the data ends early, and `InvalidDataException` for an unknown opcode or enum value.
- `PacketReader`, `PacketWriter` and `IPacket` are generated alongside, all in the output directory with no subdirectories.

### TypeScript

The TypeScript output has no dependencies. It only uses `DataView`, `Uint8Array`, `TextEncoder` and `TextDecoder`, so it runs in browsers and on Node.js 18 and later. It needs a compile target of ES2020 or later (for `bigint`) and `TextEncoder` types (a `lib` that includes `DOM`, or `@types/node`). Each type gets its own `.ts` file, and every import carries a `.js` extension so Node's ESM and bundlers both work. It avoids `enum`, namespaces and constructor parameter properties, so it also compiles under `erasableSyntaxOnly` and `isolatedModules`:

```ts
import { ChatRoomProtocol, Say } from './out/ts/index.js';

const say = new Say(42, 'hello');
const data = say.encode(); // opcode + body, a Uint8Array

const packet = ChatRoomProtocol.decodeFromClient(data);
if (packet instanceof Say) {
  console.log(packet.text);
}
```

```ts
export class Say implements Packet {
  static readonly OPCODE = 0x0003;

  roomId: number;
  text: string;

  writeTo(writer: PacketWriter): void {
    writer.writeU32(this.roomId);
    writer.writeString(this.text, 2);
  }

  static readFrom(reader: PacketReader): Say {
    const result = new Say();
    result.roomId = reader.readU32();
    result.text = reader.readString(2);
    return result;
  }
  // plus a constructor, bodySize, encode, equals and toString
}
```

- Members are always `camelCase`. A field that clashes with a generated member (`opcode`, `bodySize`, `writeTo`) or an `Object` member gets an underscore appended. A field named like a reserved word (such as `class`) keeps its property name; only the constructor parameter gets the underscore.
- An enum is a `const` object plus a union type of the same name, for example `LoginStatus.BadPassword`, with members in PascalCase.
- Writing throws `RangeError` when a number is out of range or fractional, a length does not fit its prefix, or a fixed array has the wrong number of elements. Reading throws `TruncatedPacketError` when the data ends early, and `InvalidPacketError` for an unknown opcode or enum value or a length above 2^31 - 1.
- There is no `hashCode`, and a `f32` or `f64` NaN is always written as the canonical NaN rather than keeping its original bits.
- Type names cannot reuse names the generated code depends on, such as `Packet`, `Index`, `Uint8Array` or `Error`.

### C++

The C++ output is C++17 headers that use only the standard library, with no `.cpp` files: add the output directory to the include path and you are done, whether it goes into a server or an Unreal or Unity native plugin, with nothing extra to link. The byte order is fixed by the definition and values are assembled byte by byte, so nothing depends on the host's endianness; floats go through `memcpy`. The namespace defaults to the protocol name in PascalCase, and `--namespace Example::Chat` (`Example.Chat` is accepted too) sets it. Errors are reported with exceptions, so compile with exceptions enabled (Unreal turns them off by default).

```cpp
#include "ChatRoomProtocol.hpp"

using namespace ChatRoom;

Say say(42, "hello");
std::vector<std::uint8_t> data = say.encode();  // opcode + body

std::unique_ptr<Packet> packet = ChatRoomProtocol::decodeFromClient(data);
if (packet->opcode() == Say::OpcodeValue) {
    const Say& received = static_cast<const Say&>(*packet);
    std::cout << received.text << "\n";
}
```

```cpp
struct Say final : public Packet {
    static constexpr std::uint16_t OpcodeValue = 0x0003;

    std::uint32_t roomId{};
    std::string text{};

    std::size_t bodySize() const override;
    void writeTo(PacketWriter& writer) const override;
    static Say readFrom(PacketReader& reader);
    // plus constructors, opcode, operator== and operator!=
};
```

- Decoding returns a `std::unique_ptr<Packet>`; check `opcode()` and cast. It is not a `std::variant` because a direction may have no packets at all (an empty `variant` is ill-formed) and servers often queue packets before dispatching them, which a base class pointer handles better; the price is one heap allocation per packet. `decodeFromClient(data, size)` overloads take a pointer and a length directly.
- Every error derives from `std::runtime_error`: `TruncatedPacketError` when the data ends early; `InvalidPacketError` for invalid data (a length above 2^31 - 1), with the subclasses `UnknownOpcodeError` (`opcode()` returns the value read) and `UnknownEnumValueError` for an unknown opcode or enum value; `PacketRangeError` when writing a length that does not fit its prefix. They all share the base class `PacketError`. Fixed arrays and fixed bytes are `std::array`, so the type guarantees their size and there is no "wrong number of elements" error.
- Members are always `camelCase`. A field that clashes with a generated member (`opcode`, `bodySize`, `writeTo`), a C++ keyword, or a name that headers often define as a macro (`min`, `max`) gets an underscore appended.
- All structs live in `Structs.hpp`: two structs may hold arrays of each other, and no include order compiles when every type has its own header. Packets and enums get one header each, and `<protocol name>Protocol.hpp` is the entry point.
- There is no `hashCode` or `toString`, and two NaN values compare equal.
- Type names cannot reuse names the generated code depends on, such as `Packet`, `PacketReader`, `Structs` or `NULL`.

### Wireshark

`pktspec gen wireshark protocol.yaml -o out/wireshark --port 7000` writes one self-contained `<protocol name>.lua` with no module dependencies; it needs Wireshark 3.6 or later. Captures then show packet, field and enum names, and you can filter with expressions such as `chat_room.say.text == "hi"`.

Install it by copying the file to the personal plugins folder (Help > About Wireshark > Folders > Personal Lua Plugins) and restarting Wireshark, or skip installing and run `tshark -X lua_script:chat-room.lua -r capture.pcap`.

- On the wire a message is just the opcode and the body, with no length prefix, so there is no TCP reassembly: every UDP datagram or TCP segment is read as one message, and bytes after it are flagged as a note. A message split across segments shows up as truncated.
- Ports: `--port` is the default of three preferences, TCP port, UDP port and server port; without it they are 0 and nothing is registered. Set a port under Edit > Preferences > Protocols > the protocol name, or use Analyze > Decode As (`tshark -d udp.port==7000,chat_room`).
- Direction: traffic to the server port is `c2s` and traffic from it is `s2c`; when the server port is unset the TCP and UDP ports are used. If neither side matches and the opcode exists in both directions, both are tried and the one with fewer problems wins; a tie is read as `c2s` with a note.
- Field names are `protocol.packet.field` in lowercase with underscores, for example `chat_room.say.room_id`; struct fields use `protocol.struct.field`, array elements add `.item`, and `protocol.packet`, `protocol.direction` and `protocol.opcode` are always there.
- Expert info: truncated data, unknown opcode, unknown enum value, a length or count past the end of the packet, structs nested over 64 levels, data after the packet, and an unknown direction.
- The integer of a bit field group is shown in hex, with one masked field per bit field under it; those are named like ordinary fields, `protocol.packet.field`. Unknown enum values in bit fields get expert info too.
- A conditional field is only added to the tree when its condition holds; otherwise it is not there and cannot be filtered on.

The docs generator produces field tables like this one (bit fields get another table with the bits of each field and the unused bits; a table with conditional fields gets a `Present when` column with the conditions):

| Field     | Type                       | Size (bytes) | Description |
| --------- | -------------------------- | ------------ | ----------- |
| `room_id` | u32                        | 4            |             |
| `kind`    | [RoomKind](#roomkind)      | 1            |             |
| `members` | [User](#user)[] (u8 count) | 1 + variable |             |

## Comparing versions

`pktspec diff old.yaml new.yaml` compares two definitions and lists the differences grouped by severity. Line numbers come from the new file, with the old file's position in parentheses; `--format json` prints a machine-readable report.

```
$ pktspec diff v1.yaml v2.yaml
breaking (2)
  v2.yaml:15:17: struct 'Vec2' field 'x': type changed from i16 to i32 (used by: Move) (was v1.yaml:14:17)
  v1.yaml:31:11: packet 'Ping' (0x03, c2s) removed

compatible (2)
  v2.yaml:10:7: enum 'Team' value 'GREEN' (2) added
  v2.yaml:32:11: packet 'Chat' (0x04, c2s) added

info (2)
  v2.yaml:1:1: version changed from '1' to '2' (was v1.yaml:1:1)
  v2.yaml:23:17: packet 'Join' field 'id': renamed from 'player_id' (was v1.yaml:22:17)

2 breaking, 2 compatible, 2 info
```

The wire format is an opcode followed by the fields in order, with no names or tags, so the rules look at how the bytes are laid out:

| Severity   | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| breaking   | Endianness or opcode width; a packet removed or its opcode or direction changed; a field added or removed (the bytes after it shift); a field's type, size, length prefix, fixed length or array element type; a reorder that changes the layout; an enum's underlying type, a value removed or renumbered; the integer under bit fields, a bit field's width, position (order included) or type, a bit field removed, or a new one that takes bits old versions use or is an enum without the value 0; a condition added, removed or changed, and a new conditional field (except as below); the same changes inside a struct (with the packets that carry it) |
| compatible | A new packet with a new opcode, a new enum value, a new struct or enum; a new bit field in high bits that were unused; a new conditional field that only appears for enum values old versions do not define                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| info       | Protocol rename, `version` or `doc` changes; a field, packet, enum value or bit field renamed with the same position and type; a type renamed with the same layout; a reorder that leaves the layout unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- A breaking change to a struct or enum that no packet uses is reported as info.
- A new enum value counts as compatible, but the generated code throws on values it does not know, so an older peer that receives the new value still fails.
- A new bit field in unused high bits is compatible: old versions write those bits as 0 and ignore them, and new versions read 0 from old data. Only an enum without the value 0 fails on old data, so that case is breaking. Removing a bit field is breaking: old versions still read those bits and only ever get 0.
- When an enum is only used in bit fields, a change of its underlying type does not touch the wire and is reported as info.
- Adding, removing or changing a condition is breaking: the two sides disagree on whether those bytes are there, so the fields after them are misread. Conditions are compared by the position of the tested field and by the values on the wire, so renaming the tested field or an enum member, or reordering `in`, is not a change.
- A new conditional field is usually breaking, because the bytes after it shift whenever the condition holds. The exception is a condition that only matches enum values the old version does not define: old versions never send them and old data never meets the condition, so it is as compatible as adding the enum values.
- Exit codes: 0 when nothing is breaking, 1 when anything is, 2 for usage errors. Like `check`, an unreadable file or one that fails validation exits 1 with the errors on stderr; errors from both files are listed together.

## Fuzz test data

`pktspec fuzz protocol.yaml -o out/fuzz` writes a corpus of packet samples from the definition. Use it as the seed corpus for libFuzzer or AFL++, or feed it to your own replay harness. Each sample is one `.bin` file holding the opcode followed by the body, in the byte order and opcode width of the generated code; `manifest.json` says what each file is and what a decoder should do with it.

```
$ pktspec fuzz examples/chat-room.yaml -o out/fuzz --seed 1 --count 16
wrote 396 samples (207 valid, 189 invalid) to out/fuzz

out/fuzz/
  manifest.json
  valid/c2s-Login-account-max.bin
  valid/s2c-LoginResult-status-BANNED.bin
  valid/c2s-Login-random-01.bin
  invalid/c2s-Login-truncated-07.bin
  invalid/s2c-LoginResult-enum-status-bad_4.bin
  invalid/c2s-unknown_opcode-0000.bin
```

| Option               | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `--seed <n>`         | Seed of the random samples, 0 to 4294967295 (default 1)                                                  |
| `--count <n>`        | Random valid samples per packet (default 16, 0 for none)                                                 |
| `--max-size <bytes>` | Largest sample including the opcode (default 131072); larger ones are not written                        |
| `--max-samples <n>`  | Total number of samples (default: no limit); kept in the order of the table below, dropping from the end |

Each entry of `samples` in `manifest.json` describes one file:

```json
{
  "format": 1,
  "protocol": "chat-room",
  "version": "1",
  "endian": "little",
  "opcode": "u16",
  "seed": 1,
  "count": 16,
  "maxSize": 131072,
  "skipped": { "tooLarge": 0, "overLimit": 0 },
  "samples": [
    {
      "file": "valid/c2s-Login-account-max.bin",
      "packet": "Login",
      "direction": "c2s",
      "valid": true,
      "error": null,
      "kind": "boundary",
      "size": 292
    },
    {
      "file": "invalid/c2s-Login-length-account-length.bin",
      "packet": "Login",
      "direction": "c2s",
      "valid": false,
      "error": "truncated",
      "kind": "length_past_end",
      "size": 37
    },
    {
      "file": "invalid/c2s-unknown_opcode-0000.bin",
      "packet": null,
      "direction": "c2s",
      "valid": false,
      "error": "invalid",
      "kind": "unknown_opcode",
      "size": 2
    }
  ]
}
```

- `direction` names the decoder to feed: `c2s` for `decodeFromClient`, `s2c` for `decodeFromServer`. `packet` is the packet the sample was built from, or `null` when the opcode belongs to no packet.
- Every generated decoder decodes a sample with `valid: true`, and encoding the result gives back exactly the same bytes. A sample with `valid: false` always makes the decoder throw the error named by `error`:

| `error`     | TypeScript, C++        | Java                       | C#                     |
| ----------- | ---------------------- | -------------------------- | ---------------------- |
| `truncated` | `TruncatedPacketError` | `BufferUnderflowException` | `EndOfStreamException` |
| `invalid`   | `InvalidPacketError`   | `IllegalArgumentException` | `InvalidDataException` |

Samples are grouped by `kind`, and the table is also the order in which they are written and kept by `--max-samples`:

| `kind`             | `error`     | Content                                                                                                                                                                                                                                                              |
| ------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundary`         | none        | Whole packets with every field at zero (`zero`), at its lowest values (`min`) and at its highest values (`max`); then one field at a time set to a boundary value while the others stay zero                                                                         |
| `unknown_opcode`   | `invalid`   | In each direction the lowest and highest unused opcode, and opcodes that exist only in the other direction; opcode only, no body                                                                                                                                     |
| `unknown_enum`     | `invalid`   | Enum fields (also inside structs and arrays) set to the highest and the lowest value that no member uses; for enums in bit fields, within what the bits hold                                                                                                         |
| `length_past_end`  | `truncated` | The length prefix of a string, `bytes` or array set to the number of remaining bytes plus one                                                                                                                                                                        |
| `length_too_large` | `invalid`   | A `u32` length prefix set to `0xFFFFFFFF`, above 2^31 - 1                                                                                                                                                                                                            |
| `truncated`        | `truncated` | The `max` sample cut at every byte boundary (lengths 0 up to the full length minus one); above 1024 bytes only the first and last 512 lengths; for conditional fields, also a sample whose condition holds but which ends where the field starts (`missing-<field>`) |
| `random`           | none        | `--count` random valid samples per packet                                                                                                                                                                                                                            |

The boundary values for `boundary` are:

- For integers: the minimum, the maximum, 0 and 1, -1 for signed types and the top bit for unsigned types.
- For `f32` and `f64`: -0, 1.5, NaN, positive and negative infinity, the largest and the lowest finite value and the smallest subnormal; for `bool`: true.
- For strings and `bytes`: empty, short, multi-byte UTF-8 and the longest length the prefix allows; for fixed-size `bytes`: all `0xFF` and a fixed pattern.
- Every enum value.
- For bit fields: each field in turn at its maximum (true for `bool`, every value for an enum), with 0 covered by the all-zero sample; unused bits are always 0.
- For conditional fields: before the boundary values, the tested field is set to the first value that meets the condition (and so on back when it is conditional itself); there are also samples with the condition met (`present`) and failed (`absent`). Whole-packet and random samples leave fields out as their conditions say.
- For arrays: empty, one element, the longest count and element boundary values (names start with `elem-`); for fixed-size arrays: boundary values of the first element (`first-`); nested structs level by level, down to the third level for recursive ones.
- When the longest length a prefix allows does not fit in `--max-size`, the value is filled up to the longest length that fits and the file name says `fill` instead of `max`.

Notes:

- File names are `<direction>-<packet>-<case>.bin` using only letters, digits, `_`, `.` and `-`, and stay unique on case-insensitive file systems. Samples with identical bytes are written once, so there can be fewer random samples than `--count`.
- Random numbers come from a built-in mulberry32 generator, not `Math.random`. Each packet has its own stream (derived from the seed, the direction and the packet name), so the same definition, seed and options give the same bytes on every platform, and adding a packet does not change the random samples of the others. NaN is always the standard NaN.
- There are no samples with trailing bytes: every generated decoder reads one packet and leaves later bytes unread without treating them as an error. For the same reason there are none for a `bool` other than 0 or 1 (any non-zero value is true), for invalid UTF-8 (not an error) or for unused bits of bit fields that are not 0 (not checked).
- If the output directory already holds a `manifest.json`, the old `valid/` and `invalid/` folders are removed first so that samples of two runs never mix.
- Samples over `--max-size` are not written and counted in `skipped.tooLarge`; those dropped by `--max-samples` are counted in `skipped.overLimit`. Both are also reported on stderr.

## Roadmap

- [x] Definition parser and `check`
- [x] Java generator
- [x] Markdown docs generator
- [x] C# generator (Unity and .NET servers)
- [x] TypeScript generator (web clients and Node servers)
- [x] C++ generator (servers and native plugins)
- [x] Wireshark Lua dissector, so captures show field names
- [x] `pktspec diff old.yaml new.yaml` to list changes and compatibility problems between versions
- [x] `pktspec fuzz`: fuzz test data generated from the definition
- [x] Bit fields: one integer split into several fields
- [x] Conditional fields: a value decides whether later fields are read

## Development

```sh
npm test            # unit tests, golden files, Java, C#, TypeScript, C++ round trips and Wireshark tests (Java, C#, C++ and Wireshark need javac, dotnet, a C++ compiler and tshark)
npm run lint        # ESLint + Prettier
npx vitest run -u   # update golden files after an intended generator change
```

The round-trip tests encode and decode every packet with edge-case values and check that nothing changes. The Java one needs `javac` and `java` on the PATH; the C# one needs the .NET SDK 8 or later (`dotnet`). Either is skipped when its tools are missing, unless `PKTSPEC_REQUIRE_JAVA` or `PKTSPEC_REQUIRE_DOTNET` is set, which makes the missing tool a failure. The C++ one needs `g++`, `clang++` or MSVC's `cl` on the PATH (or named by the `CXX` environment variable); it compiles the generated headers and a test program with `-std=c++17 -Wall -Wextra -Werror -pedantic` (`/W4 /WX` for MSVC) and runs it. It is skipped when no compiler is found, unless `PKTSPEC_REQUIRE_CPP` is set. The fuzz tests feed the generated corpus to the TypeScript, Java, C# and C++ decoders (same skip and `PKTSPEC_REQUIRE_*` rules): valid samples must decode and encode back to the same bytes, invalid ones must throw the error the manifest names. The TypeScript one compiles the generated code with the project's own `tsc` in strict mode (including `noUncheckedIndexedAccess`, `noUnusedLocals` and `erasableSyntaxOnly`) and runs it on Node.js, so it needs no extra tools. The Wireshark one builds a pcap file (Ethernet, IPv4, UDP or TCP) inside the test, runs `tshark -X lua_script:... -T fields` and checks every packet's fields and expert info; it needs `tshark` with Lua (on the PATH or in the default Windows install folder) and is skipped when missing, unless `PKTSPEC_REQUIRE_TSHARK` is set.

## License

[MIT](LICENSE) © 冷牛
