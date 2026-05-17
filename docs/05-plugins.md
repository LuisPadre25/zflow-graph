# 5 · Plugin System

Plugins are how you extend zflow without forking. A plugin is a plain object with optional lifecycle hooks.

## Anatomy

```js
const myPlugin = {
  name: 'autosave',                     // for logging / display

  init:    (flow) => { /* called once on use() */ },
  dispose: (flow) => { /* called when removed */ },

  // Render hooks
  beforeRender: (flow, ctx) => {},
  afterRender:  (flow, ctx) => {},

  // Mutation hooks
  onNodeAdd:    (flow, nodeId, spec) => {},
  onNodeDelete: (flow, nodeId) => {},
  onEdgeAdd:    (flow, edgeIdx, spec) => {},

  // Runtime hooks
  onBeforeExec: (flow, nodeId, inputs) => {},   // return false → skip exec
  onAfterExec:  (flow, nodeId, output) => {},

  // Other
  onConnect:    (flow, fromN, fp, toN, tp) => {}, // return false → reject
  onChange:     (flow) => {},
  onSelectionChange: (flow, ids) => {},

  // Bulk additions
  kinds:    [{ name: 'foo', execute: ... }],
  commands: [{ label: 'Do thing', run: () => {} }],
  extendAPI: (flow) => { flow.myMethod = () => 42; },
};

const dispose = flow.use(myPlugin);
// ... later ...
dispose();   // remove the plugin
```

All fields are optional. Plugins with no hooks are valid (e.g., for bundling kinds).

## Example: autosave to localStorage

```js
flow.use({
  name: 'autosave',
  init: (f) => {
    const saved = localStorage.getItem('graph');
    if (saved) f.loadJSON(JSON.parse(saved));
  },
  onChange: (f) => {
    localStorage.setItem('graph', JSON.stringify(f.toJSON()));
  },
});
```

## Example: fps overlay

```js
flow.use({
  name: 'fps',
  _frames: 0, _t0: 0, _fps: 0,
  init() { this._t0 = performance.now(); },
  afterRender: function (f, ctx) {
    this._frames++;
    const now = performance.now();
    if (now - this._t0 > 500) {
      this._fps = Math.round(this._frames * 1000 / (now - this._t0));
      this._frames = 0; this._t0 = now;
    }
    ctx.save();
    ctx.font = '600 11px ui-monospace, Consolas, monospace';
    ctx.fillStyle = this._fps >= 55 ? '#5bd17a' : this._fps >= 30 ? '#f0b93a' : '#e8462b';
    ctx.fillText(`${this._fps} fps`, f.canvas.width - 80, 22);
    ctx.restore();
  },
});
```

Note: hooks receive `flow` and `ctx` as the **first arguments**. If you use a method on the plugin object (with `function () {}`), `this` is the plugin itself. With arrow functions, `this` is the surrounding scope. Choose accordingly.

## Example: confirmation before destructive ops

```js
flow.use({
  name: 'confirm-delete',
  onNodeDelete: (f, nodeId) => {
    const title = f.titles.get(nodeId);
    if (title === 'production-db') {
      const ok = confirm(`Really delete '${title}'?`);
      if (!ok) return false;   // (currently not enforced — see note below)
    }
  },
});
```

> **Note:** `onNodeDelete` doesn't yet support cancellation via `return false`. The hook fires after the deletion. Wrap `flow.deleteSelection()` in your own UI code if you need to block.

## Example: registering many kinds at once

```js
flow.use({
  name: 'database-kinds',
  kinds: [
    { name: 'db-query',  execute: async (ctx, ins) => {/*...*/} },
    { name: 'db-insert', execute: async (ctx, ins) => {/*...*/} },
    { name: 'db-update', execute: async (ctx, ins) => {/*...*/} },
  ],
});
```

The `kinds:` array is shorthand for calling `flow.registerKind()` for each entry during `init`.

## Example: extending the API

```js
flow.use({
  name: 'graph-stats',
  extendAPI: (f) => {
    f.stats = () => ({
      nodes:    f.nodeCount(),
      edges:    f.edgeCount(),
      avgDegree: f.edgeCount() * 2 / Math.max(1, f.nodeCount()),
    });
  },
});

console.log(flow.stats());
```

Consumers now use `flow.stats()` as if it were built-in.

## Example: command palette entries

```js
flow.use({
  name: 'export-pdf',
  commands: [
    {
      label: 'Export to PDF',
      hotkey: 'Ctrl+Shift+P',
      run: () => myPDFExport(flow.toJSON()),
    },
    {
      label: 'Sync to backend',
      run: async () => {
        await fetch('/api/save', { method: 'POST', body: JSON.stringify(flow.toJSON()) });
      },
    },
  ],
});
```

These appear in `Ctrl+K`. The `hotkey` field is display-only — wire actual hotkeys yourself with `keydown` listeners if you want them globally bound.

## Example: rejecting connections

```js
flow.use({
  name: 'no-cross-region',
  onConnect: (f, fromN, fp, toN, tp) => {
    const fromRegion = f.tags.get(fromN)?.find(t => t.startsWith('region:'));
    const toRegion   = f.tags.get(toN)?.find(t => t.startsWith('region:'));
    if (fromRegion && toRegion && fromRegion !== toRegion) {
      console.warn('Cross-region connections forbidden');
      return false;
    }
  },
});
```

Returning `false` causes the connection to be rejected. The user sees the "type mismatch" toast (we should add a way to customize the message — TODO).

## Example: instrument executor calls (poor-man's APM)

```js
flow.use({
  name: 'apm',
  _starts: new Map(),
  onBeforeExec(f, id) { this._starts.set(id, performance.now()); },
  onAfterExec(f, id) {
    const dur = performance.now() - this._starts.get(id);
    if (dur > 100) console.warn(`slow node ${id}: ${dur.toFixed(1)}ms`);
  },
});
```

## Example: a complete logging plugin

```js
function loggingPlugin(opts = {}) {
  const prefix = opts.prefix || '[flow]';
  return {
    name: 'logger',
    onNodeAdd:    (f, id, spec) => console.log(prefix, 'add node', id, spec.kind),
    onEdgeAdd:    (f, id, spec) => console.log(prefix, 'add edge', spec.from, '→', spec.to),
    onBeforeExec: (f, id)        => console.log(prefix, '▸', id),
    onAfterExec:  (f, id, out)   => console.log(prefix, '✓', id, out),
    onNodeDelete: (f, id)        => console.log(prefix, '✗', id),
  };
}

flow.use(loggingPlugin({ prefix: '[myapp]' }));
```

You can also pass a function — it's called with `flow` and should return a plugin object:

```js
flow.use((flow) => ({
  name: 'auto-fit',
  onChange: () => flow.fitView(),
}));
```

## What plugins **cannot** do

- They cannot prevent rendering (only modify it via `afterRender`)
- They cannot replace the WASM core
- They cannot intercept events between the WASM and JS layers — the hooks only fire at the JS-side public API boundary
- They cannot stop another plugin from running (no ordering control yet)

If you need any of these, you've reached the limits of plugins — fork the source.

## Security note

A plugin runs with **full access** to your page. It can read DOM, send fetches, modify global state. Treat plugins like npm packages: only install what you trust.

If you build a plugin marketplace where users install third-party plugins, you'd need to sandbox each plugin in a Worker or iframe — out of scope for the core lib.

## Next

→ [Multiplayer](./06-multiplayer.md) — real-time co-editing with Yjs
