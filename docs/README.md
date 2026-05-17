# zflow-graph · Documentation

Guides ordered from "I want to play" to "I want to ship".

## Tutorials (read in order)
1. [Getting Started](./01-getting-started.md) — install, first graph, first run · **15 min**
2. [The Runtime](./02-runtime.md) — make your graph actually compute things · **20 min**
3. [Designing Kinds](./03-kinds.md) — schemas, ports, async, retry, streaming · **20 min**
4. [Performance at Scale](./04-performance.md) — WebGL, bulk ops, LOD, 100k nodes · **15 min**

## Guides (read as needed)
5. [Plugin System](./05-plugins.md) — lifecycle hooks, recipes
6. [Multiplayer (Yjs)](./06-multiplayer.md) — real-time co-editing
7. [Recipes](./07-recipes.md) — worked examples you can paste

## Reference
8. [API Reference](./08-api.md) — every public method, every event

---

## What zflow-graph actually is

A graph editor *and* a runtime in one ES module. You can:

- **Build editors** — the user drags nodes, connects ports, edits properties
- **Run the graph** — each node has an `execute()` function; the runtime walks topology and propagates values through edges
- **Embed both** — your app is the editor for end-users *and* the runtime that runs their work

This is the same shape as n8n, ComfyUI, Unreal Blueprints, Scratch, Node-RED. The difference: zflow-graph is **a library**, not a product. It runs anywhere you have a DOM and a WASM-capable JS engine.

## When to use it

| You want to build…                          | Use zflow? |
| ------------------------------------------- | :--------: |
| A workflow automation tool (n8n / Zapier)   |     ✅     |
| A visual ML pipeline editor (ComfyUI clone) |     ✅     |
| A live data dashboard with node graph       |     ✅     |
| A diagram editor (Drawio replacement)       |     ✅     |
| A game-engine blueprint editor              |     ✅     |
| A simple flowchart for docs                 |   ⚠️ overkill   |
| A whiteboard / sketching tool               |   ❌ (use tldraw) |
| A code diff visualizer                      |   ❌ (use d3)    |

## When NOT to use it

- You need IE11 support. zflow needs ES2020 and WASM.
- Your graph is purely static / read-only and < 100 nodes. SVG is fine for that.
- You need server-side rendering. zflow renders in the browser (or Electron/Tauri/WebView2 — same shape).
- You want to obfuscate the source against piracy. JavaScript isn't obfuscatable. See [SECURITY.md](../SECURITY.md).

## The mental model in 3 sentences

1. The graph lives in a **WASM core** (Zig). JS holds zero-copy views into it.
2. Each **node** has a **kind**. Kinds are templates: shape, color, ports, and an optional `execute()` body.
3. When you call `flow.run()`, the runtime walks nodes in topological order, calls `execute(ctx, inputs)`, and propagates outputs through edges.

Everything else — multiplayer, undo, layouts, sub-flows, animations — is built on those three primitives.

## A note on the docs style

These are **executable docs**. Every code block is a real snippet you can paste into an HTML file with zflow imported. No pseudocode. If a snippet doesn't work as written, that's a bug in the docs or the library — report it.
