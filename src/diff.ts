import type { Locations, SourcePosition } from './compile.js';
import { hex } from './gen/common.js';
import {
  bitLayout,
  findEnum,
  findStruct,
  memberFields,
  type BitField,
  type BitsType,
  type Condition,
  type Enum,
  type Field,
  type FieldType,
  type Packet,
  type Protocol,
  type Struct,
} from './model.js';

export type Severity = 'breaking' | 'compatible' | 'info';

export const SEVERITIES: readonly Severity[] = ['breaking', 'compatible', 'info'];

export interface Change {
  severity: Severity;
  /** Stable identifier of the rule that produced the change, such as `field-removed`. */
  rule: string;
  subject: 'protocol' | 'packet' | 'struct' | 'enum';
  /** Declaration path, such as `Login`, `Login.name` or `RoomKind.PUBLIC`. */
  path: string;
  message: string;
  /** Packets that carry the changed struct or enum on the wire. */
  usedBy?: string[];
  old?: SourcePosition;
  new?: SourcePosition;
}

export interface Spec {
  protocol: Protocol;
  locations: Locations;
}

/** Compares two valid protocols and lists every difference that matters on the wire. */
export function diffProtocols(before: Spec, after: Spec): Change[] {
  return new Differ(before, after).run();
}

export interface DiffReport {
  old: string;
  new: string;
  breaking: boolean;
  summary: Record<Severity, number>;
  changes: Array<
    Omit<Change, 'old' | 'new'> & { old: SourcePosition | null; new: SourcePosition | null }
  >;
}

export function summarize(changes: Change[]): Record<Severity, number> {
  const summary = { breaking: 0, compatible: 0, info: 0 };
  for (const change of changes) summary[change.severity]++;
  return summary;
}

export function diffReport(oldFile: string, newFile: string, changes: Change[]): DiffReport {
  const summary = summarize(changes);
  return {
    old: oldFile,
    new: newFile,
    breaking: summary.breaking > 0,
    summary,
    changes: changes.map((change) => ({
      ...change,
      old: change.old ?? null,
      new: change.new ?? null,
    })),
  };
}

