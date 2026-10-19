import {
  PRIMITIVE_SIZES,
  fieldsSize,
  wireSize,
  type ElementType,
  type Field,
  type FieldType,
  type Protocol,
} from '../model.js';
import { hex, type GeneratedFile } from './common.js';

const DIRECTIONS = { c2s: 'client → server', s2c: 'server → client' } as const;

export function generateDocs(protocol: Protocol): GeneratedFile[] {
  return [{ path: `${protocol.name}.md`, content: render(protocol) }];
}

function render(protocol: Protocol): string {
  const opcodeDigits = protocol.opcode === 'u8' ? 2 : 4;
  const out: string[] = [];
  const facts = [
    protocol.version !== undefined ? `Version ${protocol.version}` : undefined,
    `${protocol.endian}-endian`,
    `${protocol.opcode} opcode`,
  ].filter((fact) => fact !== undefined);

  out.push(`# ${protocol.name}`, '', facts.join(' · '), '');
  if (protocol.doc) out.push(protocol.doc.trim(), '');
  out.push(
    'Every packet starts with its opcode, followed by the fields below in order.',
    'Strings are UTF-8; their length prefix counts bytes, not characters.',
    '',
  );

  if (protocol.packets.length > 0) {
    out.push(
      '## Packets',
      '',
      '| Opcode | Packet | Direction | Body size |',
      '| --- | --- | --- | --- |',
    );
    for (const packet of protocol.packets) {
      out.push(
        `| ${code(hex(packet.opcode, opcodeDigits))} | ${link(packet.name)} | ${DIRECTIONS[packet.direction]} | ${totalSize(packet.fields, protocol)} |`,
      );
    }
    out.push('');
    for (const packet of protocol.packets) {
      out.push(`### ${packet.name}`, '');
      out.push(
        `Opcode ${code(hex(packet.opcode, opcodeDigits))} · ${DIRECTIONS[packet.direction]}`,
        '',
      );
      if (packet.doc) out.push(packet.doc.trim(), '');
      out.push(...fieldTable(packet.fields, protocol));
    }
  }

  if (protocol.structs.length > 0) {
    out.push('## Structs', '');
    for (const struct of protocol.structs) {
      out.push(`### ${struct.name}`, '');
      if (struct.doc) out.push(struct.doc.trim(), '');
      out.push(...fieldTable(struct.fields, protocol));
    }
  }

  if (protocol.enums.length > 0) {
    out.push('## Enums', '');
    for (const definition of protocol.enums) {
      out.push(`### ${definition.name}`, '', `Encoded as ${code(definition.type)}.`, '');
      if (definition.doc) out.push(definition.doc.trim(), '');
      out.push('| Name | Value |', '| --- | --- |');
      for (const value of definition.values) {
        out.push(`| ${code(value.name)} | ${value.value} |`);
      }
      out.push('');
    }
  }

  return out.join('\n').replace(/\n+$/, '\n');
}

function fieldTable(fields: Field[], protocol: Protocol): string[] {
  if (fields.length === 0) return ['No fields.', ''];
  const rows = fields.map(
    (field) =>
      `| ${code(field.name)} | ${typeName(field.type)} | ${fieldSize(field.type, protocol)} | ${cell(field.doc ?? '')} |`,
  );
  return [
    '| Field | Type | Size (bytes) | Description |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ];
}

function typeName(type: FieldType): string {
  switch (type.kind) {
    case 'array':
      return `${elementName(type.element)}[] (${type.length} count)`;
    case 'fixedArray':
      return `${elementName(type.element)}[${type.size}]`;
    default:
      return elementName(type);
  }
}

function elementName(type: ElementType): string {
  switch (type.kind) {
    case 'primitive':
      return type.name;
    case 'string':
      return `string (${type.length} length)`;
    case 'bytes':
      return `bytes (${type.length} length)`;
    case 'fixedBytes':
      return `bytes (${type.size})`;
    case 'struct':
    case 'enum':
      return link(type.name);
  }
}

function fieldSize(type: FieldType, protocol: Protocol): string {
  const size = wireSize(type, protocol);
  if (size.fixed) return String(size.min);
  switch (type.kind) {
    case 'string':
    case 'bytes':
      return `${PRIMITIVE_SIZES[type.length]} + n`;
    case 'array': {
      const element = wireSize(type.element, protocol);
      const prefix = PRIMITIVE_SIZES[type.length];
      if (!element.fixed) return `${prefix} + variable`;
      return element.min === 1 ? `${prefix} + n` : `${prefix} + ${element.min}n`;
    }
    default:
      return `${size.min}+`;
  }
}

function totalSize(fields: Field[], protocol: Protocol): string {
  const size = fieldsSize(fields, protocol);
  return size.fixed ? String(size.min) : `${size.min}+`;
}

function link(name: string): string {
  return `[${name}](#${name.toLowerCase()})`;
}

function code(text: string): string {
  return `\`${text}\``;
}

function cell(text: string): string {
  return text
    .trim()
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}
