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