/** Text report grouped by severity; locations use the same `file:line:column` form as `check`. */
export function formatDiff(oldFile: string, newFile: string, changes: Change[]): string[] {
  const lines: string[] = [];
  const where = (file: string, at: SourcePosition) => `${file}:${at.line}:${at.column}`;
  for (const severity of SEVERITIES) {
    const group = changes.filter((change) => change.severity === severity);
    if (group.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${severity} (${group.length})`);
    for (const change of group) {
      const primary = change.new
        ? where(newFile, change.new)
        : change.old
          ? where(oldFile, change.old)
          : newFile;
      const previous = change.new && change.old ? ` (was ${where(oldFile, change.old)})` : '';
      lines.push(`  ${primary}: ${change.message}${previous}`);
    }
  }
  const summary = summarize(changes);
  if (changes.length === 0) return ['no differences'];
  lines.push(
    '',
    `${summary.breaking} breaking, ${summary.compatible} compatible, ${summary.info} info`,
  );
  return lines;
}

interface Pair<T> {
  before: T;
  after: T;
}

type UsageKey = `struct:${string}` | `enum:${string}`;

class Differ {
  private readonly changes: Change[] = [];
  private readonly oldUsers: Map<UsageKey, Set<string>>;
  private readonly newUsers: Map<UsageKey, Set<string>>;
  // Bit fields only carry the value of an enum, so its underlying type does not reach the wire.
  private readonly oldByteUsers: Map<UsageKey, Set<string>>;
  private readonly newByteUsers: Map<UsageKey, Set<string>>;

  constructor(
    private readonly before: Spec,
    private readonly after: Spec,
  ) {
    this.oldUsers = usage(before.protocol, true);
    this.newUsers = usage(after.protocol, true);
    this.oldByteUsers = usage(before.protocol, false);
    this.newByteUsers = usage(after.protocol, false);
  }

  run(): Change[] {
    this.header();
    this.enums();
    this.structs();
    this.packets();
    return this.changes;
  }

  private header(): void {
    const a = this.before.protocol;
    const b = this.after.protocol;
    const at = (key: string) => this.positions(key, key);
    if (a.endian !== b.endian) {
      this.add(
        'breaking',
        'endian-changed',
        'protocol',
        'protocol.endian',
        `endian changed from ${a.endian} to ${b.endian}`,
        at('protocol:endian'),
      );
    }
    if (a.opcode !== b.opcode) {
      this.add(
        'breaking',
        'opcode-width-changed',
        'protocol',
        'protocol.opcode',
        `opcode width changed from ${a.opcode} to ${b.opcode}`,
        at('protocol:opcode'),
      );
    }
    if (a.name !== b.name) {
      this.add(
        'info',
        'protocol-renamed',
        'protocol',
        'protocol.name',
        `protocol renamed from '${a.name}' to '${b.name}'`,
        at('protocol'),
      );
    }
    if (a.version !== b.version) {
      this.add(
        'info',
        'version-changed',
        'protocol',
        'protocol.version',
        `version changed from ${show(a.version)} to ${show(b.version)}`,
        at('protocol'),
      );
    }
    if (a.doc !== b.doc) {
      this.add(
        'info',
        'doc-changed',
        'protocol',
        'protocol.doc',
        'protocol doc changed',
        at('protocol'),
      );
    }
  }

  private enums(): void {
    const { added, removed, both } = match(this.before.protocol.enums, this.after.protocol.enums);
    for (const e of removed) {
      const users = this.users(`enum:${e.name}`);
      this.add(
        users.length > 0 ? 'breaking' : 'info',
        'enum-removed',
        'enum',
        e.name,
        `enum '${e.name}' removed`,
        this.positions(`enum:${e.name}`, undefined),
        users,
        users.length === 0 ? 'not used by any packet' : undefined,
      );
    }
    for (const e of added) {
      this.add(
        'compatible',
        'enum-added',
        'enum',
        e.name,
        `enum '${e.name}' added`,
        this.positions(undefined, `enum:${e.name}`),
      );
    }
    for (const { before, after } of both) this.enumChanges(before, after);
  }

  private enumChanges(a: Enum, b: Enum): void {
    const users = this.users(`enum:${b.name}`);
    const unused = users.length === 0 ? 'not used by any packet' : undefined;
    const breaking = users.length > 0 ? 'breaking' : 'info';
    const at = (suffix = '') =>
      this.positions(`enum:${a.name}${suffix}`, `enum:${b.name}${suffix}`);
    if (a.type !== b.type) {
      const byteUsers = this.users(`enum:${b.name}`, false);
      const bitsOnly = users.length > 0 && byteUsers.length === 0;
      this.add(
        byteUsers.length > 0 ? 'breaking' : 'info',
        'enum-type-changed',
        'enum',
        b.name,
        `enum '${b.name}' underlying type changed from ${a.type} to ${b.type}`,
        at('/type'),
        byteUsers,
        bitsOnly ? 'only used in bit fields, which do not depend on it' : unused,
      );
    }
    if (a.doc !== b.doc) {
      this.add('info', 'doc-changed', 'enum', b.name, `enum '${b.name}' doc changed`, at());
    }
    const oldByName = new Map(a.values.map((v) => [v.name, v]));
    const newByName = new Map(b.values.map((v) => [v.name, v]));
    const newByValue = new Map(b.values.map((v) => [v.value, v]));
    const renamedTo = new Set<string>();
    for (const old of a.values) {
      const path = `${b.name}.${old.name}`;
      const same = newByName.get(old.name);
      if (same) {
        if (same.value !== old.value) {
          this.add(
            breaking,
            'enum-value-renumbered',
            'enum',
            path,
            `enum '${b.name}' value '${old.name}' renumbered from ${old.value} to ${same.value}`,
            this.positions(`enum:${a.name}/value:${old.name}`, `enum:${b.name}/value:${old.name}`),
            users,
            unused,
          );
        }
        continue;
      }
      const renamed = newByValue.get(old.value);
      if (renamed && !oldByName.has(renamed.name)) {
        renamedTo.add(renamed.name);
        this.add(
          'info',
          'enum-value-renamed',
          'enum',
          `${b.name}.${renamed.name}`,
          `enum '${b.name}' value '${old.name}' (${old.value}) renamed to '${renamed.name}'`,
          this.positions(
            `enum:${a.name}/value:${old.name}`,
            `enum:${b.name}/value:${renamed.name}`,
          ),
        );
      } else {
        this.add(
          breaking,
          'enum-value-removed',
          'enum',
          path,
          `enum '${b.name}' value '${old.name}' (${old.value}) removed`,
          this.positions(`enum:${a.name}/value:${old.name}`, undefined),
          users,
          unused,
        );
      }
    }
    for (const value of b.values) {
      if (oldByName.has(value.name) || renamedTo.has(value.name)) continue;
      this.add(
        'compatible',
        'enum-value-added',
        'enum',
        `${b.name}.${value.name}`,
        `enum '${b.name}' value '${value.name}' (${value.value}) added`,
        this.positions(undefined, `enum:${b.name}/value:${value.name}`),
      );
    }
  }

  private structs(): void {
    const { added, removed, both } = match(
      this.before.protocol.structs,
      this.after.protocol.structs,
    );
    for (const s of removed) {
      const users = this.users(`struct:${s.name}`);
      this.add(
        users.length > 0 ? 'breaking' : 'info',
        'struct-removed',
        'struct',
        s.name,
        `struct '${s.name}' removed`,
        this.positions(`struct:${s.name}`, undefined),
        users,
        users.length === 0 ? 'not used by any packet' : undefined,
      );
    }
    for (const s of added) {
      this.add(
        'compatible',
        'struct-added',
        'struct',
        s.name,
        `struct '${s.name}' added`,
        this.positions(undefined, `struct:${s.name}`),
      );
    }
    for (const { before, after } of both) {
      const users = this.users(`struct:${after.name}`);
      if (before.doc !== after.doc) {
        this.add(
          'info',
          'doc-changed',
          'struct',
          after.name,
          `struct '${after.name}' doc changed`,
          this.positions(`struct:${before.name}`, `struct:${after.name}`),
        );
      }
      this.fields('struct', before, after, users);
    }
  }

  private packets(): void {
    const oldPackets = this.before.protocol.packets;
    const newPackets = this.after.protocol.packets;
    const { added, removed, both } = match(oldPackets, newPackets);
    // A packet that kept its opcode and direction but got a new name is a rename, not a removal.
    const slot = (p: Packet) => `${p.direction}:${p.opcode}`;
    const renamed: Array<Pair<Packet>> = [];
    const gone: Packet[] = [];
    for (const old of removed) {
      const index = added.findIndex((p) => slot(p) === slot(old));
      if (index >= 0) renamed.push({ before: old, after: added.splice(index, 1)[0]! });
      else gone.push(old);
    }
    for (const { before, after } of renamed) {
      this.add(
        'info',
        'packet-renamed',
        'packet',
        after.name,
        `packet '${before.name}' renamed to '${after.name}'`,
        this.positions(`packet:${before.name}`, `packet:${after.name}`),
      );
    }
    for (const p of gone) {
      this.add(
        'breaking',
        'packet-removed',
        'packet',
        p.name,
        `packet '${p.name}' (${hex(p.opcode)}, ${p.direction}) removed`,
        this.positions(`packet:${p.name}`, undefined),
      );
    }
    for (const p of added) {
      this.add(
        'compatible',
        'packet-added',
        'packet',
        p.name,
        `packet '${p.name}' (${hex(p.opcode)}, ${p.direction}) added`,
        this.positions(undefined, `packet:${p.name}`),
      );
    }
    for (const { before, after } of [...both, ...renamed]) {
      const at = (suffix = '') =>
        this.positions(`packet:${before.name}${suffix}`, `packet:${after.name}${suffix}`);
      if (before.opcode !== after.opcode) {
        this.add(
          'breaking',
          'packet-opcode-changed',
          'packet',
          after.name,
          `packet '${after.name}' opcode changed from ${hex(before.opcode)} to ${hex(after.opcode)}`,
          at('/opcode'),
        );
      }
      if (before.direction !== after.direction) {
        this.add(
          'breaking',
          'packet-direction-changed',
          'packet',
          after.name,
          `packet '${after.name}' direction changed from ${before.direction} to ${after.direction}`,
          at('/direction'),
        );
      }
      if (before.doc !== after.doc) {
        this.add(
          'info',
          'doc-changed',
          'packet',
          after.name,
          `packet '${after.name}' doc changed`,
          at(),
        );
      }
      this.fields('packet', before, after);
    }
  }

  /**
   * The wire carries fields back to back with no names or tags, so only order and type matter.
   * Fields are matched by name first; leftovers at the same position with the same wire type
   * count as renames, and so do bit field groups on the same integer, whose inside is compared
   * bit field by bit field. Anything still unmatched shifts the bytes that follow.
   */
  private fields(
    kind: 'packet' | 'struct',
    a: Packet | Struct,
    b: Packet | Struct,
    users?: string[],
  ): void {
    const owner = `${kind}:${a.name}`;
    const ownerAfter = `${kind}:${b.name}`;
    const subject = kind;
    const unused = users && users.length === 0 ? 'not used by any packet' : undefined;
    const severity = (s: Severity): Severity => (s === 'breaking' && unused ? 'info' : s);
    const emit = (
      s: Severity,
      rule: string,
      path: string,
      message: string,
      oldField?: string,
      newField?: string,
    ) =>
      this.add(
        severity(s),
        rule,
        subject,
        `${b.name}.${path}`,
        `${kind} '${b.name}' field '${path}': ${message}`,
        this.positions(
          oldField && `${owner}/field:${oldField}`,
          newField && `${ownerAfter}/field:${newField}`,
        ),
        s === 'breaking' ? users : undefined,
        s === 'breaking' ? unused : undefined,
      );

    const pairs: Array<{ old: number; new: number }> = [];
    const newIndexByName = new Map(b.fields.map((f, i) => [f.name, i]));
    const usedNew = new Set<number>();
    const usedOld = new Set<number>();
    a.fields.forEach((f, i) => {
      const j = newIndexByName.get(f.name);
      if (j === undefined) return;
      pairs.push({ old: i, new: j });
      usedOld.add(i);
      usedNew.add(j);
    });
    const renames: Array<{ old: number; new: number }> = [];
    a.fields.forEach((f, i) => {
      const g = b.fields[i];
      if (usedOld.has(i) || !g || usedNew.has(i)) return;
      const sameBits =
        f.type.kind === 'bits' && g.type.kind === 'bits' && f.type.base === g.type.base;
      if (!sameBits && this.sig(f.type, 'old') !== this.sig(g.type, 'new')) return;
      renames.push({ old: i, new: i });
      usedOld.add(i);
      usedNew.add(i);
    });

    for (const { old, new: now } of renames) {
      const f = a.fields[old]!;
      const g = b.fields[now]!;
      emit('info', 'field-renamed', g.name, `renamed from '${f.name}'`, f.name, g.name);
    }
    // Conditions name the member they test; follow it through the same pairing as the fields.
    const targets = new Map<string, string>();
    for (const { old, new: now } of [...pairs, ...renames]) {
      const f = a.fields[old]!;
      const g = b.fields[now]!;
      if (f.type.kind === 'bits' && g.type.kind === 'bits') {
        for (const [i, j] of pairBits(f.type, g.type)) {
          targets.set(f.type.fields[i]!.name, g.type.fields[j]!.name);
        }
      } else if (f.type.kind !== 'bits' && g.type.kind !== 'bits') {
        targets.set(f.name, g.name);
      }
    }
    for (const { old, new: now } of [...pairs, ...renames]) {
      this.fieldChange(a.fields[old]!, b.fields[now]!, emit);
      this.conditionChange(a.fields, a.fields[old]!, b.fields, b.fields[now]!, targets, emit);
    }
    a.fields.forEach((f, i) => {
      if (!usedOld.has(i))
        emit(
          'breaking',
          'field-removed',
          f.name,
          `removed (${this.text(f.type)}); wire layout changes`,
          f.name,
        );
    });
    b.fields.forEach((f, i) => {
      if (usedNew.has(i)) return;
      if (this.onlyNewValues(a.fields, b.fields, f, targets)) {
        emit(
          'compatible',
          'field-added',
          f.name,
          `added (${this.text(f.type)}) only when ${this.conditionText(b.fields, f.condition!, 'new')}, which old versions do not define`,
          undefined,
          f.name,
        );
        return;
      }
      emit(
        'breaking',
        'field-added',
        f.name,
        `added (${this.text(f.type)}); wire layout changes`,
        undefined,
        f.name,
      );
    });

    const ordered = [...pairs, ...renames].sort((x, y) => x.old - y.old);
    const outOfOrder = ordered.find((pair, i) => i > 0 && pair.new < ordered[i - 1]!.new);
    if (outOfOrder) {
      const layout = (fields: Field[], side: 'old' | 'new') =>
        fields.map((f) => this.sig(f.type, side) + this.conditionSig(fields, f)).join(';');
      const same = layout(a.fields, 'old') === layout(b.fields, 'new');
      const order = (fields: Field[]) => fields.map((f) => f.name).join(', ');
      const field = b.fields[outOfOrder.new]!;
      emit(
        same ? 'info' : 'breaking',
        'field-reordered',
        field.name,
        `order changed from (${order(a.fields)}) to (${order(b.fields)})` +
          (same ? '; wire layout is the same' : ''),
        a.fields[outOfOrder.old]!.name,
        field.name,
      );
    }
  }

  private fieldChange(
    f: Field,
    g: Field,
    emit: (
      s: Severity,
      rule: string,
      path: string,
      message: string,
      oldField?: string,
      newField?: string,
    ) => void,
  ): void {
    const was = this.text(f.type);
    const now = this.text(g.type);
    const sameWire = this.sig(f.type, 'old') === this.sig(g.type, 'new');
    // A struct or enum with the same name changed underneath; that is reported on the type itself.
    if (was === now && f.type.kind === 'bits' && g.type.kind === 'bits') {
      this.bitChanges(f.name, f.type, g.name, g.type, emit);
    }
    if (was !== now) {
      if (sameWire) {
        emit(
          'info',
          'field-type-renamed',
          g.name,
          `type changed from ${was} to ${now}; wire layout is the same`,
          f.name,
          g.name,
        );
      } else {
        const rule = fieldRule(f.type, g.type, this.sig(f.type, 'old'), this.sig(g.type, 'new'));
        emit('breaking', rule, g.name, `type changed from ${was} to ${now}`, f.name, g.name);
      }
    }
    if (f.doc !== g.doc) emit('info', 'doc-changed', g.name, 'doc changed', f.name, g.name);
  }

  /**
   * A condition decides whether the bytes are there at all, so adding, removing or changing one
   * makes the two sides disagree on where the following fields start.
   */
  private conditionChange(
    oldFields: Field[],
    f: Field,
    newFields: Field[],
    g: Field,
    targets: Map<string, string>,
    emit: (
      s: Severity,
      rule: string,
      path: string,
      message: string,
      oldField?: string,
      newField?: string,
    ) => void,
  ): void {
    const was = f.condition && this.conditionText(oldFields, f.condition, 'old');
    const now = g.condition && this.conditionText(newFields, g.condition, 'new');
    if (!f.condition && g.condition) {
      emit(
        'breaking',
        'condition-added',
        g.name,
        `now only present when ${now}; old versions always read it`,
        f.name,
        g.name,
      );
    } else if (f.condition && !g.condition) {
      emit(
        'breaking',
        'condition-removed',
        g.name,
        `now always present; old versions only read it when ${was}`,
        f.name,
        g.name,
      );
    } else if (f.condition && g.condition && !sameCondition(f.condition, g.condition, targets)) {
      emit(
        'breaking',
        'condition-changed',
        g.name,
        `condition changed from ${was} to ${now}`,
        f.name,
        g.name,
      );
    }
  }

  /**
   * A new field that is only present for enum values the old version does not define never
   * appears in data that old versions read or write, just like the new values themselves.
   */
  private onlyNewValues(
    oldFields: Field[],
    newFields: Field[],
    field: Field,
    targets: Map<string, string>,
  ): boolean {
    const { condition } = field;
    if (condition?.kind !== 'in') return false;
    const target = memberFields(newFields).find((m) => m.name === condition.field);
    const before = memberFields(oldFields).find((m) => targets.get(m.name) === condition.field);
    if (target?.type.kind !== 'enum' || before?.type.kind !== 'enum') return false;
    const name = target.type.name;
    if (before.type.name !== name) return false;
    const old = this.before.protocol.enums.find((e) => e.name === name);
    return (
      old !== undefined && condition.values.every((v) => !old.values.some((o) => o.value === v))
    );
  }

  private conditionText(fields: Field[], condition: Condition, side: 'old' | 'new'): string {
    const name = `'${condition.field}'`;
    if (condition.kind === 'true') return `${name} is true`;
    const protocol = side === 'old' ? this.before.protocol : this.after.protocol;
    const target = memberFields(fields).find((m) => m.name === condition.field);
    const values = condition.values.map((value) =>
      target?.type.kind === 'enum'
        ? (findEnum(protocol, target.type.name).values.find((v) => v.value === value)?.name ??
          String(value))
        : String(value),
    );
    return values.length === 1
      ? `${name} is ${values[0]}`
      : `${name} is one of ${values.join(', ')}`;
  }

  /**
   * The condition by the position of the member it tests, since names do not reach the wire. A bit
   * field counts by its group and its place in the group, so a group that grows does not shift the
   * members after it.
   */
  private conditionSig(fields: Field[], field: Field): string {
    const { condition } = field;
    if (!condition) return '';
    const position = targetPosition(fields, condition.field);
    if (condition.kind === 'true') return `?${position}`;
    return `?${position}=${[...condition.values].sort((x, y) => x - y).join(',')}`;
  }

  /**
   * Bit fields are matched by name first, then by position like fields. Whatever moves changes
   * what the other side reads; a new field in bits that used to be unused reads as 0 on both
   * old and new peers, so it is compatible unless 0 is not a value of its enum.
   */
  private bitChanges(
    oldGroup: string,
    a: BitsType,
    newGroup: string,
    b: BitsType,
    emit: (
      s: Severity,
      rule: string,
      path: string,
      message: string,
      oldField?: string,
      newField?: string,
    ) => void,
  ): void {
    const before = bitLayout(a.fields);
    const after = bitLayout(b.fields);
    const span = (p: { field: BitField; offset: number }) =>
      p.field.bits === 1 ? `bit ${p.offset}` : `bits ${p.offset}-${p.offset + p.field.bits - 1}`;
    const at = (old?: BitField, now?: BitField) =>
      [old && `${oldGroup}/bit:${old.name}`, now && `${newGroup}/bit:${now.name}`] as const;

    const pairs = pairBits(a, b);
    const usedOld = new Set(pairs.map(([i]) => i));
    const usedNew = new Set(pairs.map(([, j]) => j));
    for (const [i, j] of pairs) {
      const p = before[i]!;
      const q = after[j]!;
      if (p.field.name === q.field.name) continue;
      emit(
        'info',
        'bit-field-renamed',
        `${newGroup}.${q.field.name}`,
        `renamed from '${p.field.name}'`,
        ...at(p.field, q.field),
      );
    }

    for (const [i, j] of [...pairs].sort((x, y) => x[0] - y[0])) {
      const p = before[i]!;
      const q = after[j]!;
      const path = `${newGroup}.${q.field.name}`;
      if (p.field.bits !== q.field.bits) {
        emit(
          'breaking',
          'bit-field-resized',
          path,
          `size changed from ${p.field.bits} to ${q.field.bits} bits`,
          ...at(p.field, q.field),
        );
      } else if (p.offset !== q.offset) {
        emit(
          'breaking',
          'bit-field-moved',
          path,
          `moved from ${span(p)} to ${span(q)}`,
          ...at(p.field, q.field),
        );
      }
      if (bitKind(p.field) !== bitKind(q.field)) {
        emit(
          'breaking',
          'bit-field-type-changed',
          path,
          `type changed from ${bitKind(p.field)} to ${bitKind(q.field)}`,
          ...at(p.field, q.field),
        );
      }
      if (p.field.doc !== q.field.doc) {
        emit('info', 'doc-changed', path, 'doc changed', ...at(p.field, q.field));
      }
    }

    before.forEach((p, i) => {
      if (usedOld.has(i)) return;
      emit(
        'breaking',
        'bit-field-removed',
        `${newGroup}.${p.field.name}`,
        `removed (${span(p)}); old versions still read it and get 0`,
        ...at(p.field),
      );
    });
    const oldUsed = a.fields.reduce((sum, field) => sum + field.bits, 0);
    after.forEach((q, j) => {
      if (usedNew.has(j)) return;
      const path = `${newGroup}.${q.field.name}`;
      const where = at(undefined, q.field);
      if (q.offset < oldUsed) {
        emit(
          'breaking',
          'bit-field-added',
          path,
          `added (${span(q)}) over bits that old versions use`,
          ...where,
        );
        return;
      }
      const type = q.field.type;
      const noZero =
        type.kind === 'enum' &&
        !findEnum(this.after.protocol, type.name).values.some((v) => v.value === 0);
      emit(
        noZero ? 'breaking' : 'compatible',
        'bit-field-added',
        path,
        noZero
          ? `added (${span(q)}) in unused bits, but old versions send 0, which enum '${bitKind(q.field)}' does not define`
          : `added (${span(q)}) in unused bits, which old versions write as 0 and ignore`,
        ...where,
      );
    });
  }

  private text(type: FieldType): string {
    switch (type.kind) {
      case 'primitive':
        return type.name;
      case 'string':
        return `string (${type.length} length)`;
      case 'bytes':
        return `bytes (${type.length} length)`;
      case 'fixedBytes':
        return `bytes[${type.size}]`;
      case 'struct':
      case 'enum':
        return type.name;
      case 'array':
        return `${this.text(type.element)}[] (${type.length} length)`;
      case 'fixedArray':
        return `${this.text(type.element)}[${type.size}]`;
      case 'bits':
        return `${type.base} bit fields`;
    }
  }

  /** Canonical description of the bytes a type occupies; names of structs and enums do not appear. */
  private sig(type: FieldType, side: 'old' | 'new', stack: string[] = []): string {
    const protocol = side === 'old' ? this.before.protocol : this.after.protocol;
    switch (type.kind) {
      case 'primitive':
        return type.name;
      case 'string':
        return `string:${type.length}`;
      case 'bytes':
        return `bytes:${type.length}`;
      case 'fixedBytes':
        return `bytes[${type.size}]`;
      case 'enum':
        return findEnum(protocol, type.name).type;
      case 'struct': {
        if (stack.includes(type.name)) return `@${stack.length - stack.indexOf(type.name)}`;
        const inner = findStruct(protocol, type.name).fields;
        const parts = inner.map(
          (f) => this.sig(f.type, side, [...stack, type.name]) + this.conditionSig(inner, f),
        );
        return `{${parts.join(',')}}`;
      }
      case 'array':
        return `[${this.sig(type.element, side, stack)}]:${type.length}`;
      case 'fixedArray':
        return `[${this.sig(type.element, side, stack)}]x${type.size}`;
      case 'bits': {
        const parts = type.fields.map((f) => `${f.type.kind}:${f.bits}`);
        return `${type.base}<${parts.join(',')}>`;
      }
    }
  }

  private users(key: UsageKey, bits = true): string[] {
    const [old, now] = bits
      ? [this.oldUsers, this.newUsers]
      : [this.oldByteUsers, this.newByteUsers];
    const merged = new Set([...(old.get(key) ?? []), ...(now.get(key) ?? [])]);
    return [...merged].sort();
  }

  private positions(oldKey: string | undefined, newKey: string | undefined) {
    return {
      old: oldKey ? this.before.locations.get(oldKey) : undefined,
      new: newKey ? this.after.locations.get(newKey) : undefined,
    };
  }

  private add(
    severity: Severity,
    rule: string,
    subject: Change['subject'],
    path: string,
    message: string,
    at: { old?: SourcePosition; new?: SourcePosition },
    usedBy?: string[],
    note?: string,
  ): void {
    let text = message;
    if (usedBy && usedBy.length > 0) text += ` (used by: ${usedBy.join(', ')})`;
    else if (note) text += ` (${note})`;
    const change: Change = { severity, rule, subject, path, message: text };
    if (usedBy && usedBy.length > 0) change.usedBy = usedBy;
    if (at.old) change.old = at.old;
    if (at.new) change.new = at.new;
    this.changes.push(change);
  }
}

function bitKind(field: BitField): string {
  return field.type.kind === 'enum'
    ? field.type.name
    : field.type.kind === 'bool'
      ? 'bool'
      : 'unsigned';
}

/**
 * Bit fields by name first, then leftovers at the same offset with the same size and kind as
 * renames. The indexes are into the `fields` of each group.
 */
function pairBits(a: BitsType, b: BitsType): Array<[number, number]> {
  const before = bitLayout(a.fields);
  const after = bitLayout(b.fields);
  const pairs: Array<[number, number]> = [];
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  before.forEach((p, i) => {
    const j = after.findIndex((q) => q.field.name === p.field.name);
    if (j < 0) return;
    pairs.push([i, j]);
    usedOld.add(i);
    usedNew.add(j);
  });
  before.forEach((p, i) => {
    const q = after[i];
    if (usedOld.has(i) || !q || usedNew.has(i)) return;
    if (p.offset !== q.offset || p.field.bits !== q.field.bits) return;
    if (bitKind(p.field) !== bitKind(q.field)) return;
    pairs.push([i, i]);
    usedOld.add(i);
    usedNew.add(i);
  });
  return pairs;
}

/** Same target through the field and bit field pairing, and the same values on the wire. */
function sameCondition(a: Condition, b: Condition, targets: Map<string, string>): boolean {
  if (a.kind !== b.kind) return false;
  if (targets.get(a.field) !== b.field) return false;
  if (a.kind === 'true' || b.kind === 'true') return true;
  const values = (c: Extract<Condition, { kind: 'in' }>) =>
    [...c.values].sort((x, y) => x - y).join(',');
  return values(a) === values(b);
}

/** `field` or `field.bit` by index, so a bit field group that grows shifts nothing after it. */
function targetPosition(fields: Field[], name: string): string {
  for (const [i, f] of fields.entries()) {
    if (f.name === name) return String(i);
    if (f.type.kind !== 'bits') continue;
    const j = f.type.fields.findIndex((bit) => bit.name === name);
    if (j >= 0) return `${i}.${j}`;
  }
  return '';
}

function match<T extends { name: string }>(before: T[], after: T[]) {
  const afterByName = new Map(after.map((item) => [item.name, item]));
  const beforeNames = new Set(before.map((item) => item.name));
  return {
    removed: before.filter((item) => !afterByName.has(item.name)),
    added: after.filter((item) => !beforeNames.has(item.name)),
    both: before.flatMap((item) => {
      const found = afterByName.get(item.name);
      return found ? [{ before: item, after: found }] : [];
    }),
  };
}

function fieldRule(a: FieldType, b: FieldType, sigA: string, sigB: string): string {
  if (
    (a.kind === 'array' && b.kind === 'array') ||
    (a.kind === 'fixedArray' && b.kind === 'fixedArray')
  ) {
    const elementA = sigA.slice(1, sigA.lastIndexOf(']'));
    const elementB = sigB.slice(1, sigB.lastIndexOf(']'));
    if (elementA !== elementB) return 'array-element-changed';
    return a.kind === 'array' ? 'length-prefix-changed' : 'fixed-size-changed';
  }
  if ((a.kind === 'string' && b.kind === 'string') || (a.kind === 'bytes' && b.kind === 'bytes')) {
    return 'length-prefix-changed';
  }
  if (a.kind === 'fixedBytes' && b.kind === 'fixedBytes') return 'fixed-size-changed';
  return 'field-type-changed';
}

/**
 * For every struct and enum, the packets that reach it through their fields; enums held in bit
 * fields count only when `bits` is set.
 */
function usage(protocol: Protocol, bits: boolean): Map<UsageKey, Set<string>> {
  const result = new Map<UsageKey, Set<string>>();
  const mark = (key: UsageKey, packet: string) => {
    let set = result.get(key);
    if (!set) result.set(key, (set = new Set()));
    set.add(packet);
  };
  for (const packet of protocol.packets) {
    const seen = new Set<string>();
    const walk = (fields: Field[]) => {
      for (const { type } of fields) {
        if (type.kind === 'bits') {
          for (const bit of bits ? type.fields : []) {
            if (bit.type.kind === 'enum') mark(`enum:${bit.type.name}`, packet.name);
          }
          continue;
        }
        const element = type.kind === 'array' || type.kind === 'fixedArray' ? type.element : type;
        if (element.kind === 'enum') mark(`enum:${element.name}`, packet.name);
        if (element.kind === 'struct' && !seen.has(element.name)) {
          seen.add(element.name);
          mark(`struct:${element.name}`, packet.name);
          walk(findStruct(protocol, element.name).fields);
        }
      }
    };
    walk(packet.fields);
  }
  return result;
}

function show(value: string | undefined): string {
  return value === undefined ? '(none)' : `'${value}'`;
}
