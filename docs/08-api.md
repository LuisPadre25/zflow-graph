# 8 · API Reference

Every public method, grouped by capability. For event payloads, see [Events](#events).

## Lifecycle

```js
static async ZFlow.create(opts) → ZFlow
```
Async constructor. Returns a ready ZFlow instance.

**Options:**
- `container: HTMLElement` (required) — host element
- `wasmUrl: string` OR `wasmBytes: Uint8Array | ArrayBuffer` (one required)
- `theme: 'dark' | 'light'` (default `'dark'`)
- `edgeStyle: 'bezier' | 'orthogonal'` (default `'bezier'`)
- `snapToGrid: boolean` (default `false`)
- `gridSize: number` (default `20`)
- `contextMenu: boolean` (default `true`)
- `keyboard: boolean` (default `true`) — install keyboard shortcuts
- `minimap: boolean` (default `false`)
- `animateEdges: boolean` (default `false`)
- `edgeFlowSpeed: number` (default `60`)
- `inlineMarkdown: boolean` (default `true`)
- `hoverPreview: boolean` (default `false`)
- `webglThreshold: number` (default `2000`) — auto-enable GL above this
- `stopOnError: boolean` (default `false`)
- `dblclickEditsTitle: boolean` (default `true`)

```js
flow.dispose()
```
Detach all listeners, remove canvas, release WASM views.

---

## Mutation

```js
flow.addNode(spec) → number          // returns node id or -1
flow.addEdge(spec) → number          // returns edge id or -1
flow.deleteSelection()
flow.moveNode(id, x, y)
flow.duplicateSelection(dx = 40, dy = 40)
flow.addNodesBulk(specs) → number[]  // bulk insert (returns ids in order)
flow.addEdgesBulk(specs) → number[]
```

**`addNode` spec fields:**
- `kind: string | number` — kind name or index
- `x`, `y` — world coords (default 0, 0)
- `w`, `h` — size (defaults from kind)
- `nin`, `nout` — override port counts
- `title`, `color`, `description`, `tags`, `status`, `progress`
- `image`, `checked`, `tasks`, `icon`, `links`
- `portIn`, `portOut` — per-node port label override
- `animate: false` — skip pop-in animation

**`addEdge` spec fields:**
- `from: number` — source node id (required)
- `to: number` — target node id (required)
- `fp: number` — source port index (default 0)
- `tp: number` — target port index (default 0)
- `label: string` — edge label

---

## Selection

```js
flow.setSelected(id, on)
flow.toggleSelected(id)
flow.clearSelection()
flow.selectAll()
flow.getSelection() → number[]
flow.nodeCount() → number
flow.edgeCount() → number
```

---

## Rich content

```js
flow.setNodeTitle(id, title)
flow.setNodeColor(id, hex)
flow.setNodeDescription(id, md)     // supports inline markdown
flow.setNodeTags(id, tags)          // string[]
flow.setNodeStatus(id, status)      // 'ok' | 'running' | 'error' | 'warn' | 'idle' | ...
flow.setNodeProgress(id, p)         // 0..1
flow.setNodeImage(id, url)
flow.setNodeChecked(id, bool)
flow.setNodeTasks(id, [{text, done}, ...])
flow.setNodeIcon(id, glyph)
flow.setNodeLinks(id, [{url, label}, ...])
flow.setPortInLabels(id, labels)
flow.setPortOutLabels(id, labels)
flow.setEdgeLabel(eid, label)
```

---

## Visual

```js
flow.setEdgeStyle('bezier' | 'orthogonal')
flow.setSnapToGrid(bool)
flow.setTheme('dark' | 'light')
flow.toggleTheme()
flow.setMinimap(bool)
flow.setHoverPreview(bool)
flow.setPathHighlight(bool)
flow.setEdgeAnimated(edgeId, bool)
flow.setAllEdgesAnimated(bool)
flow.setEdgeWaypoints(edgeId, points)
flow.clearEdgeWaypoints(edgeId)

flow.bringToFront(ids?)
flow.sendToBack(ids?)
flow.zoomTo(zoom)
flow.panTo(x, y)
flow.fitView(padding = 80)
flow.runAutoLayout()        // Sugiyama hierarchical
flow.runForceLayout(maxFrames = 220)
```

---

## Locks & read-only

```js
flow.lockNode(id, on = true)
flow.isLocked(id) → boolean
flow.setReadOnly(on)        // disables mutations
```

---

## Sticky notes

```js
flow.addNote(x, y, text = '', opts = {}) → number    // returns note id
flow.deleteNote(noteId)
```

---

## Frames (groups)

```js
flow.addFrame(x, y, w, h, label = 'Group', color = '#5b8def') → { id, ... }
flow.groupSelection(label = 'Group')
flow.deleteFrame(frameId)
flow.toggleFrameCollapse(frameIdx)
flow.isFrameCollapsed(frameIdx) → boolean
flow.enterSubflow(frameId)         // dim everything outside
flow.exitSubflow()
flow.registerSubflowFromFrame(frameId, opts) → kindName
```

---

## Bookmarks

```js
flow.setBookmark(slot, nodeId?)   // slot = 1..9
flow.jumpBookmark(slot)
```

---

## Multi-cursor presence

```js
flow.setRemoteCursor(userId, x, y, name?, color?)
flow.clearRemoteCursors()
```

(Wire to your real CRDT via the [Yjs adapter](./06-multiplayer.md) instead of calling these directly.)

---

## Kinds

```js
flow.registerKind(spec) → number    // returns kind index
flow.setKindExecutor(kindName, fn) → previousFn
```

Spec fields: see [Designing Kinds](./03-kinds.md).

---

## Runtime

```js
flow.run({ from?, filter?, signal? }) → Promise<{ executed, errors, values }>
flow.runFrom(nodeId) → Promise<result>
flow.runFrame(frameId) → Promise<result>
flow.stop()
flow.startLoop(intervalMs = 500)
flow.stopLoop()
flow.isRunning() → boolean
flow.setRunStepDelay(ms)
flow.setMemoization(bool)
flow.clearRuntimeState()

flow.setNodeInput(id, outputs)    // inject a node's output without running it
flow.setNodeParams(id, params)
flow.getNodeParams(id) → params
flow.getNodeValue(id) → output

flow.evalExpression(expr, extraScope?) → result
```

### Debugging

```js
flow.setBreakpoint(id, on = true)
flow.toggleBreakpoint(id)
flow.clearBreakpoints()
flow.setStepMode(on)
flow.stepOver()
flow.resume()
flow.isPaused() → boolean
```

### Streaming metrics

```js
flow.pushNodeMetric(id, value)
flow.clearNodeMetric(id)
```

---

## Validation

```js
flow.validateConnection(fromN, fp, toN, tp) → string | null   // null = ok
flow.setConnectionValidator(fn)
```

---

## Algorithms

```js
flow.shortestPath(from, to) → edgeIds[]
flow.criticalPath() → edgeIds[]
flow.findSCCs() → nodeIds[][]
flow.findCycles() → edgeIds[]
flow.colorByDegree()
flow.clearNodeColors()
flow.setReachableFrom(nodeId)
flow.clearReachable()
```

---

## Serialization

```js
flow.toJSON() → object
flow.loadJSON(data)
flow.exportSVG() → string
flow.exportPNG() → Promise<Blob>
```

---

## Imports

```js
flow.importMermaid(text)
flow.importDot(text)
```

---

## Plugins

```js
flow.use(plugin) → dispose fn
```

See [Plugin System](./05-plugins.md).

---

## Search

```js
flow.search(query) → nodeIds[]
flow.jumpToSearchHit(idx)
flow.clearSearch()
flow.openSearch()           // opens the search UI
```

---

## Command palette

```js
flow.openCommandPalette()   // toggles
flow.registerTemplate(name, builder)
flow.insertTemplate(name, x, y) → id
flow.listTemplates() → string[]
```

---

## Undo / redo

```js
flow.undo()
flow.redo()
flow.snapshot()             // manual save point
```

---

## WebGL

```js
await flow.enableWebGL(force = false) → bool
flow.disableWebGL()
```

---

## Inline editor

```js
flow.editNodeExpression(nodeId, field = 'title')   // 'title' | 'desc'
```

Opens a floating editor with autocomplete for `{{node_X.value}}` expressions and live preview.

---

## Drag-from-palette

```js
flow.makeDraggable(domElement, spec)
```

Wires a DOM element so dragging it into the canvas creates a node of the given kind.

---

## Events

```js
flow.on(event, callback)        // returns nothing; pass same fn to remove
```

| Event                  | Payload                                        |
| ---------------------- | ---------------------------------------------- |
| `change`               | (none)                                         |
| `select`               | nodeIds[]                                      |
| `node:dblclick`        | nodeId                                         |
| `edge:dblclick`        | edgeId                                         |
| `canvas:dblclick`      | { x, y } (world coords)                        |
| `theme`                | 'dark' | 'light'                               |
| `renderer`             | 'canvas2d' | 'webgl'                           |
| `connection:rejected`  | { fromN, fromP, toN, toP, reason }             |
| `plugin:installed`     | plugin name or object                          |
| `palette:drop`         | { id, x, y, spec }                             |
| `run:start`            | { order: nodeIds[] }                           |
| `run:done`             | { executed, errors, values }                   |
| `run:paused`           | { nodeId }                                     |
| `node:exec`            | { id, inputs }                                 |
| `node:emit`            | { id, outputs } — per emission incl. streaming |
| `node:done`            | { id, outputs }                                |
| `node:error`           | { id, error }                                  |
| `node:retry`           | { id, attempt, error }                         |
| `node:cached`          | { id }                                         |
| `node:log`             | { id, args }                                   |

---

## Direct WASM access

For advanced cases you can call WASM exports directly via `flow.w.*`:

```js
flow.w.hitTestNode(x, y) → nodeId | -1
flow.w.hitTestPort(x, y, tol) → packed | -1
flow.w.queryRect(minX, minY, maxX, maxY) → count
flow.w.nodeCount_() → number
flow.w.edgeCount_() → number
flow.w.nodeCap() → number
flow.w.edgeCap() → number
flow.w.snapshot()
flow.w.undo() → 0 | 1
flow.w.redo() → 0 | 1
```

`flow.V` exposes the typed-array views:

```js
flow.V.posX        // Float32Array (length = cap)
flow.V.posY
flow.V.sizeW
flow.V.sizeH
flow.V.kind        // Uint8Array
flow.V.nIn
flow.V.nOut
flow.V.selected
flow.V.edgeFromN   // Uint32Array
flow.V.edgeToN
flow.V.edgeFromP   // Uint8Array
flow.V.edgeToP
flow.V.edgeSel
flow.V.queryRes    // Uint32Array (results from queryRect)
```

Reading is always safe (zero-copy). Writing to these arrays bypasses event emission and dirty tracking — use the high-level methods unless you know what you're doing.

---

## Constants

```js
flow.kinds          // array of kind specs in registration order
flow.kindByName     // Map: name → index
flow.cam            // { x, y, zoom } — read-write, but use panTo/zoomTo for animation
flow.canvas         // the canvas element
flow.container      // the host element
flow.options        // mutable options object
```

---

That's the full surface. ~230 public methods + 16 events. Search by `Ctrl+F` in the docs to find anything.
