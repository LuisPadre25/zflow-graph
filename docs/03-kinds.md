# 3 · Designing Kinds

Kinds are the API surface your end-users see. Treat them like the public API of your app — name them well, give them sensible defaults, validate their inputs.

## Full kind spec

```js
flow.registerKind({
  // ── Visual ────────────────────────────────────────────────────────────
  name: 'http-get',           // required, unique
  color: '#5b8def',           // CSS hex, used for header + ports
  badge: 'H',                 // 1-2 chars or emoji, shown top-left
  w: 200, h: 80,              // default size in world units
  shape: 'rect',              // 'rect' | 'diamond' | 'ellipse' | 'hexagon' | 'circle' | 'round' | 'subroutine'

  // ── Ports ─────────────────────────────────────────────────────────────
  nin: 1, nout: 2,            // number of input and output ports
  portIn:  ['url'],           // labels (used as keys in execute's `ins`)
  portOut: ['body', 'error'], // labels for outputs

  // ── Schema (optional) ─────────────────────────────────────────────────
  inputs:  [{ name: 'url',   type: 'string', required: true }],
  outputs: [{ name: 'body',  type: 'string' },
            { name: 'error', type: 'string' }],

  // ── Runtime ───────────────────────────────────────────────────────────
  execute: async (ctx, ins) => { /* ... */ },
  retry:   { n: 3, delay: 500 },     // automatic retry policy

  // ── HTML overlay (alternative to canvas) ──────────────────────────────
  html: false,
  template: null,                     // see below
});
```

Every field is optional except `name`. Defaults are sane.

## Naming conventions that won't bite you later

- Use **kebab-case** for `name`: `http-get`, `sql-query`, `email-send`
- Reserve `process` / `input` / `output` for the built-ins
- Group with prefixes: `db-read`, `db-write`, `db-migrate`
- The `name` is what shows up in `flow.toJSON()` — once you ship, **don't rename**, or old saved graphs break. Add a new kind and deprecate the old one.

## Ports: labels vs indices

Without `portIn`/`portOut`, inputs are addressable only by index:

```js
flow.registerKind({ name: 'foo', nin: 2 /* no portIn */, execute: (ctx, ins) => {
  ins[0];   // first input
  ins[1];   // second
  ins.in0;  // alias
  ins.in1;
}});
```

With labels, you also get named access:

```js
flow.registerKind({ name: 'foo', nin: 2, portIn: ['user', 'token'], execute: (ctx, ins) => {
  ins.user;
  ins.token;
  // ins[0] and ins.in0 still work
}});
```

**Always declare labels** for kinds with more than one port. It makes the executor readable.

## Schema (validation at connection time)

Schemas don't change runtime behavior — they prevent invalid connections at the editor level:

```js
flow.registerKind({
  name: 'add',
  inputs:  [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }],
  outputs: [{ name: 'sum', type: 'number' }],
});

flow.registerKind({
  name: 'concat',
  inputs:  [{ name: 'text', type: 'string' }],
});

// In the editor, dragging from add's 'sum' port to concat's 'text' port
// shows a red toast "type mismatch: number → string" and rejects.
```

Built-in compatibility rules:
- Same type → ok
- Either side is `'any'` → ok
- Numeric types (`number`, `int`, `float`, `integer`) are interchangeable
- `string` accepts everything (string is the universal type — everything stringifies)
- Otherwise → mismatch

You can override the rules entirely with a custom validator:

```js
flow.setConnectionValidator((fromN, fp, toN, tp) => {
  // Block self-loops
  if (fromN === toN) return false;
  // Otherwise allow
  return true;
});
```

## Patterns: source nodes

Sources have `nin: 0`. They're triggered when `flow.run()` reaches them in topo order:

```js
flow.registerKind({
  name: 'now',
  nin: 0, nout: 1,
  portOut: ['ms'],
  execute: () => ({ ms: Date.now() }),
});
```

Or driven externally:

```js
flow.registerKind({ name: 'input-slot', nin: 0, nout: 1 });   // no execute

const slot = flow.addNode({ kind: 'input-slot' });
flow.setNodeInput(slot, { value: 42 });
// → every downstream tick sees 42 from this slot
```

## Patterns: sink nodes

Sinks have `nout: 0`. They produce side effects (DB write, UI update, log):

