export interface GeneratedFile {
  /** Path relative to the output directory, always with forward slashes. */
  path: string;
  content: string;
}

export function hex(value: number, digits = 2): string {
  return '0x' + value.toString(16).toUpperCase().padStart(digits, '0');
}

export function pascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function camelCase(name: string): string {
  return name
    .split('_')
    .filter((part) => part !== '')
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

export function uniqueName(
  base: string,
  used: Set<string>,
  rejected: (name: string) => boolean = () => false,
): string {
  let name = base;
  while (used.has(name) || rejected(name)) name += '_';
  used.add(name);
  return name;
}

export function enumMemberName(name: string): string {
  const parts = name.split('_').filter((part) => part !== '');
  const keepCase = /[a-z]/.test(name);
  const joined = parts
    .map((part) => {
      const text = keepCase ? part : part.toLowerCase();
      return text.charAt(0).toUpperCase() + text.slice(1);
    })
    .join('');
  if (joined === '') return '_';
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}
