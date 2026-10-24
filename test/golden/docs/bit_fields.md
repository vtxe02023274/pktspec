# bit_fields

Version 1 · little-endian · u8 opcode

Bit fields in every base width, with enums, bools and unused high bits.

Every packet starts with its opcode, followed by the fields below in order.
Strings are UTF-8; their length prefix counts bytes, not characters.

## Packets

| Opcode | Packet | Direction | Body size |
| --- | --- | --- | --- |
| `0x01` | [Status](#status) | client → server | 7 |
| `0x02` | [Board](#board) | server → client | 5+ |

### Status

Opcode `0x01` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `seq` | u8 | 1 |  |
| `state` | u16 bit fields | 2 | Packed player state. |
| `wide` | u32 bit fields | 4 |  |

Bits of `state`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0 | `alive` | bool | False once the player is down. |
| 1–2 | `team` | [Team](#team) |  |
| 3–9 | `level` | unsigned |  |
| 10–11 | `mood` | [Mood](#mood) |  |
| 12–15 | (unused) |  | Written as 0, ignored when read. |

Bits of `wide`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0–30 | `low` | unsigned |  |
| 31 | `top` | bool |  |

### Board

Opcode `0x02` · server → client

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `cells` | [Cell](#cell)[] (u8 count) | 1 + 3n |  |
| `full` | u32 bit fields | 4 |  |

Bits of `full`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0–31 | `everything` | unsigned |  |

## Structs

### Cell

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `flags` | u8 bit fields | 1 |  |
| `id` | u16 | 2 |  |

Bits of `flags`, from the least significant bit:

| Bits | Field | Type | Description |
| --- | --- | --- | --- |
| 0 | `open` | bool |  |
| 1–2 | `owner` | [Team](#team) |  |
| 3–7 | (unused) |  | Written as 0, ignored when read. |

## Enums

### Team

Encoded as `u8`.

| Name | Value |
| --- | --- |
| `RED` | 0 |
| `BLUE` | 1 |
| `GREEN` | 2 |

### Mood

Encoded as `i16`.

Has no zero value, so an all-zero bit field does not decode.

| Name | Value |
| --- | --- |
| `CALM` | 1 |
| `ANGRY` | 3 |
