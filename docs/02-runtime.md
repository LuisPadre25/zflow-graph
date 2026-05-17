# 2 · The Runtime

This is the part most graph libraries don't have, and it's what makes zflow useful for real applications.

## The core idea

A **graph** is data. A **runtime** turns that data into computation.

When you call `flow.run()`, the runtime walks every node in **topological order** and calls its `execute(ctx, inputs)` function. The return value becomes the node's output. Outputs flow through edges to downstream nodes as their inputs.

```
[Source: random] → [×2] → [if >100] ─ ok ─→ [save]
                                    └ bad ─→ [alert]
```

If you give each box an `execute`, that diagram becomes a running program. That's it.

## Minimum viable example

```js
flow.registerKind({
  name: 'gen',
  nin: 0, nout: 1,
  portOut: ['value'],
  execute: () => ({ value: Math.random() * 100 }),
});

flow.registerKind({
  name: 'log',
  nin: 1, nout: 0,
  portIn: ['value'],
  execute: (ctx, ins) => { console.log('got', ins.value); },
});

const a = flow.addNode({ kind: 'gen' });
const b = flow.addNode({ kind: 'log' });
flow.addEdge({ from: a, to: b });

await flow.run();
// console: "got 73.2"
```

## How values flow through edges

The runtime expects `execute` to return **either** a primitive **or** an object whose keys match the kind's `portOut` labels:

```js
// Single output, one downstream port: return either form is fine.
execute: () => 42                          // primitive
execute: () => ({ value: 42 })             // object with 'value'
execute: () => ({ result: 42 })            // works if portOut: ['result']

// Multi-output (conditional routing): emit only the branch you want.
execute: (ctx, ins) => ins.x > 0
  ? { positive: ins.x }    // only this key is set → only 'positive' edge fires
  : { negative: ins.x };
```

The downstream node receives values keyed by **its** `portIn` labels:

```js
flow.registerKind({
  name: 'add',
  nin: 2, nout: 1,
  portIn:  ['a', 'b'],
  portOut: ['sum'],
  execute: (ctx, ins) => ({ sum: ins.a + ins.b }),
});
```

If no port labels are declared, inputs are exposed as `in0`, `in1`, `in2`, etc. (also indexable by number: `ins[0]`).

## The `ctx` object

Every `execute` receives a context with:

```js
execute: async (ctx, ins) => {
  ctx.nodeId          // this node's id
  ctx.signal          // AbortSignal — abort if flow.stop() is called
  ctx.params          // params set via flow.setNodeParams(id, params)
  ctx.emit(value)     // intermediate emission (for streaming)
  ctx.setProgress(p)  // 0..1 → drawn as a bar inside the node
  ctx.log(...args)    // emits a 'node:log' event
  ctx.metric(v)       // push a number to the live sparkline
  ctx.get(otherId)    // read the latest value of another node
  return { ... };     // final output
}
```

## Async, retry, abort

```js
flow.registerKind({
  name: 'fetch-user',
  retry: { n: 3, delay: 500 },                    // 3 attempts, 500ms between
  execute: async (ctx, ins) => {
    ctx.setProgress(0.1);
    const r = await fetch(`/api/users/${ins.id}`, { signal: ctx.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ctx.setProgress(0.9);
    return { user: await r.json() };
  },
});

const p = flow.run();
setTimeout(() => flow.stop(), 5000);   // give up after 5s
await p;
```

If a node throws after exhausting retries, its status becomes `'error'` and the runtime emits `node:error`. By default it continues with other nodes; set `flow.options.stopOnError = true` to abort.

## Streaming nodes (`async function*`)

A node can emit **multiple values over time** by returning an async generator:

```js
flow.registerKind({
  name: 'tick',
  nin: 0, nout: 1,
  execute: async function* (ctx) {
    for (let i = 0; i < 10; i++) {
      if (ctx.signal.aborted) return;
      yield { count: i };
      await new Promise((r) => setTimeout(r, 500));
    }
  },
});
```

