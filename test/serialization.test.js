import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFlow } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); });
afterEach(() => flow?.dispose());

describe('serialization', () => {
  it('toJSON includes nodes, edges, and rich content', () => {
    const a = flow.addNode({ kind: 'input', x: 10, y: 20, title: 'Source' });
    const b = flow.addNode({ kind: 'output', x: 100, y: 0, title: 'Sink' });
    flow.addEdge({ from: a, to: b, label: 'pipe' });
    flow.setNodeDescription(a, 'desc');
    flow.setNodeTags(a, ['x', 'y']);
    const json = flow.toJSON();
    expect(json.nodes).toHaveLength(2);
    expect(json.edges).toHaveLength(1);
    expect(json.nodes[0].title).toBe('Source');
    expect(json.nodes[0].description).toBe('desc');
    expect(json.nodes[0].tags).toEqual(['x', 'y']);
    expect(json.edges[0].label).toBe('pipe');
  });

  it('loadJSON restores a previously-saved graph', async () => {
    const a = flow.addNode({ kind: 'process', x: 5, y: 10, title: 'A' });
    const b = flow.addNode({ kind: 'process', x: 50, y: 10, title: 'B' });
    flow.addEdge({ from: a, to: b });
    const snap = flow.toJSON();

    const fresh = await createFlow();
    fresh.loadJSON(snap);
    expect(fresh.nodeCount()).toBe(2);
    expect(fresh.edgeCount()).toBe(1);
    expect(fresh.titles.get(0)).toBe('A');
    expect(fresh.V.posX[0]).toBeCloseTo(5);
    expect(fresh.V.posX[1]).toBeCloseTo(50);
    fresh.dispose();
  });

  it('exportSVG returns a string with <svg> tag', () => {
    flow.addNode({ kind: 'process', x: 0, y: 0, title: 'A' });
    const svg = flow.exportSVG();
    expect(typeof svg).toBe('string');
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/<\/svg>/);
  });
});
