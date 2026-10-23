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

| Type             | Syntax                         | Size (bytes)          | Java type                   | C# type                                 | TypeScript type                                         | C++ type                                                       |
| ---------------- | ------------------------------ | --------------------- | --------------------------- | --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Unsigned integer | `u8` `u16` `u32` `u64`         | 1 / 2 / 4 / 8         | `short` `int` `long` `long` | `byte` `ushort` `uint` `ulong`          | `number` `number` `number` `bigint`                     | `std::uint8_t` `std::uint16_t` `std::uint32_t` `std::uint64_t` |
| Signed integer   | `i8` `i16` `i32` `i64`         | 1 / 2 / 4 / 8         | `byte` `short` `int` `long` | `sbyte` `short` `int` `long`            | `number` `number` `number` `bigint`                     | `std::int8_t` `std::int16_t` `std::int32_t` `std::int64_t`     |
| Float            | `f32` `f64`                    | 4 / 8                 | `float` `double`            | `float` `double`                        | `number`                                                | `float` `double`                                               |
| Boolean          | `bool`                         | 1                     | `boolean`                   | `bool`                                  | `boolean`                                               | `bool`                                                         |
| String           | `string`, `length: u8/u16/u32` | prefix + UTF-8 bytes  | `String`                    | `string`                                | `string`                                                | `std::string`                                                  |
| Bytes            | `bytes`, `length: u8/u16/u32`  | prefix + n            | `byte[]`                    | `byte[]`                                | `Uint8Array`                                            | `std::vector<std::uint8_t>`                                    |
| Fixed bytes      | `bytes`, `size: 16`            | 16                    | `byte[]`                    | `byte[]`                                | `Uint8Array`                                            | `std::array<std::uint8_t, N>`                                  |
| Prefixed array   | `T[]`, `length: u8/u16/u32`    | prefix + elements     | `List<T>`                   | `List<T>`                               | `T[]`                                                   | `std::vector<T>`                                               |
| Fixed array      | `T[4]`                         | 4 elements            | `List<T>`                   | `List<T>`                               | `T[]`                                                   | `std::array<T, N>`                                             |
| Struct           | a name from `structs`          | sum of its fields     | generated class             | generated class                         | generated class                                         | generated `struct`                                             |
| Enum             | a name from `enums`            | its base integer type | generated `enum`            | generated `enum`, members in PascalCase | `const` object plus a union type, members in PascalCase | generated `enum class`, members in PascalCase                  |

- `length` defaults to `u16`. It counts bytes for strings and bytes, and elements for arrays.
- Java has no unsigned integers, so unsigned types use the next larger type. `u64` uses `long`; values above 2^63 appear negative and can be printed with `Long.toUnsignedString`.
- C# has native unsigned integers, so each type maps directly and integers need no range checks.
- C++ uses the fixed-width integers from `<cstdint>`, so integers need no range checks; strings are `std::string` and their bytes are copied as they are, without checking that they are valid UTF-8.
- TypeScript uses `bigint` for `u64` and `i64` and `number` for every other numeric type; writing checks the range and rejects fractions.
- Enum base types can be `u8 u16 u32 i8 i16 i32`.
- Structs may recurse through prefixed arrays (trees, for example), but cannot contain themselves directly or through a fixed array.
- Arrays of `bytes` are not supported yet; wrap the bytes in a struct.

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

The docs generator produces field tables like this one:

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

| Severity   | Changes                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| breaking   | Endianness or opcode width; a packet removed or its opcode or direction changed; a field added or removed (the bytes after it shift); a field's type, size, length prefix, fixed length or array element type; a reorder that changes the layout; an enum's underlying type, a value removed or renumbered; the same changes inside a struct (with the packets that carry it) |
| compatible | A new packet with a new opcode, a new enum value, a new struct or enum                                                                                                                                                                                                                                                                                                        |
| info       | Protocol rename, `version` or `doc` changes; a field, packet or enum value renamed with the same position and type; a type renamed with the same layout; a reorder that leaves the layout unchanged                                                                                                                                                                           |

- A breaking change to a struct or enum that no packet uses is reported as info.
- A new enum value counts as compatible, but the generated code throws on values it does not know, so an older peer that receives the new value still fails.
- Exit codes: 0 when nothing is breaking, 1 when anything is, 2 for usage errors. Like `check`, an unreadable file or one that fails validation exits 1 with the errors on stderr; errors from both files are listed together.

## Roadmap

- [x] Definition parser and `check`
- [x] Java generator
- [x] Markdown docs generator
- [x] C# generator (Unity and .NET servers)
- [x] TypeScript generator (web clients and Node servers)
- [x] C++ generator (servers and native plugins)
- [x] Wireshark Lua dissector, so captures show field names
- [x] `pktspec diff old.yaml new.yaml` to list changes and compatibility problems between versions
- [ ] Fuzz test data generated from the definition
- [ ] Conditional fields (a value decides whether later fields are present) and bit fields

## Development

```sh
npm test            # unit tests, golden files, Java, C#, TypeScript, C++ round trips and Wireshark tests (Java, C#, C++ and Wireshark need javac, dotnet, a C++ compiler and tshark)
npm run lint        # ESLint + Prettier
npx vitest run -u   # update golden files after an intended generator change
```

The round-trip tests encode and decode every packet with edge-case values and check that nothing changes. The Java one needs `javac` and `java` on the PATH; the C# one needs the .NET SDK 8 or later (`dotnet`). Either is skipped when its tools are missing, unless `PKTSPEC_REQUIRE_JAVA` or `PKTSPEC_REQUIRE_DOTNET` is set, which makes the missing tool a failure. The C++ one needs `g++`, `clang++` or MSVC's `cl` on the PATH (or named by the `CXX` environment variable); it compiles the generated headers and a test program with `-std=c++17 -Wall -Wextra -Werror -pedantic` (`/W4 /WX` for MSVC) and runs it. It is skipped when no compiler is found, unless `PKTSPEC_REQUIRE_CPP` is set. The TypeScript one compiles the generated code with the project's own `tsc` in strict mode (including `noUncheckedIndexedAccess`, `noUnusedLocals` and `erasableSyntaxOnly`) and runs it on Node.js, so it needs no extra tools. The Wireshark one builds a pcap file (Ethernet, IPv4, UDP or TCP) inside the test, runs `tshark -X lua_script:... -T fields` and checks every packet's fields and expert info; it needs `tshark` with Lua (on the PATH or in the default Windows install folder) and is skipped when missing, unless `PKTSPEC_REQUIRE_TSHARK` is set.

## License

[MIT](LICENSE) © 冷牛