Each `yield` propagates through downstream nodes **before** the next yield runs. So a `tick → log` graph prints 10 times, not 1.

## Conditional routing

Declare `portOut` labels and emit only the branches you want:

```js
flow.registerKind({
  name: 'threshold',
  nin: 1, nout: 2,
  portIn:  ['value'],
  portOut: ['high', 'low'],
  execute: (ctx, ins) => ins.value > 100
    ? { high: ins.value }   // 'low' edge does NOT fire
    : { low: ins.value },   // 'high' edge does NOT fire
});
```

Downstream nodes on the **non-firing** branch don't execute that tick. This is how you build if/else flow.

## Run modes

```js
await flow.run();                        // whole graph
await flow.runFrom(nodeId);              // only nodeId and its descendants
await flow.runFrame(frameId);            // only nodes inside a frame
await flow.run({ filter: (id) => ... }); // arbitrary predicate

flow.startLoop(500);                     // re-run every 500ms forever
flow.stopLoop();
flow.stop();                             // abort current run
```

## Memoization

If your inputs don't change, why re-compute?

```js
flow.setMemoization(true);

// First run executes everything
await flow.run();

// Second run skips nodes whose inputs hash matches the previous run
await flow.run();   // → most nodes hit cache; only changed ones re-run
```

Uses FNV-1a 32-bit hash (~80µs for ~1k-entry inputs). The cache invalidates per-node when its hash changes.

## Step-through debugging

```js
flow.setBreakpoint(suspectNodeId);

flow.on('run:paused', ({ nodeId }) => {
  console.log('paused at', nodeId);
  // Inspect:
  console.log('inputs:', flow._values.get(predecessor));
});

await flow.run();   // pauses at breakpoint
// In response to a UI button:
flow.stepOver();    // execute the breakpoint node and pause again at next
flow.resume();      // exit debug mode, continue normally
```

Or step through everything:

```js
flow.setStepMode(true);
await flow.run();           // pauses before every node
flow.stepOver();             // advance one at a time
```

## Driving the runtime from external state

Sometimes the graph has source nodes whose values you want to inject from outside:

```js
const sourceId = flow.addNode({ kind: 'gen' });

flow.setNodeInput(sourceId, { value: 42 });    // injects value
await flow.run();
// gen's execute didn't run; the injected value flows downstream
```

This is how UI controls (sliders, text inputs) drive a running graph.

## Reading the result

```js
await flow.run();
flow.getNodeValue(sinkId);        // → { received: 42 }
flow._values.get(sinkId);         // → same thing
```

## Events

```js
flow.on('run:start',   ({ order }) => {});
flow.on('run:done',    ({ executed, errors, values }) => {});
flow.on('run:paused',  ({ nodeId }) => {});
flow.on('node:exec',   ({ id, inputs }) => {});
flow.on('node:emit',   ({ id, outputs }) => {});     // includes streaming emissions
flow.on('node:done',   ({ id, outputs }) => {});
flow.on('node:error',  ({ id, error }) => {});
flow.on('node:retry',  ({ id, attempt, error }) => {});
flow.on('node:cached', ({ id }) => {});               // memoization skip
flow.on('node:log',    ({ id, args }) => {});         // from ctx.log()
```

## Visual cues automatic during a run

| What you see                              | Why                                        |
| ----------------------------------------- | ------------------------------------------ |
| Blue pulsing border on a node             | status === 'running'                       |
| Floating bubble with the emitted value    | per emission, auto                         |
| Edge thickens + glows blue                | data is currently flowing through it       |
| Progress bar inside node                  | `ctx.setProgress(p)` was called            |
| Sparkline at bottom of node               | numeric outputs accumulate over time       |
| Status dot top-right (green/red/blue)     | `status` field                             |

You can set `flow.setRunStepDelay(ms)` to pause between nodes so propagation is **visible**. Default 250ms — set to 0 for production speed.

## Next

→ [Designing Kinds](./03-kinds.md) — schemas, retry, and patterns for executable nodes
