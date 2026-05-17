# 4 · Performance at Scale

zflow-graph is engineered to keep 60 fps at 100k nodes. This isn't an accident — it's the result of specific architectural choices you should understand if you want to push it.

## What runs where

```
JS heap                          WASM linear memory
─────────────                    ──────────────────
canvas2d ctx                     pos_x[]      ← Float32 view
WebGL context (opt)              pos_y[]      ← Float32 view
event listeners                  size_w[]     ← Float32 view
plugin instances                 size_h[]     ← Float32 view
metric history                   selected[]   ← Uint8  view
notes, frames (small)            edge_from[]  ← Uint32 view
                                 edge_to[]    ← Uint32 view
                                 spatial grid ← Zig-only
                                 undo stack   ← Zig-only
```

Reading `flow.V.posX[i]` is a **direct memory access** into WASM. There is no copy.

Mutating these arrays from JS works too — `flow.V.posX[5] = 100` moves node 5. But invalidate caches with `flow._gl?.markNodeDirty(5)` if WebGL is on.

## The three speeds

### Speed 1: small graphs (< 1k nodes)
Canvas2D handles everything. Pan, zoom, drag, rich text rendering — all at 60 fps. Don't even think about WebGL.

### Speed 2: medium graphs (1k – 5k nodes)
Canvas2D still works but starts to wobble with shadows and gradients. Two options:

```js
flow.options.edgeFlowSpeed = 0;     // disable particle animation
flow.options.hoverPreview = false;  // disable popover
```

Or just turn on WebGL:

```js
await flow.enableWebGL();
```

### Speed 3: large graphs (> 5k nodes)
WebGL is mandatory. Canvas2D for the body + edges is too slow. With WebGL:

- All node bodies → **one** instanced draw call
- All edges → **one** line draw call
- Text/badges/ports → still Canvas2D, but **LOD-gated** (skipped below zoom 0.4)
- Camera moves → uniform-only, **zero buffer uploads**

```js
const flow = await ZFlow.create({
  container,
  wasmUrl: '/zflow.wasm',
  webglThreshold: 2000,   // auto-enable past this many nodes
});
```

## Bulk operations

Adding nodes one by one is fine for ~100. Above that, bulk:

```js
// SLOW — emits change + runs hooks + dirties everything 50,000 times
for (let i = 0; i < 50000; i++) flow.addNode({ kind: 'process', x: i * 10, y: 0 });

// FAST — same result in ~50ms
flow.addNodesBulk(
  Array.from({ length: 50000 }, (_, i) => ({ kind: 'process', x: i * 10, y: 0 }))
);
```

Same for edges:

```js
flow.addEdgesBulk(specs);
```

Both return arrays of created ids in input order. They suspend event emission during the loop and emit a single `change` at the end.

## LOD (Level of Detail)

The library auto-degrades detail when zoom is low:

| Zoom         | What renders                                  |
| ------------ | --------------------------------------------- |
| `> 0.4`      | Everything: text, ports, badges, shadows, descriptions, sparklines |
| `0.35 – 0.4` | Skip text. Ports + selection visible.         |
| `0.25 – 0.35`| Skip ports too. Bodies + edges only.          |
| `< 0.25`     | Skip canvas overlay entirely. WebGL bodies only. |

With > 5,000 nodes, the threshold is bumped to `0.55` automatically — the rationale is that 5k nodes at zoom 0.4 are unreadable anyway.

You can override:

```js
// Currently the thresholds are internal constants. To override, fork the lib
// or skip your own detail-drawing in a plugin's beforeRender hook.
```

## Viewport culling

Two layers:

1. **Spatial grid in Zig** — `queryRect(minX, minY, maxX, maxY)` returns node ids whose AABB intersects the rect. O(1) average, O(k) where k = visible nodes. The library uses this for any graph > 300 nodes.

2. **JS frustum check** — for every returned id, verify it's actually inside the viewport. Cheap second pass.

This means the cost of rendering doesn't scale with total nodes — it scales with **visible** nodes. Zoomed out so 5 nodes are visible? You pay for 5 draws (plus the GL buffer which is constant per-frame).