```js
flow.registerKind({
  name: 'console-log',
  nin: 1, nout: 0,
  portIn: ['value'],
  execute: (ctx, ins) => { console.log(ins.value); /* return undefined */ },
});
```

A sink's return value (if any) is still stored in `flow._values` so debug UI can show it, but downstream nodes don't get it (there are none).

## Patterns: branching / control flow

```js
flow.registerKind({
  name: 'switch',
  nin: 1, nout: 3,
  portIn:  ['value'],
  portOut: ['gt100', 'gt50', 'else'],
  execute: (ctx, ins) => {
    if (ins.value > 100) return { gt100: ins.value };
    if (ins.value > 50)  return { gt50:  ins.value };
    return { else: ins.value };
  },
});
```

Downstream nodes on **non-firing** branches don't execute that tick. They sit idle.

## Patterns: stateful nodes

Need state across runs? Stash it on the node via `setNodeParams`:

```js
flow.registerKind({
  name: 'counter',
  nin: 0, nout: 1,
  execute: (ctx) => {
    const p = ctx.params;
    p.count = (p.count || 0) + 1;
    flow.setNodeParams(ctx.nodeId, p);
    return { count: p.count };
  },
});
```

Or use closure-captured Maps for module-level state:

```js
const counts = new Map();
flow.registerKind({
  name: 'counter',
  execute: (ctx) => {
    counts.set(ctx.nodeId, (counts.get(ctx.nodeId) || 0) + 1);
    return { count: counts.get(ctx.nodeId) };
  },
});
```

## Patterns: streaming

```js
flow.registerKind({
  name: 'every',
  nin: 0, nout: 1,
  execute: async function* (ctx) {
    while (!ctx.signal.aborted) {
      yield { tick: Date.now() };
      await new Promise((r) => setTimeout(r, ctx.params.intervalMs || 1000));
    }
  },
});

const t = flow.addNode({ kind: 'every' });
flow.setNodeParams(t, { intervalMs: 500 });
flow.run();   // runs forever (until flow.stop())
```

## Patterns: HTML overlay nodes

When canvas isn't enough — e.g., you want a form node with input fields:

```js
flow.registerKind({
  name: 'form',
  html: true,
  template: `
    <div style="padding:12px;">
      <input class="user-input" placeholder="name" style="width:100%;padding:6px;background:#0b0f17;border:1px solid #5b8def;border-radius:4px;color:white;">
      <button class="submit-btn" style="margin-top:8px;width:100%;padding:6px;background:#5b8def;color:white;border:0;border-radius:4px;">Submit</button>
    </div>
  `,
  w: 220, h: 110, nin: 0, nout: 1,
  execute: (ctx) => ({ value: ctx.params.lastSubmit || null }),
});

// Hook up listeners after creating the node:
const id = flow.addNode({ kind: 'form', x: 0, y: 0 });
// Wait one frame for the DOM to mount, then:
requestAnimationFrame(() => {
  const el = flow._htmlOverlays.get(id);
  el.querySelector('.submit-btn').onclick = () => {
    const val = el.querySelector('.user-input').value;
    flow.setNodeParams(id, { lastSubmit: val });
    flow.runFrom(id);
  };
});
```

HTML nodes are real DOM. They participate in pan/zoom (their position is synced every frame). Events bubble normally.

## Validation in `execute`

Schemas catch wrong types at edit time, but you should still validate at runtime:

```js
execute: async (ctx, ins) => {
  if (typeof ins.url !== 'string') throw new Error('url required');
  if (!ins.url.startsWith('http')) throw new Error('url must be absolute');
  // ...
}
```

Errors surface in `node:error` events and color the node red.

## Documenting kinds for end-users

If your app is an editor for end-users, expose a palette / sidebar. Save kind metadata for tooltips:

```js
flow.registerKind({
  name: 'http-get',
  meta: {
    description: 'Send an HTTP GET request and return the body.',
    docs: 'https://yourapp.com/docs/http-get',
  },
});

// In your sidebar UI:
const cat = flow.kinds[flow.kindByName.get('http-get')];
console.log(cat.meta?.description);
```

(Anything you pass to `registerKind` not in the spec list above is preserved on the kind object.)

## Next

→ [Performance at Scale](./04-performance.md) — make it fly with 50k+ nodes
