# 6 · Multiplayer with Yjs

@luispm/zflow-graph ships an opt-in [Yjs](https://github.com/yjs/yjs) adapter for real-time collaborative editing. Two browser tabs (or two users on different machines) editing the same graph see each other's changes within ~30ms.

## How it works

- Nodes live in a `Y.Map` keyed by stable UUIDs
- Edges live in another `Y.Map`
- Position updates are throttled to 30 Hz
- Awareness (cursors, selection) uses Yjs' built-in awareness protocol
- Conflicts resolve via Yjs' CRDT semantics — last write wins per field, no merge UI needed

The adapter is **opt-in**. If you don't import it, Yjs isn't loaded and `flow.toJSON()` works as a standalone snapshot.

## Quick start

You'll need `yjs` and a provider. For the public demo server:

```bash
npm install yjs y-websocket
```

```js
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ZFlow } from '@luispm/zflow-graph';
import { bindYjs } from '@luispm/zflow-graph/adapters/yjs';

const flow = await ZFlow.create({ container, wasmUrl: '/zflow.wasm' });

const ydoc = new Y.Doc();
const provider = new WebsocketProvider('wss://demos.yjs.dev/ws', 'my-room', ydoc);

bindYjs(flow, ydoc, {
  userName: 'Alice',
  color: '#c062e8',
  awareness: provider.awareness,
});
```

Now open the same URL in another tab. Add a node in tab A — it appears in tab B.

## What syncs

| Operation                  | Synced? |
| -------------------------- | :-----: |
| `flow.addNode(...)`        |   ✅    |
| `flow.addEdge(...)`        |   ✅    |
| `flow.moveNode(id, x, y)`  |   ✅ (throttled to 30 Hz)  |
| Drag a node                |   ✅    |
| `flow.setNodeTitle(...)`   |   ✅    |
| `flow.setNodeColor(...)`   |   ✅    |
| `flow.deleteSelection()`   |   ✅    |
| Resize a node              |   ✅    |
| Cursor movement            |   ✅ via awareness |
| Selection                  |   ⚠️ adapter has the hook but doesn't broadcast yet |
| Frames / notes             |   ❌ not wired through yet |
| Runtime state (`flow._values`) | ❌ runtime is local-only by design |

## Configuration

```js
const binding = bindYjs(flow, ydoc, {
  // Required for awareness (cursors)
  awareness: provider.awareness,

  // Your identity
  userId:   'alice@example.com',          // unique, stable
  userName: 'Alice',                       // displayed in remote cursors
  color:    '#c062e8',                     // displayed in remote cursors
});

// Returned handle:
binding.ynodes      // Y.Map of nodes
binding.yedges      // Y.Map of edges
binding.ymeta       // Y.Map for arbitrary app metadata
binding.destroy()   // unhooks, restores original flow methods
```

## Providers

Yjs is provider-agnostic. Common choices:

- **y-websocket** — your own relay server (the simplest)
- **y-webrtc** — peer-to-peer, no server, works through a signaling channel
- **y-indexeddb** — local persistence (combine with one of the above for offline-first)
- **Liveblocks**, **Hocuspocus**, **Tiptap Hub** — commercial providers with auth + history
- **Custom** — talk directly to Yjs sync protocol over any transport

```js
import { IndexeddbPersistence } from 'y-indexeddb';
new IndexeddbPersistence('zflow-room', ydoc);   // offline-first
```

## Naming rooms

By default everyone using the public demo server shares the room `'my-room'`. Pick something specific:

```js
const ROOM = `zflow:${projectId}:${graphId}`;
const provider = new WebsocketProvider('wss://your-relay/ws', ROOM, ydoc);
```

Or use a hash in the URL so users can share links:

```js
const ROOM = location.hash.slice(1) || 'default';
```

## Hosting your own relay

The simplest setup:

```bash
npm install -g @y/y-websocket-server
PORT=1234 npx y-websocket-server
```

```js
new WebsocketProvider('ws://your-server:1234', 'my-room', ydoc);
```

For production, put it behind nginx/Caddy with TLS and authentication. Yjs has no built-in auth — that's the provider's job.

## Local persistence

Combine multiple providers — they all sync the same `Y.Doc`:

```js
new IndexeddbPersistence('local-cache', ydoc);
new WebsocketProvider('wss://...', 'room', ydoc);
```

Now your app works offline: writes go to IndexedDB immediately, then sync to the websocket when online.

## Handling auth

The adapter doesn't know about auth — that's between you and your provider. Pattern:

```js
const session = await getUser();
const provider = new WebsocketProvider('wss://...', ROOM, ydoc, {
  params: { token: session.jwt },
});
provider.awareness.setLocalStateField('user', {
  id: session.id,
  name: session.name,
  color: session.color,
});
```

Your relay server validates the JWT, refuses connection if invalid.

## Conflict resolution

Yjs is a CRDT — it merges all concurrent changes automatically, without ever asking. Specific behaviors:

- Two users edit the same node title → last write wins (per field)
- Two users move the same node → last position wins (you'll see it snap once)
- Two users delete the same node → both deletes are idempotent
- Two users add nodes simultaneously → both nodes appear (no conflict)
- One user deletes a node while another adds an edge to it → the edge ends up dangling (Yjs doesn't enforce referential integrity)

For graph integrity guarantees, you'd need to layer your own validation on top.

## Limits and quirks

- **No history replay yet.** The adapter syncs current state. To play back history, use Yjs' `UndoManager` or a provider with versioning (Liveblocks, Hocuspocus).
- **Position throttling is 30 Hz** — if you drag a node very fast, peers see it jump. Tweak the throttle in `src/adapters/yjs.js` if you need higher rate.
- **No selection sync.** Each user has their own selection. The remote cursor only shows their pointer position.
- **Memory leak risk with very long sessions.** Yjs accumulates operations. Periodically snapshot (`Y.encodeStateAsUpdate`) and start fresh if your sessions span weeks.
- **Frames and sticky notes don't sync yet.** TODO.

## Example: complete multi-user editor

See [examples/multiplayer.html](../examples/multiplayer.html) for a working demo. Open it in two tabs, add nodes, drag them — they sync.

## Next

→ [Recipes](./07-recipes.md) — concrete worked examples