## Memory profile

At 100k nodes, the WASM uses ~40 MB of linear memory:

- Node SoA: ~5 MB (8 typed arrays × 100k × varying widths)
- Edge SoA: ~3 MB (200k edges)
- Spatial grid: ~1 MB
- Snapshot stack (8 deep): ~33 MB

JS-side maps (titles, descriptions, colors) only allocate for nodes that actually have those fields. With `null` rich content, JS heap is < 5 MB even at 100k nodes.

If you need more than 100k nodes per graph, you have two options:
- Edit `NODE_CAP` in `src/core.zig` and rebuild WASM
- Use multiple flow instances and link them via a parent UI

## Drag performance

When you drag N selected nodes, the runtime needs to mark all edges touching them as dirty (so the GL bezier buffer regenerates). The naive implementation is `O(N × edges)` — for 25 nodes × 200k edges = 5M ops per frame, unusable.

zflow caches an adjacency map per-node:

```js
flow._ensureAdj();   // O(edges) once
flow._nodeAdj[id]    // → [edgeIdx, edgeIdx, ...] for that node
```

Drag becomes `O(N × avgDegree)` which is microseconds. The cache invalidates on add/delete edge.

## Memoization

For grids with many sources that don't change often:

```js
flow.setMemoization(true);
```

Each node's input hash (FNV-1a) is recorded after exec. On the next run, if the hash matches, the node is skipped and `node:cached` fires. Fast (~80µs per node for 1k-entry inputs).

Caveats:
- Skipped nodes don't update sparkline / status
- If `execute` has side effects (DB writes, network), you don't want this on
- Memoization invalidates per-node, not graph-wide — a downstream node may still re-run if its inputs hash changed

## Streaming + downstream propagation

Each `yield` from an async generator propagates through downstream nodes **synchronously** before the next yield. This means 10 yields × 4 downstream nodes = 40 executions, all in sequence.

If you need parallel pipelines, use separate streams:

```js
const a = flow.addNode({ kind: 'stream' });
const b = flow.addNode({ kind: 'stream' });
// They run independently — flow.run() will start both in parallel because
// async generators are awaited per node, but the topo walker processes them
// in order. For true parallelism, use Promise.all in your executor.
```

## Web Workers (manual)

The library runs entirely on the main thread. For CPU-heavy executors:

```js
flow.registerKind({
  name: 'heavy-compute',
  execute: async (ctx, ins) => {
    const worker = new Worker('./heavy-worker.js', { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
      worker.onerror = reject;
      ctx.signal.addEventListener('abort', () => worker.terminate());
      worker.postMessage(ins);
    });
  },
});
```

(Future versions may move auto-layout and force-layout to workers automatically.)

## Profiling

Easy fps monitor:

```js
let frames = 0, t0 = performance.now();
const orig = flow._loop.bind(flow);
flow._loop = () => { frames++; orig(); };
setInterval(() => {
  console.log('fps:', frames * 1000 / (performance.now() - t0));
  frames = 0; t0 = performance.now();
}, 500);
```

Or use the Chrome DevTools Performance tab. Look for:
- `_render` taking > 16ms per frame → CPU bound, try WebGL
- `_drawNode` calls > 1000/frame → enable viewport culling (already on > 300 nodes)
- Long GC pauses → check if you're allocating in a render hook

## What we don't optimize (yet)

- **Layout for huge graphs** — Sugiyama and force layout both run on main thread. Above 5k nodes they freeze the UI. Run them in a worker for now.
- **Streaming with very high frequency** — yielding > 200x/sec saturates the event loop with bubble animations. Throttle inside your generator.
- **HTML overlay nodes** — each one is a real DOM element. Don't create 1000 of them. Use canvas-rendered kinds at scale, HTML only for special-case interactive nodes.
- **Search at very large graphs** — `flow.search(query)` is O(n). For > 10k nodes, build your own index.

## Next

→ [Plugins](./05-plugins.md) — extend behavior without forking
