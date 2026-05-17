import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFlow } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); });
afterEach(() => flow?.dispose());

describe('graph algorithms', () => {
  it('shortestPath finds path edges in a chain', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(flow.addNode({ kind: 'process', x: i * 50 }));
    for (let i = 0; i < 4; i++) flow.addEdge({ from: ids[i], to: ids[i + 1] });
    const path = flow.shortestPath(ids[0], ids[4]);
    expect(path).toHaveLength(4);
  });

  it('shortestPath returns [] when unreachable', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    expect(flow.shortestPath(a, b)).toEqual([]);
  });

  it('findSCCs detects strongly-connected components', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    const c = flow.addNode({ kind: 'process' });
    flow.addEdge({ from: a, to: b });
    flow.addEdge({ from: b, to: c });
    flow.addEdge({ from: c, to: a });
    const sccs = flow.findSCCs();
    expect(sccs.length).toBeGreaterThan(0);
    const cycle = sccs.find((g) => g.length === 3);
    expect(cycle).toEqual(expect.arrayContaining([a, b, c]));
  });

  it('criticalPath returns longest DAG path', () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(flow.addNode({ kind: 'process' }));
    flow.addEdge({ from: ids[0], to: ids[1] });
    flow.addEdge({ from: ids[1], to: ids[2] });
    flow.addEdge({ from: ids[2], to: ids[3] });
    flow.addEdge({ from: ids[0], to: ids[3] });   // shortcut
    const path = flow.criticalPath();
    expect(path.length).toBe(3);   // 0→1→2→3 = 3 edges
  });

  it('findCycles flags edges that close a cycle', () => {
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    flow.addEdge({ from: a, to: b });
    flow.addEdge({ from: b, to: a });
    const cycles = flow.findCycles();
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe('spatial queries', () => {
  it('hitTestNode finds a node at world coords', () => {
    const id = flow.addNode({ kind: 'process', x: 100, y: 100, w: 100, h: 50 });
    const hit = flow.w.hitTestNode(100, 100);
    expect(hit).toBe(id);
  });

  it('hitTestNode misses empty space', () => {
    flow.addNode({ kind: 'process', x: 0, y: 0, w: 50, h: 50 });
    expect(flow.w.hitTestNode(500, 500)).toBe(-1);
  });
});
