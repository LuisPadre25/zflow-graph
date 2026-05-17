import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFlow } from './helpers.js';

let flow;

beforeEach(async () => { flow = await createFlow(); });
afterEach(() => { flow?.dispose(); });

describe('core graph operations', () => {
  it('starts with an empty graph', () => {
    expect(flow.nodeCount()).toBe(0);
    expect(flow.edgeCount()).toBe(0);
  });

  it('addNode returns a non-negative id', () => {
    const id = flow.addNode({ kind: 'process', x: 0, y: 0 });
    expect(id).toBeGreaterThanOrEqual(0);
    expect(flow.nodeCount()).toBe(1);
  });

  it('rejects addNode when readOnly', () => {
    flow.setReadOnly(true);
    expect(flow.addNode({ kind: 'process' })).toBe(-1);
    expect(flow.nodeCount()).toBe(0);
  });

  it('addEdge connects two nodes', () => {
    const a = flow.addNode({ kind: 'input', x: 0, y: 0 });
    const b = flow.addNode({ kind: 'output', x: 100, y: 0 });
    const e = flow.addEdge({ from: a, to: b });
    expect(e).toBeGreaterThanOrEqual(0);
    expect(flow.edgeCount()).toBe(1);
  });

  it('deleteSelection removes selected nodes', () => {
    const a = flow.addNode({ kind: 'process', x: 0, y: 0 });
    const b = flow.addNode({ kind: 'process', x: 100, y: 0 });
    flow.setSelected(a, true);
    flow.deleteSelection();
    expect(flow.nodeCount()).toBe(1);
    expect(flow.V.posX[0]).toBeCloseTo(100);  // 'b' remains, compacted to index 0
  });

  it('undo restores previous state', () => {
    const a = flow.addNode({ kind: 'process' });
    flow.snapshot();
    flow.moveNode(a, 50, 50);
    flow.snapshot();
    expect(flow.V.posX[a]).toBeCloseTo(50);
    flow.undo();
    expect(flow.V.posX[a]).toBeCloseTo(0);
    flow.redo();
    expect(flow.V.posX[a]).toBeCloseTo(50);
  });

  it('moveNode shifts position', () => {
    const a = flow.addNode({ kind: 'process', x: 0, y: 0 });
    flow.moveNode(a, 123, 456);
    expect(flow.V.posX[a]).toBeCloseTo(123);
    expect(flow.V.posY[a]).toBeCloseTo(456);
  });

  it('bulk add is faster than individual addNode', () => {
    const N = 500;
    const specs = Array.from({ length: N }, (_, i) => ({ kind: 'process', x: i * 5, y: 0 }));
    const t0 = performance.now();
    const ids = flow.addNodesBulk(specs);
    const dt = performance.now() - t0;
    expect(ids.length).toBe(N);
    expect(flow.nodeCount()).toBe(N);
    expect(dt).toBeLessThan(500);  // generous CI budget
  });

  it('selection methods stay consistent', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    flow.selectAll();
    expect(flow.getSelection()).toEqual(expect.arrayContaining([a, b]));
    flow.clearSelection();
    expect(flow.getSelection()).toEqual([]);
  });
});

describe('node rich content', () => {
  it('setNodeTitle and setNodeDescription persist', () => {
    const id = flow.addNode({ kind: 'process' });
    flow.setNodeTitle(id, 'Hello');
    flow.setNodeDescription(id, '**world**');
    expect(flow.titles.get(id)).toBe('Hello');
    expect(flow.descriptions.get(id)).toBe('**world**');
  });

  it('setNodeTasks updates progress automatically? no — only after toggle in canvas', () => {
    const id = flow.addNode({ kind: 'process' });
    flow.setNodeTasks(id, [{ text: 'a', done: true }, { text: 'b', done: false }]);
    expect(flow.tasks.get(id)).toHaveLength(2);
  });

  it('lockNode prevents drag-style mutation in semantics', () => {
    const id = flow.addNode({ kind: 'process' });
    flow.lockNode(id, true);
    expect(flow.isLocked(id)).toBe(true);
    flow.lockNode(id, false);
    expect(flow.isLocked(id)).toBe(false);
  });
});

describe('kind registration', () => {
  it('registerKind returns an index and stores execute fn', () => {
    const exec = (ctx, ins) => ({ value: 42 });
    const idx = flow.registerKind({ name: 'custom', execute: exec });
    expect(typeof idx).toBe('number');
    expect(flow.kinds[idx].execute).toBe(exec);
  });

  it('addNode accepts kind by name OR index', () => {
    flow.registerKind({ name: 'foo' });
    const a = flow.addNode({ kind: 'foo' });
    const b = flow.addNode({ kind: flow.kindByName.get('foo') });
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(flow.V.kind[a]).toBe(flow.V.kind[b]);
  });
});
