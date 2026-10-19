export type Endian = 'little' | 'big';
export type Direction = 'c2s' | 's2c';
export type OpcodeType = 'u8' | 'u16';
export type LengthType = 'u8' | 'u16' | 'u32';
export type IntType = 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64';
export type EnumBaseType = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32';
export type PrimitiveType = IntType | 'f32' | 'f64' | 'bool';

export type ElementType =
  | { kind: 'primitive'; name: PrimitiveType }
  | { kind: 'string'; length: LengthType }
  | { kind: 'bytes'; length: LengthType }
  | { kind: 'fixedBytes'; size: number }
  | { kind: 'struct'; name: string }
  | { kind: 'enum'; name: string };

export type FieldType =
  | ElementType
  | { kind: 'array'; element: ElementType; length: LengthType }
  | { kind: 'fixedArray'; element: ElementType; size: number };

export interface Field {
  name: string;
  type: FieldType;
  doc?: string;
}

export interface Struct {
  name: string;
  doc?: string;
  fields: Field[];
}

export interface EnumValue {
  name: string;
  value: number;
}

export interface Enum {
  name: string;
  type: EnumBaseType;
  doc?: string;
  values: EnumValue[];
}

export interface Packet {
  name: string;
  opcode: number;
  direction: Direction;
  doc?: string;
  fields: Field[];
}

export interface Protocol {
  name: string;
  version?: string;
  endian: Endian;
  opcode: OpcodeType;
  doc?: string;
  enums: Enum[];
  structs: Struct[];
  packets: Packet[];
}

export const PRIMITIVE_SIZES: Record<PrimitiveType, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  f32: 4,
  f64: 8,
  bool: 1,
};

export const INT_RANGES: Record<EnumBaseType | OpcodeType, readonly [number, number]> = {
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffffffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x80000000, 0x7fffffff],
};

export const DEFAULT_LENGTH_TYPE: LengthType = 'u16';

export interface WireSize {
  /** Smallest possible encoding, with every string, bytes and prefixed array empty. */
  min: number;
  fixed: boolean;
}

export function wireSize(type: FieldType, protocol: Protocol): WireSize {
  switch (type.kind) {
    case 'primitive':
      return { min: PRIMITIVE_SIZES[type.name], fixed: true };
    case 'string':
    case 'bytes':
      return { min: PRIMITIVE_SIZES[type.length], fixed: false };
    case 'fixedBytes':
      return { min: type.size, fixed: true };
    case 'enum':
      return { min: PRIMITIVE_SIZES[findEnum(protocol, type.name).type], fixed: true };
    case 'struct':
      return fieldsSize(findStruct(protocol, type.name).fields, protocol);
    case 'array':
      return { min: PRIMITIVE_SIZES[type.length], fixed: false };
    case 'fixedArray': {
      const element = wireSize(type.element, protocol);
      return { min: element.min * type.size, fixed: element.fixed };
    }
  }
}

export function fieldsSize(fields: Field[], protocol: Protocol): WireSize {
  let min = 0;
  let fixed = true;
  for (const field of fields) {
    const size = wireSize(field.type, protocol);
    min += size.min;
    fixed &&= size.fixed;
  }
  return { min, fixed };
}

export function findStruct(protocol: Protocol, name: string): Struct {
  const found = protocol.structs.find((s) => s.name === name);
  if (!found) throw new Error(`unknown struct ${name}`);
  return found;
}

export function findEnum(protocol: Protocol, name: string): Enum {
  const found = protocol.enums.find((e) => e.name === name);
  if (!found) throw new Error(`unknown enum ${name}`);
  return found;
}
