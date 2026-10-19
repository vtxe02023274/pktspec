import { readFileSync } from 'node:fs';
import { compile } from '../src/compile.js';
import type { Protocol } from '../src/model.js';

export function loadProtocol(relativePath: string): Protocol {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { protocol, diagnostics } = compile(source);
  if (!protocol) throw new Error(JSON.stringify(diagnostics));
  return protocol;
}

export const chatRoom = () => loadProtocol('../examples/chat-room.yaml');
export const allTypes = () => loadProtocol('fixtures/all-types.yaml');
