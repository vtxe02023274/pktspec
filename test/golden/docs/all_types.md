# all_types

Version 2.1 · big-endian · u8 opcode

Every packet starts with its opcode, followed by the fields below in order.
Strings are UTF-8; their length prefix counts bytes, not characters.

## Packets

| Opcode | Packet | Direction | Body size |
| --- | --- | --- | --- |
| `0x01` | [Numbers](#numbers) | client → server | 43 |
| `0x02` | [Texts](#texts) | client → server | 15+ |
| `0x02` | [Collections](#collections) | server → client | 28+ |
| `0x03` | [Nested](#nested) | server → client | 11+ |
| `0xFF` | [Ping](#ping) | server → client | 0 |

### Numbers

Opcode `0x01` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `a_u8` | u8 | 1 |  |
| `a_u16` | u16 | 2 |  |
| `a_u32` | u32 | 4 |  |
| `a_u64` | u64 | 8 |  |
| `a_i8` | i8 | 1 |  |
| `a_i16` | i16 | 2 |  |
| `a_i32` | i32 | 4 |  |
| `a_i64` | i64 | 8 |  |
| `a_f32` | f32 | 4 |  |
| `a_f64` | f64 | 8 |  |
| `a_bool` | bool | 1 |  |

### Texts

Opcode `0x02` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `short_text` | string (u8 length) | 1 + n |  |
| `text` | string (u16 length) | 2 + n |  |
| `long_text` | string (u32 length) | 4 + n |  |
| `blob` | bytes (u32 length) | 4 + n |  |
| `hash` | bytes (4) | 4 |  |

### Collections

Opcode `0x02` · server → client

Reuses opcode 2 in the other direction.

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `ids` | u32[] (u16 count) | 2 + 4n |  |
| `names` | string (u16 length)[] (u8 count) | 1 + variable |  |
| `flags` | bool[3] | 3 |  |
| `corners` | [Point](#point)[4] | 16 |  |
| `path` | [Point](#point)[] (u32 count) | 4 + 4n |  |
| `kinds` | [Small](#small)[] (u16 count) | 2 + n |  |

### Nested

Opcode `0x03` · server → client

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `origin` | [Point](#point) | 4 |  |
| `tree` | [Node](#node) | 2+ |  |
| `small` | [Small](#small) | 1 |  |
| `wide` | [Wide](#wide) | 4 |  |
| `nothing` | [Empty](#empty) | 0 |  |

### Ping

Opcode `0xFF` · server → client

No fields.

## Structs

### Point

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `x` | i16 | 2 |  |
| `y` | i16 | 2 |  |

### Node

Recursion is allowed through prefixed arrays.

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `label` | string (u8 length) | 1 + n |  |
| `children` | [Node](#node)[] (u8 count) | 1 + variable |  |

### Empty

No fields.

## Enums

### Small

Encoded as `i8`.

| Name | Value |
| --- | --- |
| `MINUS` | -128 |
| `ZERO` | 0 |
| `PLUS` | 127 |

### Wide

Encoded as `u32`.

| Name | Value |
| --- | --- |
| `LOW` | 0 |
| `HIGH` | 4294967295 |
