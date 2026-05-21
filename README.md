# @luispm/zflow-graph

> WASM-powered node-edge graph editor + execution runtime. No framework. 100k nodes at 60 fps. Built-in multiplayer, WebGL, sub-flows.

[![npm version](https://img.shields.io/npm/v/@luispm/zflow-graph.svg)](https://www.npmjs.com/package/@luispm/zflow-graph)
[![license](https://img.shields.io/npm/l/@luispm/zflow-graph.svg)](LICENSE)

Most graph libraries make you choose:

- React Flow looks polished but can't pass ~5k nodes and depends on React
- ComfyUI runs flows but isn't a library
- Drawio is the size of a small OS
- tldraw is great at sketches but doesn't know what a port is

**@luispm/zflow-graph picks none of those tradeoffs.** It is a single self-contained ES module backed by a Zig→WASM core that ships in ~200 KB and runs in any browser tab, Electron, or Tauri-style desktop shell. It is an editor *and* a runtime.

## Quick start

```bash
npm install @luispm/zflow-graph
```

```js
import { ZFlow } from '@luispm/zflow-graph';

const flow = await ZFlow.create({
  container: document.getElementById('app'),
  wasmUrl: '/node_modules/@luispm/zflow-graph/dist/zflow.wasm',
});

// Register a kind with an executable body.
flow.registerKind({
  name: 'double',
  nin: 1, nout: 1,
  portIn: ['value'], portOut: ['value'],
  execute: (ctx, ins) => ({ value: ins.value * 2 }),
});

const a = flow.addNode({ kind: 'input',  x: -200, y: 0, title: '21' });
const b = flow.addNode({ kind: 'double', x:    0, y: 0 });
const c = flow.addNode({ kind: 'output', x:  200, y: 0, title: 'Result' });

flow.addEdge({ from: a, to: b });
flow.addEdge({ from: b, to: c });

flow.setNodeInput(a, { value: 21 });
await flow.run();             // → c.value === 42
console.log(flow.getNodeValue(c));
```

## Why use it

| Capability                              | @luispm/zflow-graph | React Flow | tldraw | Drawio |
| --------------------------------------- | :---------: | :--------: | :----: | :----: |
| WASM core (no framework)                |      ✅      |      ❌      |   ❌    |   ❌    |
| 100k nodes @ 60 fps                     |      ✅      |      ❌      |   ⚠️   |   ❌    |
| Built-in graph execution runtime         |      ✅      |      ❌      |   ❌    |   ❌    |
| Real CRDT multiplayer (Yjs adapter)     |      ✅      |   ❌ (Pro)   |   ✅    |   ❌    |
| WebGL renderer (instanced, opt-in)      |      ✅      |      ❌      |   ✅    |   ❌    |
| Touch + pinch + pen                     |      ✅      |      ✅      |   ✅    |   ⚠️   |
| Sub-flows reusable as kinds             |      ✅      |   ❌ (Pro)   |   ❌    |   ❌    |
| Streaming async generator nodes         |      ✅      |      ❌      |   ❌    |   ❌    |
| Inline expressions `{{node_X.value}}`   |      ✅      |      ❌      |   ❌    |   ❌    |
| Schema type validation on edges         |      ✅      |      ✅      |   ❌    |   ❌    |
| Plugin lifecycle hooks                  |      ✅      |   ⚠️ React   |   ❌    |   ✅    |
| Mermaid + DOT import                    |      ✅      |      ❌      |   ❌    |   ✅    |
| Critical-path / SCC / cycles            |      ✅      |      ❌      |   ❌    |   ❌    |
| Bundle gz                               |    ~140 KB    |   180 KB   | 320 KB | 1.1 MB |
| Framework dep                           |    None     |   React    | React  |  none  |

## Architecture in 30 seconds

```
┌─────────────────────────────────────────────────────────┐
│  Your app                                                │
│    ├─ import { ZFlow } from '@luispm/zflow-graph'                │
│    └─ flow.addNode(), flow.run(), flow.on(...)           │
├─────────────────────────────────────────────────────────┤
│  zflow.js (~180 KB ES module, no deps)                   │
│    Canvas2D renderer ◄─ overlay text/UI ─┐               │
│    WebGL renderer (opt-in, instanced) ◄──┘               │
│    Runtime: topo, async, retry, memo, streaming, debug   │
│    Plugin lifecycle · Yjs adapter · expression evaluator │
├─────────────────────────────────────────────────────────┤
│  zflow.wasm (~740 KB Zig WASM)                           │
│    SoA storage · spatial grid · snapshot undo            │
│    Sugiyama + force layouts · SCC + critical-path        │
│    Zero-copy Float32/Uint32 views into linear memory     │
└─────────────────────────────────────────────────────────┘
```

The JS holds typed-array **views** over WASM linear memory — there is no copy on read. The WASM never grows its memory after init, so views stay valid forever.

## Concepts

### Kinds
A kind is the type of a node: its color, shape, ports, and optionally its executable body.

```js
flow.registerKind({
  name: 'http-request',
  color: '#5b8def', badge: 'H', w: 180, h: 70,
  inputs:  [{ name: 'url',     type: 'string' }],
  outputs: [{ name: 'body',    type: 'string' }],
  retry:   { n: 3, delay: 500 },
  execute: async (ctx, ins) => {
    ctx.setProgress(0.3);
    const res = await fetch(ins.url, { signal: ctx.signal });
    return { body: await res.text() };
  },
});
```

### The runtime
Calling `flow.run()` walks the graph in topological order, calling each node's `execute(ctx, inputs)`. Outputs flow through edges. The runtime supports:

- **Async** — `execute` may return a `Promise`
- **Streaming** — `execute` may return an `AsyncGenerator` that `yield`s multiple values
- **Retry** — declarative `retry: { n, delay }`
- **Memoization** — `flow.setMemoization(true)` skips nodes whose inputs hash matches the previous run
- **Abort** — `flow.stop()` propagates an `AbortSignal` to every `ctx.signal`
- **Breakpoints** — `flow.setBreakpoint(id)` pauses before exec; `flow.stepOver()` to advance

### Multiplayer (Yjs)
Real-time co-editing via [Yjs](https://github.com/yjs/yjs). The adapter is opt-in — `yjs` is **not** a runtime dependency unless you import the adapter.

```js
import { bindYjs } from '@luispm/zflow-graph/adapters/yjs';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const ydoc = new Y.Doc();
const provider = new WebsocketProvider('wss://demos.yjs.dev/ws', 'my-room', ydoc);
bindYjs(flow, ydoc, {
  userName: 'Alice',
  color: '#c062e8',
  awareness: provider.awareness,
});
```

Open two tabs of your app: nodes, edges, drags, and cursors sync at ~30 Hz.

### Performance: opt-in WebGL
For graphs beyond ~5k nodes, enable the WebGL renderer:

```js
await flow.enableWebGL();   // auto-enables past options.webglThreshold (default 2000)
```

The GL path uses `ANGLE_instanced_arrays` to paint every node body in a **single draw call**. Canvas2D continues to handle text, ports, badges, and UI on top. Pan/zoom is uniform-only — zero buffer uploads.

### Sub-flows as kinds
Wrap a group of nodes inside a frame, then turn that frame into a reusable kind:

```js
const frameId = flow.addFrame(0, 0, 400, 200, 'auth pipeline').id;
// ... add nodes inside the frame ...
const kindName = flow.registerSubflowFromFrame(frameId, { name: 'authPipe' });

// Now you can instantiate the whole sub-flow as a single node anywhere:
flow.addNode({ kind: 'authPipe', x: 600, y: 100 });
```

The library auto-detects inputs and outputs of the sub-flow based on which inner nodes lack inside-graph predecessors / successors.

## Common patterns

These are the patterns most apps actually need. Skip if you only want the toy example above.

### Loading a graph from your own data model

If you already have a `{ nodes, edges }` shape with **your own string ids**, use `loadGraph`. It wipes the canvas and inserts everything in one atomic transaction — single `change` event, single undo snapshot — and resolves the `from`/`to` refs by your ids automatically.

```js
const idMap = flow.loadGraph({
  nodes: [
    { id: 'svc_users', kind: 'service', x: 0,   y: 0, title: 'Users API' },
    { id: 'db_main',   kind: 'db',      x: 200, y: 0, title: 'PostgreSQL' },
  ],
  edges: [
    { from: 'svc_users', to: 'db_main', label: 'SELECT' },
  ],
});

idMap.get('svc_users')              // → 0  (zflow numeric id)
flow.findNodeByUserId('db_main')    // → 1
```

The user id you passed is **also persisted in `data.__id`**, so it survives `toJSON()` → `loadJSON()` round-trips and remote edits over Yjs.

### Free-form metadata per node (`data`)

Need to attach a domain object, a database row id, a logical ref — anything? Use `data`. It is a `Map<zid, any>` round-tripped through `toJSON`/`loadJSON` and remapped automatically after deletes.

```js
const id = flow.addNode({
  kind: 'service',
  x: 0, y: 0,
  data: { serviceId: 'svc_users', tenant: 'acme', uptime: 0.998 },
});

flow.getNodeData(id).serviceId      // → 'svc_users'
flow.setNodeData(id, { ...flow.getNodeData(id), uptime: 0.999 });
```

When the user deletes a node, zflow compacts its internal arrays. The `data` map (and every other JS-side map — titles, colors, bookmarks, breakpoints, etc.) is remapped to match. **You do not need to maintain a side table** of `logicalId → zid`.

### Atomic mutations (`transaction`)

By default every `addNode`/`addEdge`/`setNode*` call fires a `change` event and is undoable individually. For bulk programmatic edits, wrap them so listeners see one consolidated update and the undo stack gets one entry:

```js
flow.transaction(() => {
  for (const row of bigPayload) {
    flow.addNode({ kind: 'service', x: row.x, y: row.y, data: row });
  }
  flow.runAutoLayout();
});
// Listeners hear ONE 'change'. Undo rolls back the whole batch.
```

Nesting is safe — only the outermost call commits. The same effect is built into `addNodesBulk`, `addEdgesBulk`, and `loadGraph`.

### Coordinate spaces (overlays, tooltips, custom DOM)

The canvas uses a world space (your node coords) and a screen space (DOM pixels). The pair of helpers converts between them so you can position popovers, custom HUDs, or hit-test against your own logic:

```js
// User clicked somewhere on the canvas — where in world coords?
canvas.addEventListener('click', (ev) => {
  const wp = flow.screenToWorld(ev.clientX, ev.clientY);
  console.log('clicked at world', wp);  // { x, y }
});

// Position a custom React/DOM tooltip above node 7.
const p = flow.getNodePosition(7);                // { x, y, w, h } in world
const top = flow.worldToScreen(p.x, p.y - p.h/2); // → { x, y } in CSS pixels
tooltip.style.left = top.x + 'px';
tooltip.style.top  = top.y + 'px';

// Camera state for minimaps and view sync.
const cam = flow.getCamera();                     // { x, y, zoom } (snapshot)
```

### Programmatic selection and single-node delete

```js
flow.setSelection([3, 7, 12]);    // replace the entire selection
flow.deleteNode(5);                // delete just one — keeps the rest of selection
flow.startEditTitle(5);            // open the inline title editor
```

## API at a glance

```js
// Lifecycle
const flow = await ZFlow.create({ container, wasmUrl });
flow.dispose();

// Loading & atomic edits
flow.loadGraph({ nodes, edges })       // accepts your own ids, returns Map<userId, zid>
flow.transaction(fn)                    // one 'change' event + one undo snapshot
flow.findNodeByUserId(userId)           // look up zid by the id you passed to loadGraph
flow.toJSON() / loadJSON(data)

// Mutation
flow.addNode(spec) / addEdge(spec) / moveNode(id, x, y)
flow.deleteSelection() / deleteNode(id)
flow.addNodesBulk(specs) / addEdgesBulk(specs)   // batch (50k nodes in ~50ms)

// Selection
flow.setSelection([ids])                // replace selection
flow.setSelected(id, on) / toggleSelected(id) / clearSelection() / selectAll()
flow.getSelection()

// Coordinate helpers (overlays / tooltips)
flow.screenToWorld(cx, cy) / worldToScreen(wx, wy)
flow.getCamera() / getNodePosition(id)
flow.startEditTitle(id)

// Rich content per node
flow.setNodeTitle / Description / Color / Tags / Status / Progress
flow.setNodeImage / Checked / Tasks / Icon / Links
flow.setNodeData(id, anyObject) / getNodeData(id)   // free-form metadata bag

// Runtime
flow.registerKind({ name, execute, retry, inputs, outputs, ... })
flow.run({ from?, filter?, signal? })
flow.runFrom(nodeId) / runFrame(frameId)
flow.stop() / startLoop(ms) / stopLoop()
flow.setBreakpoint(id) / stepOver() / resume() / isPaused()
flow.setNodeInput(id, value) / getNodeValue(id)
flow.setNodeParams(id, params)     // for built-in kinds: const, if
flow.evalExpression('{{node_3.value}} * 2')

// Algorithms
flow.shortestPath(from, to) / criticalPath() / findSCCs() / findCycles()

// Export
flow.exportSVG() / exportPNG()

// Imports
flow.importMermaid(text) / importDot(text)

// Layout
flow.runAutoLayout() / runForceLayout() / fitView() / zoomTo() / panTo()

// Plugins
flow.use({ init, onNodeAdd, onBeforeExec, ... })

// Multiplayer (separate import)
import { bindYjs } from '@luispm/zflow-graph/adapters/yjs'

// Performance
await flow.enableWebGL() / disableWebGL()
flow.setMemoization(true)
```

## Documentation

Full guides in [`docs/`](./docs):
1. [Getting Started](./docs/01-getting-started.md) — first 15 minutes
2. [The Runtime](./docs/02-runtime.md) — make your graph actually compute
3. [Designing Kinds](./docs/03-kinds.md) — schemas, ports, async, streaming
4. [Performance at Scale](./docs/04-performance.md) — WebGL, bulk, LOD, 100k nodes
5. [Plugin System](./docs/05-plugins.md) — lifecycle hooks
6. [Multiplayer (Yjs)](./docs/06-multiplayer.md) — real-time co-editing
7. [Recipes](./docs/07-recipes.md) — paste-and-run examples
8. [API Reference](./docs/08-api.md) — every method, every event

See the [examples folder](./examples) for working demos:
- `basic.html` — 3-node minimum
- `custom-kinds.html` — Plugin API
- `showcase.html` — full feature parade
- `runtime.html` — graph execution live
- `multiplayer.html` — Yjs CRDT in two tabs
- `powers.html` — schema validation + touch + WebGL
- `plugins-and-debug.html` — lifecycle hooks + breakpoints + sub-flows
- `stress.html` — 50k+ nodes WebGL benchmark

## Loading WASM

By default, `ZFlow.create({ wasmUrl })` fetches the WASM. For inline / offline scenarios, pre-load and pass bytes:

```js
const wasmBytes = await fetch('./zflow.wasm').then(r => r.arrayBuffer());
const flow = await ZFlow.create({ container, wasmBytes });
```

If you bundle, copy `node_modules/@luispm/zflow-graph/dist/zflow.wasm` to your `public/` or static-asset directory and point `wasmUrl` at it.

## Limits

- Hard cap of 100,000 nodes / 200,000 edges per instance (compile-time in the WASM core)
- Spatial grid covers ±8192 world units; nodes outside this range are still selectable but not in `queryRect` results
- Snapshot-based undo keeps the last 8 states — large graphs make snapshots costly
- The WebGL renderer requires `ANGLE_instanced_arrays` (essentially every browser since 2014); falls back to per-node draws otherwise
- Yjs adapter sync rate is throttled to 30 Hz on position changes

## Building from source

You need Zig 0.16+ and Node 18+.

```bash
git clone https://github.com/LuisPadre25/zflow-graph
cd zflow-graph
npm install
zig build           # produces dist/zflow.wasm
npm run build:js    # produces dist/zflow.{esm,umd}{,.min}.js
npm test            # 61 tests across 7 files
```

## Security

See [SECURITY.md](./SECURITY.md) for the honest threat model. TL;DR:

- All user-controlled strings in DOM overlays are HTML-escaped to prevent XSS.
- Zero runtime dependencies. Yjs is opt-in.
- `flow.use(plugin)` and `kind.execute` run with full page privileges — only install plugins you trust.
- `evalExpression()` uses `new Function` — do not pass expressions from untrusted users.
- Client-side JavaScript is **always readable**. There is no technical way to hide it. Use a license, or move sensitive logic to a server.
- Minified bundles ship **without sourcemaps** to avoid leaking the source to CDN deployments.

To report a vulnerability: `luis.padre21@gmail.com` with `[@luispm/zflow-graph security]` in subject.

## License

MIT
