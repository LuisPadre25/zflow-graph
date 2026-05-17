// zflow ↔ Yjs adapter — real multiplayer for the graph.
//
// Usage:
//   import { ZFlow } from '../zflow.js';
//   import { bindYjs } from '../adapters/yjs.js';
//   import * as Y from 'yjs';
//   import { WebsocketProvider } from 'y-websocket';
//
//   const flow = await ZFlow.create({ container, wasmUrl });
//   const ydoc = new Y.Doc();
//   new WebsocketProvider('wss://demos.yjs.dev', 'my-room', ydoc);
//   const binding = bindYjs(flow, ydoc, { userId: 'alice', userName: 'Alice', color: '#c062e8' });
//
// What it syncs:
//   • Nodes  (Y.Map keyed by stable client-side uuid → { id, kind, x, y, w, h, title, color, ... })
//   • Edges  (Y.Map keyed by uuid → { from, to, fp, tp, label })
//   • Awareness (cursor position, selection, name, color)
//
// Conflict policy: last-write-wins per field via Y.Map. Position updates are
// throttled to ~30 Hz so dragging produces ~smooth remote motion without
// flooding the wire.

const ZFLOW_UUID = Symbol('zflowUuid');

export function bindYjs(flow, ydoc, opts = {}) {
  const userId   = opts.userId   || 'user-' + Math.random().toString(36).slice(2, 8);
  const userName = opts.userName || userId;
  const userColor = opts.color   || pickColor(userId);

  const ynodes = ydoc.getMap('zflow.nodes');
  const yedges = ydoc.getMap('zflow.edges');
  const ymeta  = ydoc.getMap('zflow.meta');
  const aware  = opts.awareness || null; // y-protocols/awareness.Awareness, if provided

  // Bidirectional mapping between local numeric ids and stable Y uuids.
  const localToUuid = new Map(); // nodeId -> uuid
  const uuidToLocal = new Map(); // uuid -> nodeId
  const edgeLocalToUuid = new Map();
  const edgeUuidToLocal = new Map();

  let applyingRemote = false;            // re-entrancy guard
  let pendingPosFlush = null;            // throttle handle

  // ── Local → Remote ─────────────────────────────────────────────────
  // We intercept the high-level mutators by wrapping the WASM exports so
  // every change locally also writes to Yjs.
  const origAddNode = flow.addNode.bind(flow);
  flow.addNode = (spec = {}) => {
    const id = origAddNode(spec);
    if (id < 0 || applyingRemote) return id;
    const uuid = newUuid();
    localToUuid.set(id, uuid);
    uuidToLocal.set(uuid, id);
    ynodes.set(uuid, captureNode(flow, id, spec));
    return id;
  };

  const origAddEdge = flow.addEdge.bind(flow);
  flow.addEdge = (spec = {}) => {
    const id = origAddEdge(spec);
    if (id < 0 || applyingRemote) return id;
    const uuid = newUuid();
    edgeLocalToUuid.set(id, uuid);
    edgeUuidToLocal.set(uuid, id);
    const fromU = localToUuid.get(typeof spec.from === 'number' ? spec.from : -1);
    const toU   = localToUuid.get(typeof spec.to   === 'number' ? spec.to   : -1);
    yedges.set(uuid, { from: fromU, to: toU, fp: spec.fp ?? 0, tp: spec.tp ?? 0, label: spec.label || null });
    return id;
  };

  // Intercept deleteSelection so each removed local id pulls its uuid out of Y.
  const origDelete = flow.deleteSelection.bind(flow);
  flow.deleteSelection = () => {
    if (applyingRemote) return origDelete();
    const toRemove = [];
    for (let i = 0; i < flow.w.nodeCount_(); i++) if (flow.V.selected[i]) toRemove.push(i);
    origDelete();
    // Local ids shift after delete; clear the affected uuid mappings by re-scan.
    ydoc.transact(() => {
      for (const localId of toRemove) {
        const uuid = localToUuid.get(localId);
        if (uuid) { ynodes.delete(uuid); localToUuid.delete(localId); uuidToLocal.delete(uuid); }
      }
    }, 'local-delete');
  };

  // Throttle dragging updates.
  flow.on('change', () => {
    if (applyingRemote) return;
    if (pendingPosFlush) return;
    pendingPosFlush = setTimeout(() => {
      pendingPosFlush = null;
      ydoc.transact(() => {
        for (const [localId, uuid] of localToUuid) {
          if (localId >= flow.w.nodeCount_()) continue;
          const cur = ynodes.get(uuid);
          if (!cur) continue;
          const next = captureNode(flow, localId);
          if (cur.x !== next.x || cur.y !== next.y || cur.w !== next.w || cur.h !== next.h ||
              cur.title !== next.title || cur.color !== next.color) {
            ynodes.set(uuid, { ...cur, ...next });
          }
        }
      }, 'local-pos');
    }, 33);
  });

  // ── Remote → Local ─────────────────────────────────────────────────
  ynodes.observe((event) => {
    if (event.transaction.origin === 'local-pos') return;
    applyingRemote = true;
    try {
      event.changes.keys.forEach((change, uuid) => {
        if (change.action === 'add')    { addRemoteNode(uuid, ynodes.get(uuid)); }
        if (change.action === 'update') { updateRemoteNode(uuid, ynodes.get(uuid)); }
        if (change.action === 'delete') {
          const localId = uuidToLocal.get(uuid);
          if (localId !== undefined) {
            flow.w.setSelected(localId, 1);
            const orig = flow.deleteSelection;
            flow.deleteSelection = origDelete;            // bypass intercept
            try { flow.deleteSelection(); }
            finally { flow.deleteSelection = orig; }
            localToUuid.delete(localId);
            uuidToLocal.delete(uuid);
          }
        }
      });
    } finally { applyingRemote = false; }
  });

  yedges.observe((event) => {
    applyingRemote = true;
    try {
      event.changes.keys.forEach((change, uuid) => {
        if (change.action === 'add') {
          const e = yedges.get(uuid);
          const from = uuidToLocal.get(e.from), to = uuidToLocal.get(e.to);
          if (from !== undefined && to !== undefined) {
            const localId = origAddEdge({ from, to, fp: e.fp, tp: e.tp, label: e.label });
            edgeLocalToUuid.set(localId, uuid);
            edgeUuidToLocal.set(uuid, localId);
          }
        }
        if (change.action === 'delete') {
          // Local-side deletion isn't wired through a single API yet; leave as a TODO.
        }
      });
    } finally { applyingRemote = false; }
  });

  // ── Awareness (cursors + selection) ────────────────────────────────
  if (aware) {
    aware.setLocalStateField('user', { name: userName, color: userColor });
    flow.canvas.addEventListener('mousemove', (e) => {
      const wp = flow._s2w(e.clientX, e.clientY);
      aware.setLocalStateField('cursor', { x: wp.x, y: wp.y });
    });
    aware.on('change', () => {
      const states = aware.getStates();
      flow.clearRemoteCursors();
      for (const [clientId, state] of states) {
        if (clientId === aware.clientID) continue;
        const u = state.user || {}, c = state.cursor;
        if (c) flow.setRemoteCursor(String(clientId), c.x, c.y, u.name || String(clientId), u.color || '#5be0d0');
      }
    });
  }

  // ── Initial backfill: pull whatever's already in the Y.Doc ─────────
  applyingRemote = true;
  try {
    for (const [uuid, spec] of ynodes.entries()) addRemoteNode(uuid, spec);
    for (const [uuid, spec] of yedges.entries()) {
      const from = uuidToLocal.get(spec.from), to = uuidToLocal.get(spec.to);
      if (from !== undefined && to !== undefined) {
        const localId = origAddEdge({ from, to, fp: spec.fp, tp: spec.tp, label: spec.label });
        edgeLocalToUuid.set(localId, uuid);
        edgeUuidToLocal.set(uuid, localId);
      }
    }
  } finally { applyingRemote = false; }

  // ── Public adapter handle ──────────────────────────────────────────
  return {
    ynodes, yedges, ymeta, ydoc,
    userId, userName, userColor,
    destroy() {
      flow.addNode = origAddNode;
      flow.addEdge = origAddEdge;
    },
  };

  // ── helpers ────────────────────────────────────────────────────────
  function addRemoteNode(uuid, spec) {
    if (uuidToLocal.has(uuid)) return;
    const localId = origAddNode({
      kind: spec.kind, x: spec.x, y: spec.y,
      w: spec.w, h: spec.h, title: spec.title, color: spec.color,
    });
    if (localId < 0) return;
    localToUuid.set(localId, uuid);
    uuidToLocal.set(uuid, localId);
  }
  function updateRemoteNode(uuid, spec) {
    const localId = uuidToLocal.get(uuid);
    if (localId === undefined) return;
    if (spec.x !== undefined && spec.y !== undefined) {
      flow.V.posX[localId] = spec.x; flow.V.posY[localId] = spec.y;
    }
    if (spec.w !== undefined) flow.V.sizeW[localId] = spec.w;
    if (spec.h !== undefined) flow.V.sizeH[localId] = spec.h;
    if (spec.title) flow.titles.set(localId, spec.title);
    if (spec.color) flow.colors.set(localId, spec.color);
  }
  function deleteRemoteNode(uuid) {
    void uuid; // single-node delete not yet exposed in core; selection delete works
  }
}

function captureNode(flow, id, spec = {}) {
  const cat = flow.kinds[flow.V.kind[id]];
  return {
    kind: cat.name,
    x: flow.V.posX[id], y: flow.V.posY[id],
    w: flow.V.sizeW[id], h: flow.V.sizeH[id],
    title: flow.titles.get(id) || spec.title || null,
    color: flow.colors.get(id) || spec.color || null,
  };
}
function newUuid() {
  return 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
const PALETTE = ['#5b8def', '#c062e8', '#5bd17a', '#f0b93a', '#5be0d0', '#fb923c', '#e8462b'];
function pickColor(seed) {
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
