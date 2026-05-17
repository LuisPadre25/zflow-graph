// Shared factory that loads the real WASM and returns a fresh ZFlow instance
// against a stubbed canvas. Every test should get its own isolated flow.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZFlow } from '../src/zflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = new Uint8Array(readFileSync(resolve(__dirname, '../dist/zflow.wasm')));

export async function createFlow(opts = {}) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  });
  document.body.appendChild(container);
  const flow = await ZFlow.create({ container, wasmBytes, ...opts });
  return flow;
}

export function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}
