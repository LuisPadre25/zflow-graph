import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFlow } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); });
afterEach(() => { flow?.dispose?.(); });

describe('node data (free metadata bag)', () => {
  it('round-trips through toJSON/loadJSON', () => {
    const a = flow.addNode({ kind: 'process', x: 0, y: 0, data: { foo: 1, tag: 'x' } });
    expect(flow.getNodeData(a)).toEqual({ foo: 1, tag: 'x' });
    const j = flow.toJSON();
    flow.loadJSON(j);
    expect(flow.getNodeData(0)).toEqual({ foo: 1, tag: 'x' });
  });
  it('setNodeData updates and delete on null', () => {
    const a = flow.addNode({ kind: 'process' });
    flow.setNodeData(a, { hello: true });
    expect(flow.getNodeData(a)).toEqual({ hello: true });
    flow.setNodeData(a, null);
    expect(flow.data.has(a)).toBe(false);
  });
  it('survives deleteSelection compaction (remap)', () => {
    const a = flow.addNode({ kind: 'process', data: { name: 'A' } });
    const b = flow.addNode({ kind: 'process', data: { name: 'B' } });
    const c = flow.addNode({ kind: 'process', data: { name: 'C' } });
    flow.setSelection([b]);
    flow.deleteSelection();
    // After compaction: old a stays at 0, old c slides to 1.
    expect(flow.getNodeData(0)).toEqual({ name: 'A' });
    expect(flow.getNodeData(1)).toEqual({ name: 'C' });
    // The deleted node's data is gone.
    expect(flow.data.size).toBe(2);
  });
});

describe('setSelection / deleteNode', () => {
  it('setSelection replaces selection', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    const c = flow.addNode({ kind: 'process' });
    flow.setSelection([a, c]);
    expect(flow.getSelection().sort()).toEqual([a, c]);
    flow.setSelection([b]);
    expect(flow.getSelection()).toEqual([b]);
    flow.setSelection([]);
    expect(flow.getSelection()).toEqual([]);
  });
  it('deleteNode removes one node without disturbing the rest of selection', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    const c = flow.addNode({ kind: 'process' });
    flow.setSelection([a, c]);
    flow.deleteNode(b);
    expect(flow.nodeCount()).toBe(2);
    // Selection survives but is remapped: a stays 0, c becomes 1.
    expect(flow.getSelection().sort()).toEqual([0, 1]);
  });
  it('deleteNode is a no-op for invalid ids', () => {
    flow.addNode({ kind: 'process' });
    expect(flow.deleteNode(-1)).toBe(0);
    expect(flow.deleteNode(99)).toBe(0);
    expect(flow.nodeCount()).toBe(1);
  });
});

describe('transaction', () => {
  it('emits a single change at the end', () => {
    let count = 0;
    flow.on('change', () => count++);
    flow.transaction(() => {
      for (let i = 0; i < 5; i++) flow.addNode({ kind: 'process', x: i * 50, y: 0 });
    });
    expect(count).toBe(1);
    expect(flow.nodeCount()).toBe(5);
  });
  it('nested transactions only commit once', () => {
    let count = 0;
    flow.on('change', () => count++);
    flow.transaction(() => {
      flow.addNode({ kind: 'process' });
      flow.transaction(() => { flow.addNode({ kind: 'process' }); });
      flow.addNode({ kind: 'process' });
    });
    expect(count).toBe(1);
    expect(flow.nodeCount()).toBe(3);
  });
});

describe('public coord/camera helpers', () => {
  it('worldToScreen and screenToWorld are mutual inverses', () => {
    const w = { x: 123, y: -45 };
    const s = flow.worldToScreen(w.x, w.y);
    expect(typeof s.x).toBe('number');
    expect(typeof s.y).toBe('number');
    // canvas.getBoundingClientRect is stubbed at left:0/top:0 so the roundtrip works.
    const back = flow.screenToWorld(s.x, s.y);
    expect(back.x).toBeCloseTo(w.x, 3);
    expect(back.y).toBeCloseTo(w.y, 3);
  });
  it('getCamera returns a snapshot, not the live reference', () => {
    const cam = flow.getCamera();
    cam.x = 999;
    expect(flow.cam.x).not.toBe(999);
  });
  it('getNodePosition returns geometry or null', () => {
    const a = flow.addNode({ kind: 'process', x: 50, y: 60, w: 100, h: 40 });
    const p = flow.getNodePosition(a);
    expect(p).toEqual({ x: 50, y: 60, w: 100, h: 40 });
    expect(flow.getNodePosition(99)).toBe(null);
  });
});

describe('loadGraph', () => {
  it('accepts user ids and wires edges atomically', () => {
    let changes = 0;
    flow.on('change', () => changes++);
    const idMap = flow.loadGraph({
      nodes: [
        { id: 'svc_users', kind: 'process', x: 0,   y: 0, title: 'Users' },
        { id: 'db_main',   kind: 'process', x: 200, y: 0, title: 'PG'    },
      ],
      edges: [{ from: 'svc_users', to: 'db_main', label: 'SELECT' }],
    });
    expect(flow.nodeCount()).toBe(2);
    expect(flow.edgeCount()).toBe(1);
    expect(idMap.get('svc_users')).toBe(0);
    expect(idMap.get('db_main')).toBe(1);
    expect(changes).toBe(1);                            // atomic
    expect(flow.findNodeByUserId('db_main')).toBe(1);   // round-trip lookup
    expect(flow.edgeLabels.get(0)).toBe('SELECT');
  });
  it('wipes prior state', () => {
    flow.addNode({ kind: 'process' });
    flow.addNode({ kind: 'process' });
    flow.loadGraph({ nodes: [{ id: 'new', kind: 'process' }], edges: [] });
    expect(flow.nodeCount()).toBe(1);
  });
  it('drops edges whose endpoints did not load', () => {
    const idMap = flow.loadGraph({
      nodes: [{ id: 'a', kind: 'process' }],
      edges: [{ from: 'a', to: 'ghost' }],
    });
    expect(idMap.get('a')).toBe(0);
    expect(flow.edgeCount()).toBe(0);
  });
});
