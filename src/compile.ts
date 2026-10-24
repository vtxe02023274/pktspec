import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Scalar } from 'yaml';
import {
  DEFAULT_LENGTH_TYPE,
  INT_RANGES,
  PRIMITIVE_SIZES,
  type BitField,
  type BitFieldType,
  type BitsBaseType,
  type Condition,
  type Direction,
  type ElementType,
  type Endian,
  type Enum,
  type EnumBaseType,
  type Field,
  type FieldType,
  type LengthType,
  type OpcodeType,
  type Packet,
  type PrimitiveType,
  type Protocol,
  type Struct,
} from './model.js';
import { hex } from './gen/common.js';

export interface Diagnostic {
  line: number;
  column: number;
  message: string;
}

export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * Where each declaration sits in the source, keyed like `packet:Say`, `packet:Say/field:text`,
 * `struct:User/field:id`, `enum:RoomKind/value:PUBLIC`; the protocol header keys are `protocol`,
 * `protocol:endian` and `protocol:opcode`. Packets also have `/opcode` and `/direction`.
 */
export type Locations = Map<string, SourcePosition>;

export interface CompileResult {
  /** Present only when there are no diagnostics. */
  protocol?: Protocol;
  /** Present together with `protocol`. */
  locations?: Locations;
  diagnostics: Diagnostic[];
}

interface Entry {
  key: Node;
  value: Node | null;
}

type Entries = Map<string, Entry>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Generators drop underscores when converting field names, so `_1st` would become `1st`.
const FIELD_NAME_START = /^_*[A-Za-z]/;
const PROTOCOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TYPE_EXPRESSION = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d*)\])?$/;

const LENGTH_TYPES: readonly LengthType[] = ['u8', 'u16', 'u32'];
const OPCODE_TYPES: readonly OpcodeType[] = ['u8', 'u16'];
const ENUM_TYPES: readonly EnumBaseType[] = ['u8', 'u16', 'u32', 'i8', 'i16', 'i32'];
const BITS_BASE_TYPES: readonly BitsBaseType[] = ['u8', 'u16', 'u32'];
const ENDIANS: readonly Endian[] = ['little', 'big'];
const DIRECTIONS: readonly Direction[] = ['c2s', 's2c'];
const BUILTIN_TYPES = [...Object.keys(PRIMITIVE_SIZES), 'string', 'bytes'];

export function compile(source: string): CompileResult {
  const lines = new LineCounter();
  const document = parseDocument(source, { lineCounter: lines, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      diagnostics: document.errors.map((error) => ({
        line: error.linePos?.[0].line ?? 1,
        column: error.linePos?.[0].col ?? 1,
        message: error.message.replace(/ at line \d+, column \d+[\s\S]*$/, ''),
      })),
    };
  }
  const compiler = new Compiler(lines);
  const protocol = compiler.protocol(document.contents);
  const diagnostics = compiler.diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  return diagnostics.length > 0
    ? { diagnostics }
    : { protocol, locations: compiler.locations, diagnostics };
}

