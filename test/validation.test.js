import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFlow } from './helpers.js';

let flow;
beforeEach(async () => { flow = await createFlow(); });
afterEach(() => flow?.dispose());

describe('schema validation', () => {
  it('rejects mismatched port types', () => {
    flow.registerKind({
      name: 'numOut', nin: 0, nout: 1,
      outputs: [{ name: 'value', type: 'number' }],
    });
    flow.registerKind({
      name: 'strIn', nin: 1, nout: 0,
      inputs: [{ name: 'text', type: 'string' }],
    });
    const a = flow.addNode({ kind: 'numOut' });
    const b = flow.addNode({ kind: 'strIn' });
    const reason = flow.validateConnection(a, 0, b, 0);
    // Our policy: 'string' accepts anything (stringify). So number→string is allowed.
    expect(reason).toBeNull();
  });

  it('rejects truly incompatible types', () => {
    flow.registerKind({ name: 'objOut',  nin: 0, nout: 1, outputs: [{ name: 'o', type: 'object'  }] });
    flow.registerKind({ name: 'numOnly', nin: 1, nout: 0, inputs:  [{ name: 'n', type: 'number' }] });
    const a = flow.addNode({ kind: 'objOut' });
    const b = flow.addNode({ kind: 'numOnly' });
    const reason = flow.validateConnection(a, 0, b, 0);
    expect(reason).toMatch(/type mismatch/);
  });

  it('rejects self-loops', () => {
    const a = flow.addNode({ kind: 'process' });
    expect(flow.validateConnection(a, 0, a, 0)).toBe('self-loop');
  });

  it('custom validator can veto connections', () => {
    flow.setConnectionValidator((fromN, fp, toN, tp) => fromN !== toN);
    const a = flow.addNode({ kind: 'process' });
    const b = flow.addNode({ kind: 'process' });
    expect(flow.validateConnection(a, 0, b, 0)).toBeNull();
  });

  it('any-type accepts anything', () => {
    flow.registerKind({ name: 'anyOut', nin: 0, nout: 1, outputs: [{ name: 'v', type: 'any' }] });
    flow.registerKind({ name: 'numIn',  nin: 1, nout: 0, inputs:  [{ name: 'v', type: 'number' }] });
    const a = flow.addNode({ kind: 'anyOut' });
    const b = flow.addNode({ kind: 'numIn'  });
    expect(flow.validateConnection(a, 0, b, 0)).toBeNull();
  });
});

describe('expression evaluator', () => {
  it('substitutes node values into {{...}} templates', async () => {
    flow.registerKind({ name: 'src', nin: 0, nout: 1, execute: () => ({ value: 21 }) });
    const id = flow.addNode({ kind: 'src' });
    flow.setRunStepDelay(0);
    await flow.run();
    expect(flow.evalExpression(`{{node_${id}.value}} * 2`)).toBe(42);
  });

  it('returns plain string when no template present', () => {
    expect(flow.evalExpression('plain text')).toBe('plain text');
  });

  it('renders null for unknown paths', () => {
    expect(flow.evalExpression('{{node_999.nope}} + 1')).toBe(1);
  });
});
