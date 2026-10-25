import { readFileSync } from 'node:fs';
import { compile } from '../src/compile.js';
import { PRIMITIVE_SIZES, findEnum, type Field, type Protocol } from '../src/model.js';

export function loadProtocol(relativePath: string): Protocol {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { protocol, diagnostics } = compile(source);
  if (!protocol) throw new Error(JSON.stringify(diagnostics));
  return protocol;
}

export const chatRoom = () => loadProtocol('../examples/chat-room.yaml');
export const allTypes = () => loadProtocol('fixtures/all-types.yaml');
export const bitFields = () => loadProtocol('fixtures/bit-fields.yaml');
export const conditionalFields = () => loadProtocol('fixtures/conditional-fields.yaml');
export const minimal = () => loadProtocol('fixtures/minimal.yaml');

/**
 * The fields that are on the wire when the round-trip tests give every value its maximum or its
 * minimum: bools true or false, integers at their limits and enums at their last or first value.
 */
export function presentFields(
  protocol: Protocol,
  fields: Field[],
  variant: 'max' | 'min',
): Set<Field> {
  const values = new Map<string, bigint>();
  const present = new Set<Field>();
  const max = variant === 'max';
  const enumValue = (name: string) => {
    const { values: members } = findEnum(protocol, name);
    return BigInt((max ? members[members.length - 1]! : members[0]!).value);
  };
  for (const field of fields) {
    const { condition, type } = field;
    if (condition) {
      const value = values.get(condition.field);
      const on =
        value !== undefined &&
        (condition.kind === 'true'
          ? value !== 0n
          : condition.values.some((v) => BigInt(v) === value));
      if (!on) continue;
    }
    present.add(field);
    if (type.kind === 'bits') {
      for (const bit of type.fields) {
        const value =
          bit.type.kind === 'enum'
            ? enumValue(bit.type.name)
            : max
              ? (1n << BigInt(bit.bits)) - 1n
              : 0n;
        values.set(bit.name, value);
      }
    } else if (type.kind === 'enum') {
      values.set(field.name, enumValue(type.name));
    } else if (type.kind === 'primitive' && type.name === 'bool') {
      values.set(field.name, max ? 1n : 0n);
    } else if (type.kind === 'primitive' && !type.name.startsWith('f')) {
      const bits = BigInt(PRIMITIVE_SIZES[type.name] * 8);
      const signed = type.name.startsWith('i');
      const value = signed
        ? max
          ? (1n << (bits - 1n)) - 1n
          : -(1n << (bits - 1n))
        : max
          ? (1n << bits) - 1n
          : 0n;
      values.set(field.name, value);
    }
  }
  return present;
}