export function formatDiagnostic(file: string, diagnostic: Diagnostic): string {
  return `${file}:${diagnostic.line}:${diagnostic.column}: error: ${diagnostic.message}`;
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  readonly locations: Locations = new Map();
  private readonly declared = new Map<string, { kind: string; node: Node }>();
  private readonly enumNames = new Set<string>();
  private readonly structNodes = new Map<string, Node>();
  private readonly enums = new Map<string, Enum>();
  private readonly bitNodes = new Map<BitField, Node>();

  constructor(private readonly lines: LineCounter) {}

  protocol(root: Node | null): Protocol | undefined {
    const entries = this.entries(root, 'protocol', [
      'name',
      'version',
      'endian',
      'opcode',
      'doc',
      'enums',
      'structs',
      'packets',
    ]);
    if (!root || !entries) return undefined;

    this.locations.set('protocol', this.position(root));
    for (const key of ['endian', 'opcode']) {
      const entry = entries.get(key);
      if (entry) this.locations.set(`protocol:${key}`, this.position(entry.value ?? entry.key));
    }
    const nameEntry = this.require(entries, 'name', root, 'protocol');
    const name = nameEntry && this.string(nameEntry, "'name'");
    if (nameEntry && name !== undefined && !PROTOCOL_NAME.test(name)) {
      this.error(
        nameEntry.value,
        `protocol name '${name}' must start with a letter and contain only letters, digits, '-' and '_'`,
      );
    }
    const version = this.version(entries.get('version'));
    const endian = this.oneOf(entries.get('endian'), "'endian'", ENDIANS) ?? 'little';
    const opcode = this.oneOf(entries.get('opcode'), "'opcode'", OPCODE_TYPES) ?? 'u16';
    const doc = this.optionalString(entries.get('doc'), "'doc'");

    // Every type name is registered before any field is read, so declaration order does not matter.
    const enumEntries = this.section(entries.get('enums'), 'enums', 'enum');
    const structEntries = this.section(entries.get('structs'), 'structs', 'struct');
    for (const enumName of enumEntries.keys()) this.enumNames.add(enumName);
    for (const [structName, entry] of structEntries) this.structNodes.set(structName, entry.key);

    const packetItems = this.packetItems(entries.get('packets'));
    const enums = [...enumEntries].flatMap(([n, e]) => this.enumDefinition(n, e) ?? []);
    // Bit fields check that every value of their enum fits, so enums are read first.
    for (const definition of enums) this.enums.set(definition.name, definition);
    const structs = [...structEntries].map(([n, e]) => this.struct(n, e));
    const packets = this.packets(packetItems, opcode);
    this.checkStructCycles(structs);

    return { name: name ?? '', version, endian, opcode, doc, enums, structs, packets };
  }

  private version(entry: Entry | undefined): string | undefined {
    if (!entry) return undefined;
    const value = isScalar(entry.value) ? entry.value.value : undefined;
    if (typeof value === 'string') return value;
    // The parsed number would turn 1.10 into 1.1, so an unquoted version keeps its text.
    if (typeof value === 'number') return (entry.value as Scalar).source ?? String(value);
    this.error(entry.value ?? entry.key, "'version' must be a string or a number");
    return undefined;
  }

  private section(entry: Entry | undefined, what: string, kind: string): Entries {
    const result: Entries = new Map();
    if (!entry) return result;
    const entries = this.entries(entry.value ?? entry.key, `'${what}'`, null);
    for (const [name, item] of entries ?? []) {
      if (this.declare(name, kind, item.key)) result.set(name, item);
    }
    return result;
  }

  private declare(name: string, kind: string, node: Node): boolean {
    if (!IDENTIFIER.test(name)) {
      this.error(node, `${kind} name '${name}' is not a valid identifier`);
      return false;
    }
    if (BUILTIN_TYPES.includes(name)) {
      this.error(node, `${kind} name '${name}' is a built-in type`);
      return false;
    }
    // Type names become class names, which must not collide with keywords or field names.
    if (!/^[A-Z]/.test(name)) {
      this.error(node, `${kind} name '${name}' must start with an uppercase letter`);
      return false;
    }
    const previous = this.declared.get(name);
    if (previous) {
      this.error(
        node,
        `'${name}' is already defined as ${previous.kind} at line ${this.line(previous.node)}`,
      );
      return false;
    }
    // Case-insensitive file systems would let one generated file overwrite the other.
    const sameFile = [...this.declared].find(
      ([other]) => other.toLowerCase() === name.toLowerCase(),
    );
    if (sameFile) {
      const [other, { kind: otherKind, node: otherNode }] = sameFile;
      this.error(
        node,
        `'${name}' differs only in case from ${otherKind} '${other}' at line ${this.line(otherNode)}; names are used as file names`,
      );
      return false;
    }
    this.declared.set(name, { kind, node });
    return true;
  }

  private enumDefinition(name: string, entry: Entry): Enum | undefined {
    const owner = entry.value ?? entry.key;
    const entries = this.entries(owner, `enum '${name}'`, ['type', 'doc', 'values']);
    if (!entries) return undefined;
    const typeEntry = this.require(entries, 'type', owner, `enum '${name}'`);
    const type = typeEntry && this.oneOf(typeEntry, `type of enum '${name}'`, ENUM_TYPES);
    this.locations.set(`enum:${name}`, this.position(entry.key));
    if (typeEntry) this.locations.set(`enum:${name}/type`, this.position(typeEntry.value));
    const doc = this.optionalString(entries.get('doc'), "'doc'");
    const valuesEntry = this.require(entries, 'values', owner, `enum '${name}'`);
    if (!valuesEntry) return undefined;

    const valuesNode = valuesEntry.value ?? valuesEntry.key;
    const items = this.entries(valuesNode, `values of enum '${name}'`, null);
    if (!items) return undefined;
    if (items.size === 0) this.error(valuesNode, `enum '${name}' has no values`);

    const values = [];
    const seen = new Map<number, string>();
    for (const [valueName, item] of items) {
      if (!IDENTIFIER.test(valueName)) {
        this.error(item.key, `enum value name '${valueName}' is not a valid identifier`);
        continue;
      }
      const value = this.integer(item, `value of '${name}.${valueName}'`);
      if (value === undefined) continue;
      if (type) {
        const [min, max] = INT_RANGES[type];
        if (value < min || value > max) {
          this.error(item.value, `${value} does not fit in ${type} (${min}..${max})`);
        }
      }
      const duplicate = seen.get(value);
      if (duplicate !== undefined) {
        this.error(item.value, `value ${value} is already used by '${name}.${duplicate}'`);
      }
      seen.set(value, valueName);
      this.locations.set(`enum:${name}/value:${valueName}`, this.position(item.key));
      values.push({ name: valueName, value });
    }
    return type ? { name, type, doc, values } : undefined;
  }

  private struct(name: string, entry: Entry): Struct {
    const owner = entry.value ?? entry.key;
    const entries = this.entries(owner, `struct '${name}'`, ['doc', 'fields']);
    const doc = this.optionalString(entries?.get('doc'), "'doc'");
    const fieldsEntry = entries && this.require(entries, 'fields', owner, `struct '${name}'`);
    const fields = fieldsEntry ? this.fields(fieldsEntry, `struct:${name}`) : [];
    this.locations.set(`struct:${name}`, this.position(entry.key));
    return { name, doc, fields };
  }

  private packetItems(entry: Entry | undefined): Node[] {
    if (!entry) return [];
    if (!isSeq(entry.value)) {
      this.error(entry.value ?? entry.key, "'packets' must be a list");
      return [];
    }
    return entry.value.items as Node[];
  }

  private packets(items: Node[], opcodeType: OpcodeType): Packet[] {
    const opcodes = new Map<string, { name: string; node: Node }>();
    const packets: Packet[] = [];
    for (const item of items) {
      const entries = this.entries(item, 'packet', [
        'name',
        'opcode',
        'direction',
        'doc',
        'fields',
      ]);
      if (!entries) continue;
      const nameEntry = this.require(entries, 'name', item, 'packet');
      const name = nameEntry && this.string(nameEntry, 'packet name');
      const what = name ? `packet '${name}'` : 'packet';
      const declared =
        nameEntry &&
        name !== undefined &&
        this.declare(name, 'packet', nameEntry.value ?? nameEntry.key);

      const opcodeEntry = this.require(entries, 'opcode', item, what);
      const opcode = opcodeEntry && this.integer(opcodeEntry, `opcode of ${what}`);
      if (opcodeEntry && opcode !== undefined) {
        const [min, max] = INT_RANGES[opcodeType];
        if (opcode < min || opcode > max) {
          this.error(opcodeEntry.value, `opcode ${hex(opcode)} does not fit in ${opcodeType}`);
        }
      }

      const directionEntry = this.require(entries, 'direction', item, what);
      const direction =
        directionEntry && this.oneOf(directionEntry, `direction of ${what}`, DIRECTIONS);
      if (opcodeEntry && opcode !== undefined && direction) {
        const key = `${direction}:${opcode}`;
        const previous = opcodes.get(key);
        if (previous) {
          this.error(
            opcodeEntry.value,
            `opcode ${hex(opcode)} (${direction}) is already used by '${previous.name}' at line ${this.line(previous.node)}`,
          );
        } else {
          opcodes.set(key, { name: name ?? '', node: opcodeEntry.value ?? opcodeEntry.key });
        }
      }

      const doc = this.optionalString(entries.get('doc'), "'doc'");
      const fieldsEntry = entries.get('fields');
      const fields = fieldsEntry ? this.fields(fieldsEntry, `packet:${name}`) : [];
      if (name !== undefined) {
        const base = `packet:${name}`;
        this.locations.set(base, this.position(nameEntry?.value ?? item));
        this.locations.set(`${base}/opcode`, this.position(opcodeEntry?.value ?? item));
        this.locations.set(`${base}/direction`, this.position(directionEntry?.value ?? item));
      }
      if (declared && name !== undefined && opcode !== undefined && direction) {
        packets.push({ name, opcode, direction, doc, fields });
      }
    }
    return packets;
  }

  private fields(entry: Entry, owner: string): Field[] {
    if (!isSeq(entry.value)) {
      this.error(entry.value ?? entry.key, "'fields' must be a list");
      return [];
    }
    const fields: Field[] = [];
    const seen = new Map<string, string>();
    // Generators convert names to their language's convention, so `room_id` and `roomId` clash.
    const claim = (name: string, node: Node) => {
      const normalized = name.replace(/_/g, '').toLowerCase();
      const previous = seen.get(normalized);
      if (previous === name) {
        this.error(node, `duplicate field '${previous}'`);
      } else if (previous !== undefined) {
        this.error(node, `field '${name}' clashes with '${previous}' once converted to camelCase`);
      }
      seen.set(normalized, name);
    };
    // Names of every field so far, including ones that did not compile, so a condition on a
    // broken field does not add a second error.
    const names: string[] = [];
    const items = entry.value.items as Node[];
    const declared = items.map((item) => this.declaredNames(item));
    for (const [index, item] of items.entries()) {
      const field = this.field(item);
      const later = new Set(declared.slice(index + 1).flat());
      const condition =
        field.ifEntry && field.name !== undefined
          ? this.condition(field.ifEntry, declared[index]!, fields, names, later)
          : undefined;
      names.push(...declared[index]!);
      if (!field.field || (field.ifEntry && !condition)) continue;
      const { name, type } = field.field;
      if (condition) field.field.condition = condition;
      claim(name, field.nameNode!);
      this.locations.set(`${owner}/field:${name}`, this.position(field.nameNode));
      if (field.ifEntry) {
        this.locations.set(`${owner}/field:${name}/if`, this.position(field.ifEntry.value));
      }
      // Bit fields become members next to the other fields, so they share one namespace.
      for (const bit of type.kind === 'bits' ? type.fields : []) {
        const node = this.bitNodes.get(bit)!;
        claim(bit.name, node);
        this.locations.set(`${owner}/field:${name}/bit:${bit.name}`, this.position(node));
      }
      fields.push(field.field);
    }
    return fields;
  }

  /** The name of a field and of its bit fields, read without checking them. */
  private declaredNames(item: Node): string[] {
    const get = (node: unknown, key: string): unknown =>
      isMap(node)
        ? node.items.find((pair) => isScalar(pair.key) && pair.key.value === key)?.value
        : undefined;
    const nameOf = (node: unknown): string[] => {
      const name = get(node, 'name');
      return isScalar(name) && typeof name.value === 'string' ? [name.value] : [];
    };
    const bits = get(item, 'bits');
    return [...nameOf(item), ...(isSeq(bits) ? bits.items.flatMap(nameOf) : [])];
  }

  private field(item: Node): {
    field?: Field;
    name?: string;
    nameNode?: Node;
    ifEntry?: Entry;
  } {
    const entries = this.entries(item, 'field', [
      'name',
      'type',
      'length',
      'size',
      'bits',
      'if',
      'doc',
    ]);
    if (!entries) return {};
    const nameEntry = this.require(entries, 'name', item, 'field');
    const name = nameEntry && this.fieldName(nameEntry, 'field');
    const typeEntry = this.require(entries, 'type', item, name ? `field '${name}'` : 'field');
    const bitsEntry = entries.get('bits');
    const type =
      typeEntry &&
      (bitsEntry
        ? this.bitsType(typeEntry, bitsEntry, entries)
        : this.fieldType(typeEntry, entries));
    const doc = this.optionalString(entries.get('doc'), "'doc'");
    const ifEntry = entries.get('if');
    const nameNode = nameEntry && (nameEntry.value ?? nameEntry.key);
    if (!nameEntry || name === undefined || !type) return { name, nameNode, ifEntry };
    return { field: { name, type, doc }, name, nameNode, ifEntry };
  }

  /**
   * Reads `if: flag`, `if: { field: kind, equals: A }` or `if: { field: kind, in: [A, B] }`.
   * `own` is the name of the field followed by its bit fields; `earlier` holds the fields before
   * it, `names` also the ones that did not compile, and `later` the ones after it.
   */
  private condition(
    entry: Entry,
    own: string[],
    earlier: Field[],
    names: string[],
    later: Set<string>,
  ): Condition | undefined {
    const node = entry.value ?? entry.key;
    let targetName: string | undefined;
    let targetNode: Node = node;
    let valueEntry: Entry | undefined;
    let list = false;
    if (isScalar(entry.value) && typeof entry.value.value === 'string') {
      targetName = this.string(entry, "'if'");
    } else if (isMap(entry.value)) {
      const entries = this.entries(entry.value, 'condition', ['field', 'equals', 'in']);
      if (!entries) return undefined;
      const fieldEntry = this.require(entries, 'field', entry.value, 'condition');
      targetName = fieldEntry && this.string(fieldEntry, "condition 'field'");
      if (fieldEntry?.value) targetNode = fieldEntry.value;
      const equals = entries.get('equals');
      const among = entries.get('in');
      if (equals && among) {
        this.error(among.key, "'equals' and 'in' cannot be combined");
        return undefined;
      }
      valueEntry = equals ?? among;
      list = among !== undefined;
      if (!valueEntry) {
        this.error(entry.value, "condition is missing 'equals' or 'in'");
        return undefined;
      }
    } else {
      this.error(node, "'if' must be a field name, or a mapping with 'field' and 'equals' or 'in'");
      return undefined;
    }
    if (targetName === undefined) return undefined;

    const owner = own[0]!;
    if (targetName === owner) {
      this.error(targetNode, `field '${owner}' cannot be its own condition`);
      return undefined;
    }
    if (own.includes(targetName)) {
      this.error(targetNode, `field '${owner}' cannot test its own bit field '${targetName}'`);
      return undefined;
    }
    let target: { type: FieldType } | { bit: BitField } | undefined;
    for (const field of earlier) {
      if (field.name === targetName) target = { type: field.type };
      for (const bit of field.type.kind === 'bits' ? field.type.fields : []) {
        if (bit.name === targetName) target = { bit };
      }
    }
    if (!target) {
      if (later.has(targetName)) {
        this.error(
          targetNode,
          `condition of field '${owner}' refers to '${targetName}', which comes after it; a condition can only test earlier fields`,
        );
      } else if (!names.includes(targetName)) {
        const suggestion = names.find((n) => n.toLowerCase() === targetName.toLowerCase());
        this.error(
          targetNode,
          `condition of field '${owner}' refers to unknown field '${targetName}'` +
            (suggestion ? `; did you mean '${suggestion}'?` : ''),
        );
      }
      return undefined;
    }

    const kind = this.conditionKind(target);
    const what = `'${targetName}'`;
    if (kind.kind === 'group') {
      this.error(targetNode, `${what} is a group of bit fields; test one of its bit fields`);
      return undefined;
    }
    if (kind.kind === 'other') {
      this.error(
        targetNode,
        `condition field ${what} must be a bool, an integer or an enum, not ${kind.text}`,
      );
      return undefined;
    }
    if (kind.kind === 'bool') {
      if (valueEntry) {
        this.error(valueEntry.key, `${what} is a bool; write 'if: ${targetName}' to test it`);
        return undefined;
      }
      return { kind: 'true', field: targetName };
    }
    if (!valueEntry) {
      this.error(
        node,
        `${what} is ${kind.kind === 'enum' ? 'an enum' : 'an integer'}; give the values to match with 'equals' or 'in'`,
      );
      return undefined;
    }

    let valueNodes: (Node | null)[];
    if (list) {
      if (!isSeq(valueEntry.value) || valueEntry.value.items.length === 0) {
        this.error(valueEntry.value ?? valueEntry.key, "'in' must be a non-empty list");
        return undefined;
      }
      valueNodes = valueEntry.value.items as Node[];
    } else {
      valueNodes = [valueEntry.value];
    }
    const values: number[] = [];
    let ok = true;
    for (const valueNode of valueNodes) {
      const value = this.conditionValue(valueNode ?? valueEntry.key, kind);
      if (value === undefined) {
        ok = false;
      } else if (values.includes(value)) {
        const raw = isScalar(valueNode) ? valueNode.value : value;
        const text = typeof raw === 'string' ? `'${raw}'` : String(raw);
        this.error(valueNode ?? valueEntry.key, `${text} is listed twice in the condition`);
        ok = false;
      } else {
        values.push(value);
      }
    }
    return ok ? { kind: 'in', field: targetName, values } : undefined;
  }

  private conditionKind(
    target: { type: FieldType } | { bit: BitField },
  ):
    | { kind: 'bool' }
    | { kind: 'group' }
    | { kind: 'int'; min: number; max: number; range: string }
    | { kind: 'enum'; definition: Enum | undefined }
    | { kind: 'other'; text: string } {
    if ('bit' in target) {
      const { bit } = target;
      if (bit.type.kind === 'bool') return { kind: 'bool' };
      if (bit.type.kind === 'enum') {
        return { kind: 'enum', definition: this.enums.get(bit.type.name) };
      }
      const max = 2 ** bit.bits - 1;
      return { kind: 'int', min: 0, max, range: `${bit.bits} bits (0..${max})` };
    }
    const field = target.type;
    switch (field.kind) {
      case 'bits':
        return { kind: 'group' };
      case 'enum':
        return { kind: 'enum', definition: this.enums.get(field.name) };
      case 'primitive': {
        if (field.name === 'bool') return { kind: 'bool' };
        if (field.name === 'f32' || field.name === 'f64') {
          return { kind: 'other', text: field.name };
        }
        // 64-bit values are kept to the integers a JavaScript number holds exactly.
        const [min, max] =
          field.name === 'u64'
            ? [0, Number.MAX_SAFE_INTEGER]
            : field.name === 'i64'
              ? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
              : INT_RANGES[field.name];
        return { kind: 'int', min, max, range: `${field.name} (${min}..${max})` };
      }
      case 'string':
      case 'bytes':
      case 'fixedBytes':
        return { kind: 'other', text: field.kind === 'string' ? 'string' : 'bytes' };
      case 'struct':
        return { kind: 'other', text: `struct '${field.name}'` };
      case 'array':
      case 'fixedArray':
        return { kind: 'other', text: 'an array' };
    }
  }

  private conditionValue(
    node: Node,
    kind:
      | { kind: 'int'; min: number; max: number; range: string }
      | { kind: 'enum'; definition: Enum | undefined },
  ): number | undefined {
    const value = isScalar(node) ? node.value : undefined;
    if (kind.kind === 'enum') {
      // The enum itself failed to compile and has its own error.
      if (!kind.definition) return undefined;
      const member = kind.definition.values.find((v) => v.name === value);
      if (typeof value !== 'string' || !member) {
        const names = kind.definition.values.map((v) => v.name).join(', ');
        this.error(
          node,
          `${typeof value === 'string' ? `'${value}'` : String(value)} is not a value of enum '${kind.definition.name}'; expected one of: ${names}`,
        );
        return undefined;
      }
      return member.value;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.error(node, 'condition value must be an integer');
      return undefined;
    }
    if (value < kind.min || value > kind.max) {
      this.error(node, `${value} does not fit in ${kind.range}`);
      return undefined;
    }
    return value;
  }

  /** Returns the name of a field or bit field, or undefined after reporting why it is unusable. */
  private fieldName(entry: Entry, what: string): string | undefined {
    const name = this.string(entry, `${what} name`);
    if (name === undefined) return undefined;
    if (!IDENTIFIER.test(name)) {
      this.error(entry.value, `${what} name '${name}' is not a valid identifier`);
      return undefined;
    }
    if (!FIELD_NAME_START.test(name)) {
      this.error(
        entry.value,
        `${what} name '${name}' must start with a letter once leading underscores are dropped for camelCase`,
      );
      return undefined;
    }
    return name;
  }

  private bitsType(typeEntry: Entry, bitsEntry: Entry, entries: Entries): FieldType | undefined {
    for (const key of ['length', 'size']) {
      const entry = entries.get(key);
      if (entry) this.error(entry.key, `'${key}' does not apply to bit fields`);
    }
    const text = this.string(typeEntry, "'type'");
    let base: BitsBaseType | undefined;
    if (text !== undefined && TYPE_EXPRESSION.exec(text)?.[2] !== undefined) {
      this.error(
        typeEntry.value,
        'bit fields cannot be arrays; wrap them in a struct and use an array of the struct',
      );
    } else if (text !== undefined && !(BITS_BASE_TYPES as readonly string[]).includes(text)) {
      this.error(
        typeEntry.value,
        `bit fields must be stored in one of: ${BITS_BASE_TYPES.join(', ')}`,
      );
    } else if (text !== undefined) {
      base = text as BitsBaseType;
    }

    if (!isSeq(bitsEntry.value)) {
      this.error(bitsEntry.value ?? bitsEntry.key, "'bits' must be a list");
      return undefined;
    }
    const items = bitsEntry.value.items as Node[];
    if (items.length === 0) this.error(bitsEntry.value, "'bits' must list at least one field");
    const fields = items.flatMap((item) => this.bitField(item) ?? []);
    const used = fields.reduce((sum, field) => sum + field.bits, 0);
    const width = base && PRIMITIVE_SIZES[base] * 8;
    if (width !== undefined && used > width) {
      this.error(
        typeEntry.value,
        `bit fields take ${used} bits, more than the ${width} bits of ${base}`,
      );
    }
    if (!base || fields.length !== items.length || items.length === 0) return undefined;
    return { kind: 'bits', base, fields };
  }

  private bitField(item: Node): BitField | undefined {
    const entries = this.entries(item, 'bit field', ['name', 'type', 'bits', 'doc']);
    if (!entries) return undefined;
    const nameEntry = this.require(entries, 'name', item, 'bit field');
    const name = nameEntry && this.fieldName(nameEntry, 'bit field');
    const what = name ? `bit field '${name}'` : 'bit field';
    const typeEntry = entries.get('type');
    const type: BitFieldType | undefined = typeEntry
      ? this.bitFieldType(typeEntry)
      : { kind: 'uint' };
    const bitsEntry = entries.get('bits');
    const doc = this.optionalString(entries.get('doc'), "'doc'");

    let bits: number | undefined;
    if (bitsEntry) {
      bits = this.positiveInteger(bitsEntry, `'bits' of ${what}`);
    } else if (type?.kind === 'bool') {
      bits = 1;
    } else if (type) {
      this.error(item, `${what} is missing 'bits'`);
    }
    if (type?.kind === 'bool' && bitsEntry && bits !== undefined && bits !== 1) {
      this.error(bitsEntry.value, 'a bool bit field takes exactly 1 bit');
      bits = undefined;
    }
    if (type?.kind === 'enum' && bitsEntry && bits !== undefined) {
      const max = 2 ** bits - 1;
      const outside = this.enums.get(type.name)?.values.find((v) => v.value < 0 || v.value > max);
      if (outside) {
        this.error(
          bitsEntry.value,
          `enum '${type.name}' value '${outside.name}' (${outside.value}) does not fit in ${bits} bits (0..${max})`,
        );
        bits = undefined;
      }
    }
    if (!nameEntry || name === undefined || !type || bits === undefined) return undefined;
    const field: BitField = { name, bits, type, doc };
    this.bitNodes.set(field, nameEntry.value ?? nameEntry.key);
    return field;
  }

  private bitFieldType(entry: Entry): BitFieldType | undefined {
    const text = this.string(entry, "'type'");
    if (text === undefined) return undefined;
    if (text === 'bool') return { kind: 'bool' };
    if (this.enumNames.has(text)) return { kind: 'enum', name: text };
    const base = TYPE_EXPRESSION.exec(text)?.[1];
    if (base !== undefined && (BUILTIN_TYPES.includes(base) || this.declared.has(base))) {
      this.error(
        entry.value,
        "bit field type must be bool or an enum; leave out 'type' for an unsigned integer",
      );
      return undefined;
    }
    const suggestion = ['bool', ...this.enumNames].find(
      (name) => name.toLowerCase() === text.toLowerCase(),
    );
    this.error(
      entry.value,
      `unknown type '${text}'` + (suggestion ? `; did you mean '${suggestion}'?` : ''),
    );
    return undefined;
  }

  private fieldType(typeEntry: Entry, entries: Entries): FieldType | undefined {
    const text = this.string(typeEntry, "'type'");
    if (text === undefined) return undefined;
    const match = TYPE_EXPRESSION.exec(text);
    if (!match) {
      this.error(typeEntry.value, `invalid type '${text}'`);
      return undefined;
    }
    const base = match[1]!;
    const suffix = match[2];
    const lengthEntry = entries.get('length');
    const sizeEntry = entries.get('size');
    const length = this.oneOf(lengthEntry, "'length'", LENGTH_TYPES);
    const size = sizeEntry && this.positiveInteger(sizeEntry, "'size'");

    const takesLength =
      suffix === '' || (suffix === undefined && ['string', 'bytes'].includes(base));
    if (lengthEntry && !takesLength) {
      this.error(lengthEntry.key, "'length' only applies to string, bytes and [] arrays");
    }
    if (sizeEntry && (base !== 'bytes' || suffix !== undefined)) {
      this.error(sizeEntry.key, "'size' only applies to bytes");
    } else if (sizeEntry && lengthEntry) {
      this.error(sizeEntry.key, "'length' and 'size' cannot be combined");
    }

    const ownLength = suffix === undefined ? length : undefined;
    const element = this.elementType(base, typeEntry.value, ownLength, size);
    if (!element) return undefined;
    if (suffix === undefined) return element;
    if (element.kind === 'bytes') {
      this.error(typeEntry.value, 'arrays of bytes are not supported; wrap bytes in a struct');
      return undefined;
    }
    if (suffix === '') return { kind: 'array', element, length: length ?? DEFAULT_LENGTH_TYPE };
    const count = Number(suffix);
    if (count <= 0) {
      this.error(typeEntry.value, `array size must be greater than 0`);
      return undefined;
    }
    return { kind: 'fixedArray', element, size: count };
  }

  private elementType(
    base: string,
    node: Node | null,
    length: LengthType | undefined,
    size: number | undefined,
  ): ElementType | undefined {
    if (base in PRIMITIVE_SIZES) return { kind: 'primitive', name: base as PrimitiveType };
    if (base === 'string') return { kind: 'string', length: length ?? DEFAULT_LENGTH_TYPE };
    if (base === 'bytes') {
      return size !== undefined
        ? { kind: 'fixedBytes', size }
        : { kind: 'bytes', length: length ?? DEFAULT_LENGTH_TYPE };
    }
    if (this.enumNames.has(base)) return { kind: 'enum', name: base };
    if (this.structNodes.has(base)) return { kind: 'struct', name: base };
    if (this.declared.get(base)?.kind === 'packet') {
      this.error(node, `'${base}' is a packet; only structs and enums can be used as field types`);
      return undefined;
    }
    const known = [...BUILTIN_TYPES, ...this.enumNames, ...this.structNodes.keys()];
    const suggestion = known.find((name) => name.toLowerCase() === base.toLowerCase());
    this.error(
      node,
      `unknown type '${base}'` + (suggestion ? `; did you mean '${suggestion}'?` : ''),
    );
    return undefined;
  }

  private checkStructCycles(structs: Struct[]): void {
    // Prefixed arrays may be empty, so only direct fields and fixed arrays make a struct infinite.
    const edges = new Map<string, string[]>();
    for (const struct of structs) {
      edges.set(
        struct.name,
        struct.fields.flatMap(({ type }) => {
          if (type.kind === 'struct') return [type.name];
          if (type.kind === 'fixedArray' && type.element.kind === 'struct') {
            return [type.element.name];
          }
          return [];
        }),
      );
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, path: string[]): void => {
      state.set(name, 'visiting');
      for (const next of edges.get(name) ?? []) {
        if (state.get(next) === 'visiting') {
          const cycle = [...path.slice(path.indexOf(next)), next].join(' -> ');
          this.error(this.structNodes.get(next), `struct '${next}' contains itself (${cycle})`);
        } else if (!state.has(next)) {
          visit(next, [...path, next]);
        }
      }
      state.set(name, 'done');
    };
    for (const struct of structs) {
      if (!state.has(struct.name)) visit(struct.name, [struct.name]);
    }
  }

  private entries(
    node: Node | null | undefined,
    what: string,
    allowed: readonly string[] | null,
  ): Entries | undefined {
    if (!isMap(node)) {
      this.error(node, `${what} must be a mapping`);
      return undefined;
    }
    const result: Entries = new Map();
    for (const pair of node.items) {
      const key = pair.key as Node;
      const name = isScalar(key) ? String(key.value) : '';
      if (allowed && !allowed.includes(name)) {
        this.error(key, `unknown key '${name}' in ${what}; expected one of: ${allowed.join(', ')}`);
        continue;
      }
      result.set(name, { key, value: pair.value as Node | null });
    }
    return result;
  }

  private require(entries: Entries, key: string, owner: Node, what: string): Entry | undefined {
    const entry = entries.get(key);
    if (!entry) this.error(owner, `${what} is missing '${key}'`);
    return entry;
  }

  private string(entry: Entry, what: string): string | undefined {
    const value = isScalar(entry.value) ? entry.value.value : undefined;
    if (typeof value === 'string' && value !== '') return value;
    this.error(entry.value ?? entry.key, `${what} must be a non-empty string`);
    return undefined;
  }

  private optionalString(entry: Entry | undefined, what: string): string | undefined {
    return entry && this.string(entry, what);
  }

  private integer(entry: Entry, what: string): number | undefined {
    const value = isScalar(entry.value) ? entry.value.value : undefined;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    this.error(entry.value ?? entry.key, `${what} must be an integer`);
    return undefined;
  }

  private positiveInteger(entry: Entry, what: string): number | undefined {
    const value = this.integer(entry, what);
    if (value === undefined || value > 0) return value;
    this.error(entry.value, `${what} must be greater than 0`);
    return undefined;
  }

  private oneOf<T extends string>(
    entry: Entry | undefined,
    what: string,
    options: readonly T[],
  ): T | undefined {
    if (!entry) return undefined;
    const value = isScalar(entry.value) ? entry.value.value : undefined;
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) {
      return value as T;
    }
    this.error(entry.value ?? entry.key, `${what} must be one of: ${options.join(', ')}`);
    return undefined;
  }

  private error(node: Node | null | undefined, message: string): void {
    const { line, col } = this.lines.linePos(node?.range?.[0] ?? 0);
    this.diagnostics.push({ line, column: col, message });
  }

  private position(node: Node | null | undefined): SourcePosition {
    const { line, col } = this.lines.linePos(node?.range?.[0] ?? 0);
    return { line, column: col };
  }

  private line(node: Node): number {
    return this.lines.linePos(node.range?.[0] ?? 0).line;
  }
}
