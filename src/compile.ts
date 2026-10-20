import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import {
  DEFAULT_LENGTH_TYPE,
  INT_RANGES,
  PRIMITIVE_SIZES,
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

export interface CompileResult {
  /** Present only when there are no diagnostics. */
  protocol?: Protocol;
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
  return diagnostics.length > 0 ? { diagnostics } : { protocol, diagnostics };
}

export function formatDiagnostic(file: string, diagnostic: Diagnostic): string {
  return `${file}:${diagnostic.line}:${diagnostic.column}: error: ${diagnostic.message}`;
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  private readonly declared = new Map<string, { kind: string; node: Node }>();
  private readonly enumNames = new Set<string>();
  private readonly structNodes = new Map<string, Node>();

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
    const structs = [...structEntries].map(([n, e]) => this.struct(n, e));
    const packets = this.packets(packetItems, opcode);
    this.checkStructCycles(structs);

    return { name: name ?? '', version, endian, opcode, doc, enums, structs, packets };
  }

  private version(entry: Entry | undefined): string | undefined {
    if (!entry) return undefined;
    const value = isScalar(entry.value) ? entry.value.value : undefined;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
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
    const previous = this.declared.get(name);
    if (previous) {
      this.error(
        node,
        `'${name}' is already defined as ${previous.kind} at line ${this.line(previous.node)}`,
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
      values.push({ name: valueName, value });
    }
    return type ? { name, type, doc, values } : undefined;
  }

  private struct(name: string, entry: Entry): Struct {
    const owner = entry.value ?? entry.key;
    const entries = this.entries(owner, `struct '${name}'`, ['doc', 'fields']);
    const doc = this.optionalString(entries?.get('doc'), "'doc'");
    const fieldsEntry = entries && this.require(entries, 'fields', owner, `struct '${name}'`);
    const fields = fieldsEntry ? this.fields(fieldsEntry) : [];
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
      const fields = fieldsEntry ? this.fields(fieldsEntry) : [];
      if (declared && name !== undefined && opcode !== undefined && direction) {
        packets.push({ name, opcode, direction, doc, fields });
      }
    }
    return packets;
  }

  private fields(entry: Entry): Field[] {
    if (!isSeq(entry.value)) {
      this.error(entry.value ?? entry.key, "'fields' must be a list");
      return [];
    }
    const fields: Field[] = [];
    const seen = new Map<string, string>();
    for (const item of entry.value.items as Node[]) {
      const field = this.field(item);
      if (!field) continue;
      // Generators convert names to their language's convention, so `room_id` and `roomId` clash.
      const normalized = field.field.name.replace(/_/g, '').toLowerCase();
      const previous = seen.get(normalized);
      if (previous === field.field.name) {
        this.error(field.nameNode, `duplicate field '${previous}'`);
      } else if (previous !== undefined) {
        this.error(
          field.nameNode,
          `field '${field.field.name}' clashes with '${previous}' once converted to camelCase`,
        );
      }
      seen.set(normalized, field.field.name);
      fields.push(field.field);
    }
    return fields;
  }

  private field(item: Node): { field: Field; nameNode: Node } | undefined {
    const entries = this.entries(item, 'field', ['name', 'type', 'length', 'size', 'doc']);
    if (!entries) return undefined;
    const nameEntry = this.require(entries, 'name', item, 'field');
    const name = nameEntry && this.string(nameEntry, 'field name');
    const validName = name !== undefined && IDENTIFIER.test(name) && FIELD_NAME_START.test(name);
    if (nameEntry && name !== undefined && !IDENTIFIER.test(name)) {
      this.error(nameEntry.value, `field name '${name}' is not a valid identifier`);
    } else if (nameEntry && name !== undefined && !validName) {
      this.error(
        nameEntry.value,
        `field name '${name}' must start with a letter once leading underscores are dropped for camelCase`,
      );
    }
    const typeEntry = this.require(entries, 'type', item, name ? `field '${name}'` : 'field');
    const type = typeEntry && this.fieldType(typeEntry, entries);
    const doc = this.optionalString(entries.get('doc'), "'doc'");
    if (!nameEntry || name === undefined || !validName || !type) return undefined;
    return { field: { name, type, doc }, nameNode: nameEntry.value ?? nameEntry.key };
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

  private line(node: Node): number {
    return this.lines.linePos(node.range?.[0] ?? 0).line;
  }
}
