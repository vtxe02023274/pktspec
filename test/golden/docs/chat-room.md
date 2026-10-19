# chat-room

Version 1 · little-endian · u16 opcode

Clients log in, join rooms and exchange text messages.

Every packet starts with its opcode, followed by the fields below in order.
Strings are UTF-8; their length prefix counts bytes, not characters.

## Packets

| Opcode | Packet | Direction | Body size |
| --- | --- | --- | --- |
| `0x0001` | [Login](#login) | client → server | 35+ |
| `0x0001` | [LoginResult](#loginresult) | server → client | 7+ |
| `0x0002` | [JoinRoom](#joinroom) | client → server | 5+ |
| `0x0002` | [RoomJoined](#roomjoined) | server → client | 6+ |
| `0x0003` | [Say](#say) | client → server | 6+ |
| `0x0003` | [Message](#message) | server → client | 18+ |
| `0x0004` | [LeaveRoom](#leaveroom) | client → server | 4 |
| `0x0004` | [UserLeft](#userleft) | server → client | 8 |

### Login

Opcode `0x0001` · client → server

First packet a client sends after connecting.

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `account` | string (u8 length) | 1 + n |  |
| `password_hash` | bytes (32) | 32 | SHA-256 of the password. |
| `client_version` | u16 | 2 |  |

### LoginResult

Opcode `0x0001` · server → client

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `status` | [LoginStatus](#loginstatus) | 1 |  |
| `user` | [User](#user) | 6+ | Only meaningful when status is OK. |

### JoinRoom

Opcode `0x0002` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |
| `password` | string (u8 length) | 1 + n | Empty for public rooms. |

### RoomJoined

Opcode `0x0002` · server → client

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |
| `kind` | [RoomKind](#roomkind) | 1 |  |
| `members` | [User](#user)[] (u8 count) | 1 + variable |  |

### Say

Opcode `0x0003` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |
| `text` | string (u16 length) | 2 + n |  |

### Message

Opcode `0x0003` · server → client

A message someone said in a room, including the sender.

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |
| `sender_id` | u32 | 4 |  |
| `text` | string (u16 length) | 2 + n |  |
| `sent_at` | i64 | 8 | Unix time in milliseconds. |

### LeaveRoom

Opcode `0x0004` · client → server

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |

### UserLeft

Opcode `0x0004` · server → client

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `room_id` | u32 | 4 |  |
| `user_id` | u32 | 4 |  |

## Structs

### User

A user as seen by other users.

| Field | Type | Size (bytes) | Description |
| --- | --- | --- | --- |
| `id` | u32 | 4 |  |
| `nickname` | string (u8 length) | 1 + n |  |
| `level` | u8 | 1 |  |

## Enums

### LoginStatus

Encoded as `u8`.

Outcome of a login attempt.

| Name | Value |
| --- | --- |
| `OK` | 0 |
| `BAD_PASSWORD` | 1 |
| `BANNED` | 2 |
| `SERVER_FULL` | 3 |

### RoomKind

Encoded as `u8`.

| Name | Value |
| --- | --- |
| `PUBLIC` | 0 |
| `PRIVATE` | 1 |
