import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFlow, tick } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); flow.setRunStepDelay(0); });
afterEach(() => flow?.dispose());

describe('graph execution runtime', () => {
  it('topological order is consistent with edges', async () => {
    flow.registerKind({ name: 'src', nin: 0, nout: 1, execute: () => ({ value: 1 }) });
    flow.registerKind({ name: 'mid', nin: 1, nout: 1, execute: (c, i) => ({ value: i.value + 1 }) });
    flow.registerKind({ name: 'snk', nin: 1, nout: 0, execute: (c, i) => ({ received: i.value }) });
    const a = flow.addNode({ kind: 'src' });
    const b = flow.addNode({ kind: 'mid' });
    const c = flow.addNode({ kind: 'snk' });
    flow.addEdge({ from: a, to: b });
    flow.addEdge({ from: b, to: c });
    const order = flow._topoOrder();
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(c));
  });

  it('run propagates values through edges', async () => {
    flow.registerKind({ name: 'src', nin: 0, nout: 1, execute: () => ({ value: 10 }) });
    flow.registerKind({ name: 'dbl', nin: 1, nout: 1, execute: (c, i) => ({ value: (i.value ?? i[0]) * 2 }) });
    const a = flow.addNode({ kind: 'src' });
    const b = flow.addNode({ kind: 'dbl' });
    flow.addEdge({ from: a, to: b });
    const result = await flow.run();
    expect(result.executed).toBe(2);
    expect(flow.getNodeValue(b)).toEqual({ value: 20 });
  });

  it('async execute is awaited', async () => {
    flow.registerKind({
      name: 'slow', nin: 0, nout: 1,
      execute: async () => { await tick(20); return { value: 7 }; },
    });
    const a = flow.addNode({ kind: 'slow' });
    await flow.run();
    expect(flow.getNodeValue(a)).toEqual({ value: 7 });
  });

  it('retry policy re-attempts failing nodes', async () => {
    let calls = 0;
    flow.registerKind({
      name: 'flaky', nin: 0, nout: 1,
      retry: { n: 3, delay: 5 },
      execute: () => { calls++; if (calls < 3) throw new Error('boom'); return { value: 'ok' }; },
    });
    const id = flow.addNode({ kind: 'flaky' });
    await flow.run();
    expect(calls).toBe(3);
    expect(flow.getNodeValue(id)).toEqual({ value: 'ok' });
  });

  it('memoization skips nodes whose inputs hash matches', async () => {
    flow.setMemoization(true);
    let calls = 0;
    flow.registerKind({ name: 'src', nin: 0, nout: 1, execute: () => ({ value: 5 }) });
    flow.registerKind({ name: 'cnt', nin: 1, nout: 0, execute: (c, i) => { calls++; return { value: i.value }; } });
    const a = flow.addNode({ kind: 'src' });
    const b = flow.addNode({ kind: 'cnt' });
    flow.addEdge({ from: a, to: b });
    await flow.run();
    await flow.run();   // same inputs → cache hit
    expect(calls).toBe(1);
  });

  it('stop() aborts an in-flight run', async () => {
    flow.registerKind({
      name: 'verylong', nin: 0, nout: 1,
      execute: async (ctx) => { await tick(500); return { value: 1 }; },
    });
    flow.addNode({ kind: 'verylong' });
    const p = flow.run();
    setTimeout(() => flow.stop(), 10);
    await p;
    expect(flow.isRunning()).toBe(false);
  });

  it('conditional routing: threshold emits one branch only', async () => {
    flow.registerKind({ name: 'src', nin: 0, nout: 1, portOut: ['value'], execute: () => ({ value: 50 }) });
    flow.registerKind({
      name: 'thresh', nin: 1, nout: 2, portIn: ['value'], portOut: ['ok', 'bad'],
      execute: (c, i) => i.value > 100 ? { ok: i.value } : { bad: i.value },
    });
    flow.registerKind({ name: 'okSink',  nin: 1, nout: 0, execute: (c, i) => ({ ok: i.value ?? i.ok ?? i[0] }) });
    flow.registerKind({ name: 'badSink', nin: 1, nout: 0, execute: (c, i) => ({ bad: i.value ?? i.bad ?? i[0] }) });
    const a = flow.addNode({ kind: 'src' });
    const t = flow.addNode({ kind: 'thresh' });
    const ok = flow.addNode({ kind: 'okSink' });
    const bad = flow.addNode({ kind: 'badSink' });
    flow.addEdge({ from: a, to: t });
    flow.addEdge({ from: t, fp: 0, to: ok });
    flow.addEdge({ from: t, fp: 1, to: bad });
    await flow.run();
    // bad branch should have received the value, ok branch should not.
    expect(flow.getNodeValue(bad)).toBeDefined();
    expect(flow.getNodeValue(ok)).toBeUndefined();
  });
});

describe('debug', () => {
  it('breakpoint pauses run, stepOver advances', async () => {
    flow.setRunStepDelay(0);
    flow.registerKind({ name: 'a', nin: 0, nout: 1, execute: () => ({ value: 1 }) });
    flow.registerKind({ name: 'b', nin: 1, nout: 0, execute: () => ({ done: true }) });
    const a = flow.addNode({ kind: 'a' });
    const b = flow.addNode({ kind: 'b' });
    flow.addEdge({ from: a, to: b });
    flow.setBreakpoint(b);
    let pausedCalled = false;
    flow.on('run:paused', (info) => { pausedCalled = true; expect(info.nodeId).toBe(b); });
    const runP = flow.run();
    await tick(40);
    expect(pausedCalled).toBe(true);
    expect(flow.isPaused()).toBe(true);
    flow.resume();
    await runP;
    expect(flow.getNodeValue(b)).toBeDefined();
  });
});
