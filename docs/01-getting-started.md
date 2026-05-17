# 1 · Getting Started

## Install

```bash
npm install @luispm/zflow-graph
```

If you're not using a bundler, grab the UMD build from unpkg:

```html
<script src="https://unpkg.com/@luispm/zflow-graph/dist/zflow.umd.min.js"></script>
```

That gives you `window.ZFlow`.

## Your first graph (full HTML, copy-paste)

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>my first zflow</title>
  <style>
    html, body { margin: 0; height: 100%; background: #07090f; color: #e6edf3; }
    #app { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { ZFlow } from 'https://unpkg.com/@luispm/zflow-graph/dist/zflow.esm.js';

    const flow = await ZFlow.create({
      container: document.getElementById('app'),
      wasmUrl: 'https://unpkg.com/@luispm/zflow-graph/dist/zflow.wasm',
    });

    const a = flow.addNode({ kind: 'input',   x: -200, y: 0, title: 'Source' });
    const b = flow.addNode({ kind: 'process', x:    0, y: 0, title: 'Transform' });
    const c = flow.addNode({ kind: 'output',  x:  200, y: 0, title: 'Sink' });

    flow.addEdge({ from: a, to: b });
    flow.addEdge({ from: b, to: c });

    flow.fitView();
  </script>
</body>
</html>
```

You now have an interactive editor. Drag nodes, pan with right-click, zoom with scroll, double-click to edit titles.

## Loading WASM in a real bundler

If you use Vite / Webpack / Rollup, you need to make the `.wasm` accessible at runtime. Two options:

**Option A — copy to public folder (simplest):**
```bash
cp node_modules/@luispm/zflow-graph/dist/zflow.wasm public/
```
```js
const flow = await ZFlow.create({ container, wasmUrl: '/zflow.wasm' });
```

**Option B — bundle as bytes:**
```js
import wasmUrl from '@luispm/zflow-graph/dist/zflow.wasm?url';   // Vite
// or
import wasmUrl from '@luispm/zflow-graph/wasm';                   // package.json export

const flow = await ZFlow.create({ container, wasmUrl });
```

## The 7 built-in kinds

zflow ships with seven generic primitives. They have no `execute` — they're shapes for you to wire up:

| Name         | Shape    | Ports     | Used for                              |
| ------------ | -------- | --------- | ------------------------------------- |
| `input`      | rect     | 0 in, 1 out  | source nodes                       |
| `process`    | rect     | 1 in, 1 out  | the general workhorse              |
| `filter`     | rect     | 1 in, 1 out  | a process visually distinct        |
| `decision`   | diamond  | 1 in, 2 out  | branches (yes/no)                  |
| `output`     | rect     | 1 in, 0 out  | sinks                              |
| `aggregator` | hexagon  | 3 in, 1 out  | merge multiple inputs              |
| `branch`     | ellipse  | 1 in, 3 out  | one-to-many fan-out                |

Plus four executable built-ins for runtime work: `if`, `forEach`, `const`, `log`. See [the runtime guide](./02-runtime.md).

## Register your own kinds

Anything domain-specific lives in your code, not in the library:

```js
flow.registerKind({
  name: 'http',
  color: '#5b8def', badge: 'H',
  w: 180, h: 70,
  nin: 1, nout: 1,
  shape: 'rect',
});

const id = flow.addNode({ kind: 'http', x: 0, y: 0, title: 'GET /users' });
```

That's a visual node. To make it **executable**, give it an `execute`:

```js
flow.registerKind({
  name: 'http',
  execute: async (ctx, ins) => {
    const res = await fetch(ins.url, { signal: ctx.signal });
    return { body: await res.text() };
  },
});
```

Now `flow.run()` will actually fetch. See [the runtime guide](./02-runtime.md).

## Add rich content to nodes

```js
const id = flow.addNode({
  kind: 'process',
  x: 0, y: 0,
  title: 'Auth check',
  description: 'Validates **JWT** + checks `quota`',   // inline markdown
  tags: ['auth', 'critical'],
  status: 'running',                                    // ok / running / error / warn
  progress: 0.6,                                        // 0..1 → drawn as bar
  tasks: [
    { text: 'Verify JWT', done: true },
    { text: 'Check quota', done: false },
  ],
  icon: '🔐',
  image: 'https://example.com/icon.png',                // thumbnail inside the body
  links: [{ url: 'https://docs.app', label: 'docs' }],
  portIn: ['token'],
  portOut: ['ok', 'err'],
});
```

Or set these later:

```js
flow.setNodeTitle(id, 'New title');
flow.setNodeDescription(id, 'New desc');
flow.setNodeStatus(id, 'ok');
flow.setNodeProgress(id, 1);
flow.setNodeTasks(id, [{ text: 'done', done: true }]);
flow.setNodeImage(id, 'https://...');
```

## Listen to events

```js
flow.on('change', () => console.log('something changed'));
flow.on('select', (ids) => console.log('selected:', ids));
flow.on('node:dblclick', (id) => console.log('user dbl-clicked', id));
flow.on('edge:dblclick', (id) => console.log('user dbl-clicked edge', id));
```

Full event list in the [API reference](./08-api.md#events).

## Save / load

```js
const snapshot = flow.toJSON();
localStorage.setItem('my-graph', JSON.stringify(snapshot));

// Later, in another session:
const data = JSON.parse(localStorage.getItem('my-graph'));
flow.loadJSON(data);
```

The JSON is portable — you can ship it through Yjs, sync it to a backend, diff it, anything.

## Keyboard shortcuts (works out of the box)

| Key                    | Action                                |
| ---------------------- | ------------------------------------- |
| `Ctrl+A`               | Select all                            |
| `Ctrl+D`               | Duplicate selection                   |
| `Ctrl+C` / `Ctrl+V`    | Copy / Paste                          |
| `Ctrl+Z` / `Ctrl+Y`    | Undo / Redo                           |
| `Del`                  | Delete selection                      |
| `Tab` / `Shift+Tab`    | Cycle through nodes                   |
| `1`-`9`                | Bookmark current selection            |
| `Alt+1`-`Alt+9`        | Jump to bookmark                      |
| `Ctrl+G`               | Group selection into a frame          |
| `Ctrl+K`               | Open command palette                  |
| `Ctrl+F`               | Find in graph                         |
| `Ctrl+T`               | Toggle light / dark theme             |
| `Ctrl+M`               | Toggle minimap                        |
| `Ctrl+E`               | Toggle edge flow animation            |
| `F5` / `Shift+F5`      | Run / Stop graph execution            |
| `L`                    | Auto-layout (Sugiyama)                |
| `0`                    | Fit view                              |
| `Esc`                  | Cancel current operation              |
| `Alt+drag`             | Lasso select (free-form polygon)      |
| Right-click            | Context menu                          |
| Long-press (touch)     | Context menu                          |
| Two-finger pinch       | Zoom                                  |
| Two-finger drag        | Pan                                   |

## Next

→ [The Runtime](./02-runtime.md) — make your graph actually compute things
