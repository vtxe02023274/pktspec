# conditional_fields

Version 1 · big-endian · u8 opcode

Fields that are only on the wire when an earlier field matches.

Every packet starts with its opcode, followed by the fields below in order.
Strings are UTF-8; their length prefix counts bytes, not characters.
A field with a condition is only on the wire while its condition holds.

## Packets

| Opcode | Packet | Direction | Body size |
| --- | --- | --- | --- |
| `0x01` | [Draw](#draw) | client → server | 1+ |
| `0x02` | [Profile](#profile) | server → client | 11+ |

### Draw

Opcode `0x01` · client → server

| Field | Type | Size (bytes) | Present when | Description |
| --- | --- | --- | --- | --- |
| `shape` | [Shape](#shape) | 1 |  |  |
| `radius` | f32 | 4 | `shape` = `CIRCLE` |  |
| `corner` | [Point](#point) | 4 | `shape` is one of `RECT`, `POLYGON` |  |
| `points` | [Point](#point)[] (u8 count) | 1 + 4n | `shape` = `POLYGON` |  |
| `closed` | bool | 1 | `shape` = `POLYGON` |  |
| `fill` | u32 | 4 | `closed` is true | Only when the polygon is closed. |
| `style` | u8 bit fields | 1 | `closed` is true |  |
| `dash` | u8[2] | 2 | `dashed` is true |  |
| `label` | string (u8 length) | 1 + n | `width` is one of 0, 15 |  |

Bits of `style`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0 | `dashed` | bool |  |
| 1–4 | `width` | unsigned |  |
| 5–7 | (unused) |  | Written as 0, ignored when read. |

### Profile

Opcode `0x02` · server → client

| Field | Type | Size (bytes) | Present when | Description |
| --- | --- | --- | --- | --- |
| `id` | u64 | 8 |  |  |
| `level` | i8 | 1 |  |  |
| `bonus` | i64 | 8 | `level` = -128 |  |
| `flags` | u16 bit fields | 2 |  |  |
| `guild` | [Guild](#guild) | 5+ | `in_guild` is true |  |
| `title` | string (u16 length) | 2 + n | `tier` = 7 |  |
| `sides` | u8 | 1 | `kind` = `POLYGON` |  |
| `avatar` | bytes (u8 length) | 1 + n | `id` is one of 0, 9007199254740991 |  |
| `tree` | [Node](#node) | 2+ | `in_guild` is true |  |

Bits of `flags`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0 | `in_guild` | bool |  |
| 1–3 | `tier` | unsigned |  |
| 4–5 | `kind` | [Shape](#shape) |  |
| 6–15 | (unused) |  | Written as 0, ignored when read. |

## Structs

### Point

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `x` | i16 | 2 |  |
| `y` | i16 | 2 |  |

### Guild

| Field | Type | Size (bytes) | Present when | Description |
| --- | --- | --- | --- | --- |
| `id` | u32 | 4 |  |  |
| `has_emblem` | bool | 1 |  |  |
| `emblem` | bytes (4) | 4 | `has_emblem` is true |  |

### Node

Recursive through a conditional array.

| Field | Type | Size (bytes) | Present when | Description |
| --- | --- | --- | --- | --- |
| `value` | u8 | 1 |  |  |
| `has_children` | bool | 1 |  |  |
| `children` | [Node](#node)[] (u8 count) | 1 + variable | `has_children` is true |  |

## Enums

### Shape

Encoded as `u8`.

| Name | Value |
| --- | --- |
| `POINT` | 0 |
| `CIRCLE` | 1 |
| `RECT` | 2 |
| `POLYGON` | 3 |
