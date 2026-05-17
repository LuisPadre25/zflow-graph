import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFlow, tick } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); flow.setRunStepDelay(0); });
afterEach(() => flow?.dispose());

describe('plugin lifecycle', () => {
  it('init is called on use()', () => {
    const init = vi.fn();
    flow.use({ name: 'p', init });
    expect(init).toHaveBeenCalledWith(flow);
  });

  it('onNodeAdd fires for every addNode', () => {
    const onNodeAdd = vi.fn();
    flow.use({ onNodeAdd });
    flow.addNode({ kind: 'process' });
    flow.addNode({ kind: 'process' });
    expect(onNodeAdd).toHaveBeenCalledTimes(2);
  });

  it('onBeforeExec returning false skips the node', async () => {
    let executed = false;
    flow.registerKind({
      name: 'maybe', nin: 0, nout: 1,
      execute: () => { executed = true; return { value: 1 }; },
    });
    flow.use({ onBeforeExec: () => false });
    flow.addNode({ kind: 'maybe' });
    await flow.run();
    expect(executed).toBe(false);
  });

  it('onAfterExec sees output', async () => {
    flow.registerKind({ name: 'src', nin: 0, nout: 1, execute: () => ({ value: 5 }) });
    const seen = [];
    flow.use({ onAfterExec: (f, id, out) => seen.push({ id, out }) });
    flow.addNode({ kind: 'src' });
    await flow.run();
    expect(seen).toHaveLength(1);
    expect(seen[0].out).toEqual({ value: 5 });
  });

  it('extendAPI attaches methods to flow', () => {
    flow.use({ extendAPI: (f) => { f.shout = (s) => s.toUpperCase(); } });
    expect(flow.shout('hi')).toBe('HI');
  });

  it('dispose function removes the plugin', () => {
    const onNodeAdd = vi.fn();
    const remove = flow.use({ onNodeAdd });
    flow.addNode({ kind: 'process' });
    expect(onNodeAdd).toHaveBeenCalledTimes(1);
    remove();
    flow.addNode({ kind: 'process' });
    expect(onNodeAdd).toHaveBeenCalledTimes(1);   // not called again
  });

  it('plugin commands appear in palette', () => {
    flow.use({ commands: [{ label: 'My CMD', run: () => 'ran' }] });
    const cmds = flow._builtinCommands();
    const found = cmds.find((c) => c.label === 'My CMD');
    expect(found).toBeDefined();
    expect(found.run()).toBe('ran');
  });
});
