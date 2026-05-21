// zflow — node-edge graph editor library (full version).
//
// Single ES module. Consumers do:
//   import { ZFlow } from './dist/zflow.js';
//   const flow = await ZFlow.create({ container, wasmUrl });
//
// Wraps a Zig WASM core (~200 KB) and a Canvas2D renderer. JS holds typed-
// array views over WASM linear memory for zero-copy reads. The memory
// contract: WASM allocates everything at init time and never grows again,
// so the views remain valid for the life of the instance.

// ── Default kinds shipped with the library ─────────────────────────────────
// Minimal flow primitives. Consumers extend with registerKind() for domain-
// specific kinds (service, database, queue, etc.).
const DEFAULT_KINDS = [
  { name: 'input',      color: '#5b8def', badge: 'I', w: 140, h: 60,  nin: 0, nout: 1, shape: 'rect' },
  { name: 'process',    color: '#e8b04b', badge: 'P', w: 160, h: 80,  nin: 1, nout: 1, shape: 'rect' },
  { name: 'filter',     color: '#5be0d0', badge: 'F', w: 160, h: 80,  nin: 1, nout: 1, shape: 'rect' },
  { name: 'decision',   color: '#c062e8', badge: 'D', w: 130, h: 130, nin: 1, nout: 2, shape: 'diamond' },
  { name: 'output',     color: '#5bd17a', badge: 'O', w: 140, h: 60,  nin: 1, nout: 0, shape: 'rect' },
  { name: 'aggregator', color: '#f0b93a', badge: '∑', w: 160, h: 120, nin: 3, nout: 1, shape: 'hexagon' },
  { name: 'branch',     color: '#e8462b', badge: 'B', w: 130, h: 130, nin: 1, nout: 3, shape: 'ellipse' },
  // Built-in control-flow kinds (execute-enabled).
  { name: 'if', color: '#c062e8', badge: '?', w: 150, h: 70, nin: 1, nout: 2, shape: 'diamond',
    portIn: ['value'], portOut: ['true', 'false'],
    execute: (ctx, ins) => {
      const v = ins.value ?? ins[0];
      const cond = ctx.params?.condition;
      let ok;
      if (typeof cond === 'function') ok = cond(v);
      else if (typeof cond === 'string') {
        // Serializable: condition is a JS expression where `value` and `v` are bound.
        try { ok = Function('value', 'v', `"use strict"; return (${cond});`)(v, v); }
        catch { ok = false; }
      } else ok = Boolean(v);
      return ok ? { true: v } : { false: v };
    },
  },
  { name: 'forEach', color: '#5be0d0', badge: '↻', w: 160, h: 70, nin: 1, nout: 1, shape: 'rect',
    portIn: ['array'], portOut: ['item'],
    execute: async (ctx, ins) => {
      const arr = ins.array ?? ins[0] ?? [];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      for (let i = 0; i < arr.length; i++) {
        if (ctx.signal.aborted) return;
        ctx.setProgress((i + 1) / arr.length);
        ctx.emit({ item: arr[i] });
        await new Promise((r) => setTimeout(r, 30));
      }
      return { item: arr[arr.length - 1] };
    },
  },
  { name: 'const', color: '#8b95a7', badge: 'K', w: 130, h: 56, nin: 0, nout: 1, shape: 'rect',
    portOut: ['value'],
    execute: (ctx) => ({ value: ctx.params?.value ?? 0 }),
  },
  { name: 'log', color: '#5b8def', badge: '◷', w: 160, h: 60, nin: 1, nout: 0, shape: 'rect',
    portIn: ['value'],
    execute: (ctx, ins) => { ctx.log(ins.value ?? ins[0]); return { received: ins.value ?? ins[0] }; },
  },
];

const DARK_THEME = {
  bg: '#07090f', panel: 'rgba(20,28,40,0.92)', border: 'rgba(255,255,255,0.10)',
  fg: '#e6edf3', muted: '#8b95a7', accent: '#f0b93a', hi: 'rgba(240,185,58,0.10)',
  grid: 'rgba(255,255,255,0.04)', gridDot: 'rgba(255,255,255,0.10)',
};
const LIGHT_THEME = {
  bg: '#f6f8fb', panel: 'rgba(255,255,255,0.96)', border: 'rgba(0,0,0,0.10)',
  fg: '#1d2330', muted: '#5a6577', accent: '#b8860b', hi: 'rgba(184,134,11,0.12)',
  grid: 'rgba(0,0,0,0.04)', gridDot: 'rgba(0,0,0,0.16)',
};

const HANDLE_CORNERS = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
const HANDLE_LEFTS  = new Set(['l', 'tl', 'bl']);
const HANDLE_RIGHTS = new Set(['r', 'tr', 'br']);
const HANDLE_TOPS   = new Set(['t', 'tl', 'tr']);
const HANDLE_BOTS   = new Set(['b', 'bl', 'br']);
const HANDLE_CURSOR = {
  tl: 'nwse-resize', br: 'nwse-resize',
  tr: 'nesw-resize', bl: 'nesw-resize',
  t:  'ns-resize',   b:  'ns-resize',
  l:  'ew-resize',   r:  'ew-resize',
};

export class ZFlow {
  /** Async constructor — loads the WASM and prepares the canvas. */
  static async create(opts) {
    const flow = new ZFlow();
    await flow._init(opts);
    return flow;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  async _init(opts) {
    if (!opts || !opts.container) throw new Error('zflow: container is required');
    this.container = opts.container;
    this.options = Object.assign({
      theme: 'dark', background: '#07090f',
      edgeStyle: 'bezier', snapToGrid: false, gridSize: 20,
      contextMenu: true, keyboard: true,
      minimap: false, animateEdges: false, edgeFlowSpeed: 60,
      commandPalette: true, search: true, inlineMarkdown: true,
    }, opts);
    this._theme = this.options.theme === 'light' ? LIGHT_THEME : DARK_THEME;
    if (this.options.theme === 'light') this.options.background = this._theme.bg;

    // Load WASM bytes.
    let wasmBytes;
    if (opts.wasmBytes) {
      wasmBytes = opts.wasmBytes instanceof Uint8Array ? opts.wasmBytes : new Uint8Array(opts.wasmBytes);
    } else if (opts.wasmUrl) {
      wasmBytes = new Uint8Array(await (await fetch(opts.wasmUrl)).arrayBuffer());
    } else {
      throw new Error('zflow: pass either { wasmUrl } or { wasmBytes }');
    }
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    this.w = instance.exports;
    if (this.w.init() === 0) throw new Error('zflow: WASM init OOM');

    const cap = this.w.nodeCap();
    const ecap = this.w.edgeCap();
    this.V = {
      posX:      new Float32Array(this.w.memory.buffer, this.w.posXPtr(),         cap),
      posY:      new Float32Array(this.w.memory.buffer, this.w.posYPtr(),         cap),
      sizeW:     new Float32Array(this.w.memory.buffer, this.w.sizeWPtr(),        cap),
      sizeH:     new Float32Array(this.w.memory.buffer, this.w.sizeHPtr(),        cap),
      kind:      new Uint8Array  (this.w.memory.buffer, this.w.kindPtr(),         cap),
      nIn:       new Uint8Array  (this.w.memory.buffer, this.w.nInPtr(),          cap),
      nOut:      new Uint8Array  (this.w.memory.buffer, this.w.nOutPtr(),         cap),
      selected:  new Uint8Array  (this.w.memory.buffer, this.w.selectedPtr(),     cap),
      edgeFromN: new Uint32Array (this.w.memory.buffer, this.w.edgeFromNodePtr(), ecap),
      edgeToN:   new Uint32Array (this.w.memory.buffer, this.w.edgeToNodePtr(),   ecap),
      edgeFromP: new Uint8Array  (this.w.memory.buffer, this.w.edgeFromPortPtr(), ecap),
      edgeToP:   new Uint8Array  (this.w.memory.buffer, this.w.edgeToPortPtr(),   ecap),
      edgeSel:   new Uint8Array  (this.w.memory.buffer, this.w.edgeSelectedPtr(), ecap),
      queryRes:  new Uint32Array (this.w.memory.buffer, this.w.queryResultsPtr(), cap),
    };

    // Kinds + per-node JS overlays.
    this.kinds = DEFAULT_KINDS.map((k) => ({ ...k }));
    this.kindByName = new Map();
    this.kinds.forEach((k, i) => this.kindByName.set(k.name, i));
    this.titles = new Map();
    this.colors = new Map();
    this.descriptions = new Map();
    // Free-form metadata bag, per-node. Consumers stash logical ids, business
    // domain refs, anything they want round-tripped through toJSON/loadJSON
    // without inventing their own Map<zid, ...> side table.
    this.data = new Map();
    this.tags = new Map();
    this.status = new Map();
    this.progress = new Map();
    this.image = new Map();        // nodeId -> image url
    this.checked = new Map();      // nodeId -> bool (optional checkbox)
    this.tasks = new Map();        // nodeId -> [{text, done}]
    this.icon = new Map();         // nodeId -> emoji/glyph
    this.links = new Map();        // nodeId -> [{ url, label? }]
    this.portIn = new Map();       // nodeId -> string[] (in port labels)
    this.portOut = new Map();      // nodeId -> string[] (out port labels)
    this.zOrder = new Map();       // nodeId -> z (default 0)
    this.bookmarks = new Map();    // slot 1..9 -> nodeId
    this.edgeLabels = new Map();
    this._imageCache = new Map();  // url -> { img, ready }
    this._nodeAddedAt = new Map(); // nodeId -> timestamp (pop animation)
    this._dyingNodes = [];         // [{ x,y,w,h,kind,color,t0 }] for fade-out
    this._dyingEdges = [];

    // Notes (sticky annotations) — JS-only entities.
    this.notes = [];               // [{ id, x, y, w, h, text, color }]
    this._noteSeq = 0;
    // Frames (groups) — JS-only entities.
    this.frames = [];              // [{ id, x, y, w, h, label, color }]
    this._frameSeq = 0;

    // Canvas + camera.
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `display:block;width:100%;height:100%;background:${this.options.background};cursor:default;outline:none;touch-action:none;user-select:none;`;
    this.canvas.tabIndex = 0;
    this.container.style.position = this.container.style.position || 'relative';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.cam = { x: 0, y: 0, zoom: 1 };
    this._panVel = { x: 0, y: 0, lastTs: 0 };
    this._clipboard = null;
    this._nudgeTimer = null;

    // Interaction state.
    this.listeners = new Map();
    this._mode = 'idle';
    this._dragStart = null;
    this._dragLast = null;
    this._hoveredNode = -1;
    this._hoveredEdge = -1;
    this._hoveredNodeSince = 0;
    this._previewedNode = -1;
    this._resizingHandle = null;
    this._marquee = null;
    this._lasso = null;
    this._alignGuides = null;
    this._edgeStart = null;
    this._edgeCursor = null;
    this._draggingNote = -1;
    this._noteDragLast = null;
    this._draggingFrame = -1;
    this._frameDragLast = null;
    this._resizingFrame = null;
    this._editingNote = -1;
    this._editingNoteEl = null;
    this._editingTitle = -1;
    this._editingTitleEl = null;
    this._focusFrame = -1;          // subflow focus
    this._htmlOverlays = new Map(); // nodeId -> DOM element
    this._previewEl = null;
    this._pathHighlightEnabled = false;
    this._focusedSet = null;
    this._lastFocusComputed = -2;

    // Right-click menu element (lazy, removed on dispose).
    this._menuEl = null;

    // ── New: locks, read-only, snap, reachable, presence, palette ─────
    this.locked = new Set();             // nodeId set — drag/resize blocked
    this.readOnly = false;
    this.snapToNodes = true;             // edge-alignment magnet to other nodes
    this._reachableSet = null;           // Set<nodeId> from setReachableFrom
    this.remoteCursors = new Map();      // userId -> { x, y, name, color, t }
    this._edgeWaypoints = new Map();     // edgeIdx -> [{ x, y }] mid-bends
    this._draggingWaypoint = null;       // { edgeIdx, wpIdx }
    this.frameCollapsed = new Set();     // frameIdx set
    this._paletteGhost = null;           // DOM element shown while dragging

    // ── live metrics, animation, search, templates, validation ─────────
    this.metrics = new Map();           // nodeId -> Float32Array rolling window
    this.metricMax = new Map();         // nodeId -> max for normalization
    this._metricCap = 32;
    this.animatedEdges = new Set();     // edgeIdx set for per-edge animation
    this._edgePhase = 0;                // global phase for flow particles
    this._connValidator = null;         // fn(fromN, fromP, toN, toP) -> bool
    this._templates = new Map();        // name -> { build(flow,x,y) }
    this._searchEl = null; this._searchQuery = ''; this._searchHits = [];
    this._cmdPaletteEl = null;
    this._minimapEl = null;             // canvas overlay
    this._minimapCtx = null;
    this._historyThumbs = [];           // [{ png, t }] (best-effort)
    if (this.options.minimap) this._setupMinimap();

    // ── Plugin system ───────────────────────────────────────────────
    this._plugins = [];
    this._hooks = {
      beforeRender: [], afterRender: [],
      onNodeAdd: [], onNodeDelete: [], onEdgeAdd: [],
      onBeforeExec: [], onAfterExec: [],
      onConnect: [], onSelectionChange: [], onChange: [],
    };

    // ── Graph runtime (opt-in, dormant until first run) ───────────────
    this._values = new Map();          // nodeId -> last output object
    this._running = false;
    this._runAbort = null;             // AbortController
    this._runSeq = 0;
    this._runOrder = null;             // cached topo order
    this._execHooks = new Map();       // kindIdx -> execute fn
    this._streamSrc = new Map();       // nodeId -> cancel fn
    this._runStepDelay = 250;          // ms pause between nodes (visible by default)
    this._valueBubbles = [];           // [{ nodeId, text, t0, dur }]
    this._activeEdges = new Map();     // edgeIdx -> expiry timestamp
    this._memoize = false;             // skip nodes whose inputs hash unchanged
    this._memoKeys = new Map();        // nodeId -> last hash
    this._retryStats = new Map();      // nodeId -> attempt count for current run
    this.breakpoints = new Set();      // nodeId set — pause before exec
    this._paused = false;              // step-through paused state
    this._resumeNext = null;           // resolver to continue from paused state
    this._stepMode = false;            // true → pause after each node
    this._subflows = new Map();        // kindName -> { nodes, edges, inputs, outputs }

    this._resize();
    this._resizeObs = new ResizeObserver(() => this._resize());
    this._resizeObs.observe(this.container);
    this._attachEvents();
    if (this.options.keyboard) this._attachKeyboard();
    this._loop();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._resizeObs?.disconnect();
    this.canvas?.remove();
    this._menuEl?.remove();
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    this.listeners.clear();
  }

  // ── Public mutation API ───────────────────────────────────────────────
  addNode(spec = {}) {
    if (this.readOnly) return -1;
    this._runOrder = null;
    const k = this._resolveKind(spec.kind ?? 'process');
    const cat = this.kinds[k];
    const id = this.w.addNode(
      spec.x ?? 0, spec.y ?? 0,
      spec.w ?? cat.w, spec.h ?? cat.h,
      k, spec.nin ?? cat.nin, spec.nout ?? cat.nout,
    );
    if (id < 0) return -1;
    if (spec.title)       this.titles.set(id, spec.title);
    if (spec.color)       this.colors.set(id, spec.color);
    if (spec.description) this.descriptions.set(id, spec.description);
    if (spec.tags)        this.tags.set(id, spec.tags.slice());
    if (spec.status)      this.status.set(id, spec.status);
    if (spec.progress !== undefined) this.progress.set(id, spec.progress);
    if (spec.image)       this.image.set(id, spec.image);
    if (spec.checked !== undefined) this.checked.set(id, !!spec.checked);
    if (spec.tasks)       this.tasks.set(id, spec.tasks.map((t) => ({ ...t })));
    if (spec.icon)        this.icon.set(id, spec.icon);
    if (spec.links)       this.links.set(id, spec.links.map((l) => ({ ...l })));
    if (spec.portIn)      this.portIn.set(id, spec.portIn.slice());
    if (spec.portOut)     this.portOut.set(id, spec.portOut.slice());
    if (spec.data !== undefined) this.data.set(id, spec.data);
    if (spec.animate !== false) this._nodeAddedAt.set(id, performance.now());
    if (this._hooks) this._runHook('onNodeAdd', id, spec);
    this._emit('change');
    return id;
  }

  /** Insert many nodes at once. Skips per-node emit/hook overhead; emits once at end. */
  addNodesBulk(specs) {
    if (this.readOnly) return [];
    this._runOrder = null;
    const ids = new Array(specs.length);
    const wasSilent = this._suspendEvents; this._suspendEvents = true;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const k = this._resolveKind(s.kind ?? 'process');
      const cat = this.kinds[k];
      const id = this.w.addNode(
        s.x ?? 0, s.y ?? 0,
        s.w ?? cat.w, s.h ?? cat.h,
        k, s.nin ?? cat.nin, s.nout ?? cat.nout,
      );
      if (id < 0) { ids[i] = -1; continue; }
      if (s.title) this.titles.set(id, s.title);
      if (s.color) this.colors.set(id, s.color);
      if (s.data !== undefined) this.data.set(id, s.data);
      ids[i] = id;
    }
    this._suspendEvents = wasSilent;
    if (this._gl) this._gl.markAllDirty();
    this._emit('change');
    return ids;
  }

  /** Insert many edges at once. */
  addEdgesBulk(specs) {
    if (this.readOnly) return [];
    this._runOrder = null;
    const ids = new Array(specs.length);
    const wasSilent = this._suspendEvents; this._suspendEvents = true;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      ids[i] = this.w.addEdge(s.from, s.fp ?? 0, s.to, s.tp ?? 0);
      if (s.label && ids[i] >= 0) this.edgeLabels.set(ids[i], s.label);
    }
    this._suspendEvents = wasSilent;
    if (this._gl) this._gl.markAllDirty();
    this._adjDirty = true;
    this._emit('change');
    return ids;
  }

  addEdge(spec = {}) {
    if (this.readOnly) return -1;
    this._runOrder = null;
    this._adjDirty = true;
    const eid = this.w.addEdge(spec.from, spec.fp ?? 0, spec.to, spec.tp ?? 0);
    if (eid >= 0) {
      if (spec.label) this.edgeLabels.set(eid, spec.label);
      if (this._hooks) this._runHook('onEdgeAdd', eid, spec);
      this._emit('change');
    }
    return eid;
  }

  moveNode(id, x, y) { this.w.moveNode(id, x, y); this._emit('change'); }
  _guardWrite() { return !this.readOnly; }

  deleteSelection() {
    if (this.readOnly) return;
    this._runOrder = null;
    // Capture dying entities for fade-out before WASM compacts the arrays.
    this._captureDying();
    // Build pre-compaction remaps so JS-side overlays (titles, data, etc.)
    // stay aligned with the new node ids after WASM slides survivors down.
    const nodeRemap = this._buildNodeRemap();
    const edgeRemap = this._buildEdgeRemap();
    const n = this.w.deleteSelected();
    if (n > 0) {
      this._applyNodeRemap(nodeRemap);
      this._applyEdgeRemap(edgeRemap);
      this.w.snapshot();
      this._emit('change');
    }
    return n;
  }
  /** Compute Map<oldId, newId|null> matching WASM's deleteSelected compaction. */
  _buildNodeRemap() {
    const n = this.w.nodeCount_();
    const m = new Map();
    let newId = 0;
    for (let i = 0; i < n; i++) {
      if (this.V.selected[i]) m.set(i, null);
      else m.set(i, newId++);
    }
    return m;
  }
  /** Same idea for edges: dropped if either endpoint is selected or edge itself. */
  _buildEdgeRemap() {
    const m = this.w.edgeCount_();
    const out = new Map();
    let newE = 0;
    for (let e = 0; e < m; e++) {
      const a = this.V.edgeFromN[e], b = this.V.edgeToN[e];
      if (this.V.selected[a] || this.V.selected[b] || this.V.edgeSel[e]) out.set(e, null);
      else out.set(e, newE++);
    }
    return out;
  }
  _applyNodeRemap(remap) {
    const nodeMaps = [this.titles, this.colors, this.descriptions, this.tags, this.status,
                      this.progress, this.image, this.checked, this.tasks, this.icon,
                      this.links, this.portIn, this.portOut, this.zOrder, this.data];
    for (const orig of nodeMaps) this._remapKeyedMap(orig, remap);
    this._remapKeyedSet(this.locked, remap);
    this._remapKeyedSet(this.breakpoints, remap);
    this._remapKeyedMap(this._values, remap);
    this._remapKeyedMap(this._memoKeys, remap);
    this._remapKeyedMap(this.metrics, remap);
    this._remapKeyedMap(this.metricMax, remap);
    // Bookmarks: slot -> nodeId reverse mapping.
    const newBookmarks = new Map();
    for (const [slot, oldId] of this.bookmarks) {
      const newId = remap.get(oldId);
      if (newId != null) newBookmarks.set(slot, newId);
    }
    this.bookmarks = newBookmarks;
  }
  _applyEdgeRemap(remap) {
    this._remapKeyedMap(this.edgeLabels, remap);
    this._remapKeyedSet(this.animatedEdges, remap);
    this._remapKeyedMap(this._edgeWaypoints, remap);
    this._remapKeyedMap(this._activeEdges, remap);
  }
  _remapKeyedMap(map, remap) {
    const next = new Map();
    for (const [oldKey, v] of map) {
      const newKey = remap.get(oldKey);
      if (newKey != null) next.set(newKey, v);
    }
    map.clear();
    for (const [k, v] of next) map.set(k, v);
  }
  _remapKeyedSet(set, remap) {
    const next = new Set();
    for (const oldKey of set) {
      const newKey = remap.get(oldKey);
      if (newKey != null) next.add(newKey);
    }
    set.clear();
    for (const k of next) set.add(k);
  }
  _captureDying() {
    const now = performance.now();
    const nodeWillDie = new Uint8Array(this.w.nodeCount_());
    for (let i = 0; i < this.w.nodeCount_(); i++) if (this.V.selected[i]) nodeWillDie[i] = 1;
    for (let i = 0; i < this.w.nodeCount_(); i++) {
      if (!nodeWillDie[i]) continue;
      const cat = this.kinds[this.V.kind[i]];
      this._dyingNodes.push({
        x: this.V.posX[i], y: this.V.posY[i],
        w: this.V.sizeW[i], h: this.V.sizeH[i],
        shape: cat.shape, color: this.colors.get(i) || cat.color, t0: now,
      });
    }
    for (let e = 0; e < this.w.edgeCount_(); e++) {
      const a = this.V.edgeFromN[e], b = this.V.edgeToN[e];
      if (!this.V.edgeSel[e] && !nodeWillDie[a] && !nodeWillDie[b]) continue;
      const ap = this._portWorld(a, 1, this.V.edgeFromP[e]);
      const bp = this._portWorld(b, 0, this.V.edgeToP[e]);
      this._dyingEdges.push({
        ap, bp,
        colA: this.colors.get(a) || this.kinds[this.V.kind[a]].color,
        colB: this.colors.get(b) || this.kinds[this.V.kind[b]].color,
        t0: now,
      });
    }
  }
  duplicateSelection(dx = 40, dy = 40) {
    const n = this.w.duplicateSelected(dx, dy);
    if (n > 0) { this.w.snapshot(); this._emit('change'); }
    return n;
  }
  setSelected(id, on) { this.w.setSelected(id, on ? 1 : 0); this._emit('select', this.getSelection()); }
  toggleSelected(id) { this.w.toggleSelected(id); this._emit('select', this.getSelection()); }
  clearSelection()   { this.w.clearSelection(); this._emit('select', []); }
  selectAll()        { this.w.selectAll(); this._emit('select', this.getSelection()); }
  /** Replace the entire selection with the given ids (no shift-add semantics). */
  setSelection(ids) {
    this.w.clearSelection();
    if (Array.isArray(ids)) for (const id of ids) if (id >= 0 && id < this.w.nodeCount_()) this.w.setSelected(id, 1);
    this._emit('select', this.getSelection());
  }
  /** Delete a single node by id (does not depend on prior selection). */
  deleteNode(id) {
    if (this.readOnly) return 0;
    if (id < 0 || id >= this.w.nodeCount_()) return 0;
    const prevSel = this.getSelection();
    this.w.clearSelection();
    this.w.setSelected(id, 1);
    const removed = this.deleteSelection();
    // Restore the prior selection minus the deleted node, remapped to new ids.
    if (prevSel.length) {
      this.w.clearSelection();
      for (const old of prevSel) {
        if (old === id) continue;
        const remapped = old > id ? old - 1 : old;
        if (remapped < this.w.nodeCount_()) this.w.setSelected(remapped, 1);
      }
      this._emit('select', this.getSelection());
    }
    return removed;
  }
  /**
   * Run `fn` as an atomic mutation: suppresses intermediate 'change' events
   * and emits a single 'change' at the end. Snapshots once on success. Safe
   * to nest — only the outermost call commits.
   */
  transaction(fn) {
    if (typeof fn !== 'function') return;
    if (this._inTransaction) return fn();
    this._inTransaction = true;
    const prev = this._suspendEvents;
    this._suspendEvents = true;
    let result;
    try { result = fn(); }
    finally {
      this._suspendEvents = prev;
      this._inTransaction = false;
    }
    this.w.snapshot();
    this._emit('change');
    return result;
  }
  getSelection() {
    const out = [];
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) if (this.V.selected[i]) out.push(i);
    return out;
  }
  nodeCount() { return this.w.nodeCount_(); }
  edgeCount() { return this.w.edgeCount_(); }

  // ── Per-node setters (public API) ─────────────────────────────────────
  setNodeTitle(id, t)       { t ? this.titles.set(id, t)       : this.titles.delete(id);       this._emit('change'); }
  setNodeColor(id, c)       { c ? this.colors.set(id, c)       : this.colors.delete(id);       this._emit('change'); }
  setNodeDescription(id, d) { d ? this.descriptions.set(id, d) : this.descriptions.delete(id); this._emit('change'); }
  setNodeTags(id, tags)     { (tags && tags.length) ? this.tags.set(id, tags.slice()) : this.tags.delete(id); this._emit('change'); }
  setNodeStatus(id, s)      { s ? this.status.set(id, s)       : this.status.delete(id);       this._emit('change'); }
  setNodeProgress(id, p)    { (p !== undefined && p !== null) ? this.progress.set(id, p) : this.progress.delete(id); this._emit('change'); }
  setEdgeLabel(eid, label)  { label ? this.edgeLabels.set(eid, label) : this.edgeLabels.delete(eid); this._emit('change'); }
  setEdgeStyle(style)       { this.options.edgeStyle = style === 'orthogonal' ? 'orthogonal' : 'bezier'; }
  setSnapToGrid(on)         { this.options.snapToGrid = !!on; }
  setNodeImage(id, url)     { url ? this.image.set(id, url) : this.image.delete(id); this._emit('change'); }
  setNodeChecked(id, on)    { on === null || on === undefined ? this.checked.delete(id) : this.checked.set(id, !!on); this._emit('change'); }
  setNodeTasks(id, list)    { (list && list.length) ? this.tasks.set(id, list.map((t) => ({ ...t }))) : this.tasks.delete(id); this._emit('change'); }
  setNodeIcon(id, glyph)    { glyph ? this.icon.set(id, glyph) : this.icon.delete(id); this._emit('change'); }
  setNodeLinks(id, links)   { (links && links.length) ? this.links.set(id, links.map((l) => ({ ...l }))) : this.links.delete(id); this._emit('change'); }
  setPortInLabels(id, arr)  { (arr && arr.some(Boolean)) ? this.portIn.set(id, arr.slice()) : this.portIn.delete(id); this._emit('change'); }
  setPortOutLabels(id, arr) { (arr && arr.some(Boolean)) ? this.portOut.set(id, arr.slice()) : this.portOut.delete(id); this._emit('change'); }
  /** Attach arbitrary data to a node. Round-trips through toJSON/loadJSON. */
  setNodeData(id, data)     { data === undefined || data === null ? this.data.delete(id) : this.data.set(id, data); this._emit('change'); }
  getNodeData(id)           { return this.data.get(id); }

  // ── Z-order ───────────────────────────────────────────────────────────
  _nextZ = 0;
  bringToFront(ids) {
    const sel = ids || this.getSelection();
    for (const i of sel) this.zOrder.set(i, ++this._nextZ);
  }
  sendToBack(ids) {
    const sel = ids || this.getSelection();
    for (const i of sel) this.zOrder.set(i, --this._nextZ);
  }

  // ── Bookmarks (slots 1..9) ───────────────────────────────────────────
  setBookmark(slot, nodeId) { this.bookmarks.set(slot, nodeId ?? (this.getSelection()[0])); }
  jumpBookmark(slot) {
    const id = this.bookmarks.get(slot);
    if (id === undefined || id >= this.w.nodeCount_()) return;
    this.clearSelection(); this.w.setSelected(id, 1);
    this.panTo(this.V.posX[id], this.V.posY[id]);
    this._emit('select', this.getSelection());
  }

  // ── Hover preview popover (consumer toggles via options.hoverPreview) ──
  setHoverPreview(on) { this.options.hoverPreview = !!on; if (!on) this._hidePreview(); }

  // ── Plugin API ──────────────────────────────────────────────────────
  /** Install a plugin object with optional lifecycle hooks. Returns dispose fn. */
  use(plugin) {
    if (!plugin) throw new Error('use(plugin): plugin required');
    if (typeof plugin === 'function') plugin = plugin(this) || {};
    this._plugins.push(plugin);
    for (const name of Object.keys(this._hooks)) {
      if (typeof plugin[name] === 'function') this._hooks[name].push(plugin[name]);
    }
    if (typeof plugin.extendAPI === 'function') plugin.extendAPI(this);
    if (typeof plugin.init === 'function') plugin.init(this);
    if (Array.isArray(plugin.kinds)) for (const k of plugin.kinds) this.registerKind(k);
    if (Array.isArray(plugin.commands)) {
      this._extraCommands = (this._extraCommands || []).concat(plugin.commands);
    }
    this._emit('plugin:installed', plugin.name || plugin);
    return () => this._removePlugin(plugin);
  }
  _removePlugin(plugin) {
    const i = this._plugins.indexOf(plugin); if (i === -1) return;
    this._plugins.splice(i, 1);
    for (const name of Object.keys(this._hooks)) {
      if (typeof plugin[name] === 'function') {
        const arr = this._hooks[name];
        const j = arr.indexOf(plugin[name]);
        if (j !== -1) arr.splice(j, 1);
      }
    }
    if (typeof plugin.dispose === 'function') plugin.dispose(this);
  }
  _runHook(name, ...args) {
    const arr = this._hooks[name]; if (!arr || !arr.length) return null;
    let result;
    for (const fn of arr) {
      try { const r = fn(this, ...args); if (r === false) return false; if (r !== undefined) result = r; }
      catch (e) { console.error(`plugin ${name} hook error`, e); }
    }
    return result;
  }

  // ── WebGL renderer (opt-in, hybrid: GL bodies + Canvas2D text overlay) ─
  async enableWebGL(force = false) {
    if (this._gl) return true;
    if (!force && this.w.nodeCount_() < (this.options.webglThreshold || 2000)) return false;
    try {
      const mod = await import('./webgl-renderer.js');
      this._gl = new mod.WebGLRenderer(this);
      if (this._gl.disabled) { this._gl = null; return false; }
      this.options.renderer = 'webgl';
      this._emit('renderer', 'webgl');
      return true;
    } catch (e) {
      console.warn('zflow: WebGL renderer failed', e);
      return false;
    }
  }
  disableWebGL() {
    if (!this._gl) return;
    this._gl.dispose();
    this._gl = null;
    this.canvas.style.background = this.options.background;
    this.canvas.style.zIndex = '';
    this.canvas.style.position = '';
    this.options.renderer = 'canvas2d';
    this._emit('renderer', 'canvas2d');
  }

  // ── Graph execution runtime ──────────────────────────────────────────
  // Each kind may register an `execute(ctx, inputs) -> outputs | Promise`.
  // The scheduler walks the graph in topological order, gathering inputs
  // from upstream outputs via the edge connectivity. Status / progress /
  // sparkline are updated automatically so the UI shows the run live.

  /** Set how long the runtime pauses between nodes so propagation is visible. */
  setRunStepDelay(ms) { this._runStepDelay = Math.max(0, ms|0); }

  /** Enable input memoization globally — re-runs skip nodes whose inputs match the previous tick. */
  setMemoization(on) { this._memoize = !!on; if (!on) this._memoKeys?.clear(); }

  /** Evaluate an expression like "{{node_3.value}} * 2" against current runtime values. */
  // ── Schema / type validation ────────────────────────────────────────
  /** Returns null if the connection is OK, or a string reason if not. */
  validateConnection(fromN, fromP, toN, toP) {
    if (fromN === toN) return 'self-loop';
    const fromCat = this.kinds[this.V.kind[fromN]];
    const toCat   = this.kinds[this.V.kind[toN]];
    const outSchema = fromCat.outputs?.[fromP];
    const inSchema  = toCat.inputs?.[toP];
    if (outSchema && inSchema) {
      if (!isCompatibleType(outSchema.type, inSchema.type)) {
        return `type mismatch: ${outSchema.type} → ${inSchema.type}`;
      }
    }
    if (this._connValidator) {
      const v = this._connValidator(fromN, fromP, toN, toP);
      if (v === false) return 'rejected by validator';
    }
    return null;
  }

  // ── Inline expression editor with autocomplete ────────────────────
  /** Open an inline editor that accepts {{node_X.field}} expressions with live preview. */
  editNodeExpression(nodeId, field = 'title') {
    if (this._exprEditorEl) this._closeExprEditor();
    const cur = field === 'title' ? (this.titles.get(nodeId) || '')
              : field === 'desc'  ? (this.descriptions.get(nodeId) || '')
              : '';
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;z-index:600;background:#161b27;border:1px solid #f0b93a;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:Inter, ui-sans-serif;font-size:12px;color:#e6edf3;width:280px;`;
    wrap.innerHTML = `
      <input id="zf-expr" type="text" style="width:260px;padding:8px 10px;background:transparent;border:0;color:#e6edf3;outline:none;font-family:ui-monospace,Consolas,monospace;font-size:12px;">
      <div id="zf-expr-preview" style="padding:4px 10px;border-top:1px solid rgba(255,255,255,0.08);color:#5be0d0;font-family:ui-monospace,Consolas,monospace;font-size:11px;min-height:14px;"></div>
      <div id="zf-expr-list" style="max-height:160px;overflow:auto;border-top:1px solid rgba(255,255,255,0.08);display:none;"></div>`;
    this.container.appendChild(wrap);
    this._exprEditorEl = wrap;
    const cx = this.V.posX[nodeId], cy = this.V.posY[nodeId];
    const hh = this.V.sizeH[nodeId] * 0.5;
    const tl = this._w2s(cx - this.V.sizeW[nodeId] * 0.5, cy - hh);
    const dpr = window.devicePixelRatio || 1;
    wrap.style.left = (tl.x / dpr) + 'px';
    wrap.style.top  = Math.max(8, tl.y / dpr - 110) + 'px';
    const input = wrap.querySelector('#zf-expr');
    const list  = wrap.querySelector('#zf-expr-list');
    const prev  = wrap.querySelector('#zf-expr-preview');
    input.value = cur;
    const refreshPreview = () => {
      try { const r = this.evalExpression(input.value); prev.style.color = '#5be0d0'; prev.textContent = '= ' + formatRuntimeValue(r); }
      catch (e) { prev.style.color = '#e8462b'; prev.textContent = String(e.message || e); }
    };
    const refreshSuggestions = () => {
      const pos = input.selectionStart;
      const m = input.value.slice(0, pos).match(/\{\{\s*([\w_.]*)$/);
      if (!m) { list.style.display = 'none'; return; }
      const prefix = m[1].toLowerCase();
      const candidates = [];
      for (let i = 0; i < this.w.nodeCount_(); i++) {
        if (i === nodeId) continue;
        const title = this.titles.get(i) || this.kinds[this.V.kind[i]].name;
        const val = this._values.get(i);
        const expansions = (val && typeof val === 'object') ? Object.keys(val).map((k) => `node_${i}.${k}`) : [`node_${i}`];
        for (const c of expansions) if (c.toLowerCase().startsWith(prefix)) candidates.push({ text: c, label: `${c}  ·  ${title}` });
      }
      if (!candidates.length) { list.style.display = 'none'; return; }
      list.style.display = 'block';
      list._items = candidates.slice(0, 8);
      list._cursor = 0;
      list.innerHTML = list._items.map((c, i) =>
        `<div data-i="${i}" data-text="${escapeHtml(c.text)}" style="padding:6px 10px;cursor:pointer;${i === 0 ? 'background:rgba(240,185,58,0.18);' : ''}">${escapeHtml(c.label)}</div>`).join('');
    };
    const insert = (txt) => {
      const pos = input.selectionStart;
      const before = input.value.slice(0, pos).replace(/\{\{\s*[\w_.]*$/, '{{') + txt + '}}';
      input.value = before + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = before.length;
      refreshPreview(); list.style.display = 'none';
    };
    const updateHi = () => list.querySelectorAll('[data-i]').forEach((r, i) =>
      r.style.background = i === list._cursor ? 'rgba(240,185,58,0.18)' : 'transparent');
    input.addEventListener('input', () => { refreshPreview(); refreshSuggestions(); });
    input.addEventListener('keydown', (e) => {
      const open = list.style.display !== 'none' && list._items;
      if (open && e.code === 'ArrowDown') { list._cursor = (list._cursor + 1) % list._items.length; updateHi(); e.preventDefault(); return; }
      if (open && e.code === 'ArrowUp')   { list._cursor = (list._cursor - 1 + list._items.length) % list._items.length; updateHi(); e.preventDefault(); return; }
      if (open && (e.code === 'Tab' || e.code === 'Enter')) { insert(list._items[list._cursor].text); e.preventDefault(); return; }
      if (e.code === 'Enter')  {
        if (field === 'title') this.setNodeTitle(nodeId, input.value);
        else if (field === 'desc') this.setNodeDescription(nodeId, input.value);
        this._closeExprEditor();
      }
      if (e.code === 'Escape') this._closeExprEditor();
    });
    list.addEventListener('mousedown', (e) => {
      const r = e.target.closest('[data-i]'); if (!r) return;
      insert(r.dataset.text); input.focus(); e.preventDefault();
    });
    setTimeout(() => { input.focus(); input.select(); refreshPreview(); }, 10);
    // Click outside closes the editor.
    const closeOnOutside = (e) => {
      if (this._exprEditorEl && !this._exprEditorEl.contains(e.target)) { this._closeExprEditor(); }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOnOutside, { once: false }), 60);
    this._exprEditorEl._cleanup = () => document.removeEventListener('mousedown', closeOnOutside);
  }
  _closeExprEditor() {
    if (this._exprEditorEl) {
      this._exprEditorEl._cleanup?.();
      this._exprEditorEl.remove();
      this._exprEditorEl = null;
    }
  }

  evalExpression(expr, extraScope = {}) {
    if (typeof expr !== 'string') return expr;
    const interp = expr.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
      const [head, ...rest] = path.split('.');
      let v;
      if (/^node_(\d+)$/.test(head)) v = this._values.get(parseInt(head.slice(5), 10));
      else if (head in extraScope) v = extraScope[head];
      else return 'null';
      for (const seg of rest) v = (v == null) ? undefined : v[seg];
      return JSON.stringify(v ?? null);
    });
    if (interp === expr) return expr;
    try { return Function(`"use strict"; return (${interp})`)(); }
    catch { return interp; }
  }

  /** Inject or replace the execute fn for a kind. Returns the previous fn. */
  setKindExecutor(kindName, fn) {
    const k = this.kindByName.get(kindName);
    if (k === undefined) throw new Error(`unknown kind: ${kindName}`);
    const prev = this.kinds[k].execute;
    this.kinds[k].execute = fn;
    this._runOrder = null;
    return prev;
  }
  /** Force a specific input value for a node (useful for source nodes). */
  setNodeInput(nodeId, outputs) {
    this._values.set(nodeId, outputs);
    this.setNodeStatus(nodeId, 'ok');
  }
  getNodeValue(nodeId) { return this._values.get(nodeId); }
  clearRuntimeState() {
    this._values.clear();
    for (const sc of this._streamSrc.values()) try { sc(); } catch {}
    this._streamSrc.clear();
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) { this.status.delete(i); this.progress.delete(i); }
    this._emit('change');
  }

  /** Returns [nodeIds] in topological order, ignoring cycles. */
  _topoOrder() {
    if (this._runOrder) return this._runOrder;
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    const indeg = new Int32Array(n);
    const out = Array.from({ length: n }, () => []);
    for (let i = 0; i < m; i++) {
      const a = this.V.edgeFromN[i], b = this.V.edgeToN[i];
      if (a !== b) { indeg[b]++; out[a].push({ to: b, fp: this.V.edgeFromP[i], tp: this.V.edgeToP[i], idx: i }); }
    }
    const q = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) q.push(i);
    const order = [];
    while (q.length) {
      const u = q.shift();
      order.push(u);
      for (const e of out[u]) if (--indeg[e.to] === 0) q.push(e.to);
    }
    // Cycle nodes: append in id order so they still get a chance to run once.
    if (order.length < n) {
      const seen = new Set(order);
      for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
    }
    this._runOrder = order;
    this._runOut = out;
    return order;
  }

  /** Gather inputs for a node by reading upstream node outputs through edges. */
  _gatherInputs(nodeId) {
    const inputs = {};
    const cat = this.kinds[this.V.kind[nodeId]];
    const portLabels = this.portIn.get(nodeId) || cat.portIn || [];
    const m = this.w.edgeCount_();
    for (let i = 0; i < m; i++) {
      if (this.V.edgeToN[i] !== nodeId) continue;
      const tp = this.V.edgeToP[i];
      const src = this.V.edgeFromN[i], sp = this.V.edgeFromP[i];
      const srcOut = this._values.get(src);
      if (srcOut === undefined) continue;
      let val;
      if (srcOut && typeof srcOut === 'object' && !Array.isArray(srcOut)) {
        const srcCat = this.kinds[this.V.kind[src]];
        const srcPortLabels = this.portOut.get(src) || srcCat.portOut || [];
        const key = srcPortLabels[sp];
        // Conditional routing: if the source declared labeled outputs and THIS
        // branch's labeled key isn't present, the branch didn't fire — skip.
        if (key) {
          if (!(key in srcOut)) continue;
          val = srcOut[key];
        } else if (sp in srcOut) val = srcOut[sp];
        else if ('value' in srcOut) val = srcOut.value;
        else if ('out' in srcOut) val = srcOut.out;
        else val = srcOut;
        if (val === undefined) continue;
      } else val = srcOut;
      const tkey = portLabels[tp] || `in${tp}`;
      inputs[tkey] = val;
      inputs[tp] = val;
    }
    void cat;
    return inputs;
  }

  /** All transitive successors of nodeId in topological order. */
  _collectDownstream(nodeId) {
    const m = this.w.edgeCount_();
    const out = [];
    const seen = new Set();
    const order = this._topoOrder();
    const indexOf = new Map(order.map((id, i) => [id, i]));
    const stack = [nodeId];
    while (stack.length) {
      const u = stack.pop();
      for (let i = 0; i < m; i++) {
        if (this.V.edgeFromN[i] === u && !seen.has(this.V.edgeToN[i])) {
          seen.add(this.V.edgeToN[i]); out.push(this.V.edgeToN[i]); stack.push(this.V.edgeToN[i]);
        }
      }
    }
    out.sort((a, b) => indexOf.get(a) - indexOf.get(b));
    return out;
  }

  /** Topological run of the whole graph (or from a starting subgraph). */
  async run({ from = null, signal = null, filter = null } = {}) {
    if (this._running) return;
    this._running = true;
    const mySeq = ++this._runSeq;
    const ac = new AbortController();
    this._runAbort = ac;
    if (signal) signal.addEventListener('abort', () => ac.abort());

    this._topoOrder();
    let order = this._runOrder;
    if (from !== null) {
      const reach = new Set([from]); const q = [from];
      while (q.length) {
        const u = q.shift();
        for (const e of this._runOut[u]) if (!reach.has(e.to)) { reach.add(e.to); q.push(e.to); }
      }
      order = order.filter((id) => reach.has(id));
    }
    if (typeof filter === 'function') order = order.filter(filter);

    const result = { executed: 0, errors: [], values: new Map() };
    this._emit('run:start', { order });

    for (const id of order) {
      if (ac.signal.aborted || mySeq !== this._runSeq) break;
      const cat = this.kinds[this.V.kind[id]];
      const exec = cat.execute;
      if (typeof exec !== 'function') {
        if (!this._values.has(id)) continue;
        result.values.set(id, this._values.get(id));
        continue;
      }
      const inputs = this._gatherInputs(id);
      // Conditional-routing skip: if this node has declared inputs but no
      // upstream supplied any (because the parent emitted on a different branch),
      // skip exec entirely — the dead branch shouldn't fire.
      if (cat.nin > 0 && Object.keys(inputs).length === 0) {
        // Only skip if there is at least one incoming edge in the graph (else
        // it's just a disconnected node and should still run if explicitly invoked).
        let hasIncoming = false;
        const m2 = this.w.edgeCount_();
        for (let e = 0; e < m2; e++) if (this.V.edgeToN[e] === id) { hasIncoming = true; break; }
        if (hasIncoming) continue;
      }
      // Memoization — skip if inputs hash unchanged (FNV-1a 32-bit, no JSON cost).
      if (this._memoize) {
        const hash = fnvHash(inputs);
        if (this._memoKeys.get(id) === hash && this._values.has(id)) {
          result.executed++;
          this._emit('node:cached', { id });
          continue;
        }
        this._memoKeys.set(id, hash);
      }
      // Light up the incoming edges so the user sees the data path.
      const m2 = this.w.edgeCount_();
      for (let e = 0; e < m2; e++) {
        if (this.V.edgeToN[e] === id && this._values.has(this.V.edgeFromN[e])) {
          this._activeEdges.set(e, performance.now() + 800);
        }
      }
      this.setNodeStatus(id, 'running');
      this.setNodeProgress(id, 0);
      this._emit('node:exec', { id, inputs });
      if (this._hooks) {
        const r = this._runHook('onBeforeExec', id, inputs);
        if (r === false) { this.setNodeStatus(id, 'idle'); continue; }
      }
      // Breakpoint / step pause.
      if (this.breakpoints.has(id) || this._stepMode) {
        await this._awaitContinue(id);
        if (ac.signal.aborted || mySeq !== this._runSeq) break;
      }
      if (this._runStepDelay > 0) {
        await new Promise((r) => setTimeout(r, this._runStepDelay));
        if (ac.signal.aborted || mySeq !== this._runSeq) break;
      }
      const ctx = {
        nodeId: id,
        signal: ac.signal,
        params: this._nodeParams?.get(id) || {},
        emit: (out) => { this._values.set(id, out); this._emit('node:emit', { id, outputs: out }); if (typeof out === 'number') this.pushNodeMetric(id, out); },
        log: (...args) => this._emit('node:log', { id, args }),
        setProgress: (p) => this.setNodeProgress(id, p),
        metric: (v) => this.pushNodeMetric(id, v),
        get: (otherId) => this._values.get(otherId),
      };
      const retryCfg = cat.retry || null;
      const maxAttempts = retryCfg ? (retryCfg.n ?? 3) : 1;
      const retryDelay = retryCfg ? (retryCfg.delay ?? 100) : 0;
      let attempt = 0, out, lastErr = null, succeeded = false;
      while (attempt < maxAttempts) {
        attempt++;
        this._retryStats.set(id, attempt);
        try {
          const outRaw = exec(ctx, inputs);
          // Async generator → stream multiple emissions.
          if (outRaw && typeof outRaw[Symbol.asyncIterator] === 'function') {
            // For each emission, propagate through downstream chain synchronously
            // before yielding the next. That way "stream → double → sink" really
            // shows 5 ticks down the pipe instead of one.
            let lastEmission;
            const downstream = this._collectDownstream(id);
            for await (const emission of outRaw) {
              if (ac.signal.aborted) break;
              lastEmission = emission;
              this._values.set(id, emission);
              this._emit('node:emit', { id, outputs: emission });
              if (typeof emission === 'number') this.pushNodeMetric(id, emission);
              this._valueBubbles.push({ nodeId: id, text: bubbleSummary(emission), t0: performance.now(), dur: 700 });
              // Propagate through downstream nodes (skip if they have their own execute that should wait for full stream).
              for (const dId of downstream) {
                if (ac.signal.aborted) break;
                const dCat = this.kinds[this.V.kind[dId]];
                if (typeof dCat.execute !== 'function') continue;
                if (dCat.execute.constructor.name === 'AsyncGeneratorFunction') continue;
                const dIns = this._gatherInputs(dId);
                // Light up the edge feeding this downstream node.
                const m2b = this.w.edgeCount_();
                for (let e = 0; e < m2b; e++) {
                  if (this.V.edgeToN[e] === dId && this.V.edgeFromN[e] === id) {
                    this._activeEdges.set(e, performance.now() + 500);
                  }
                }
                this.setNodeStatus(dId, 'running');
                try {
                  const dRaw = dCat.execute({ ...ctx, nodeId: dId, params: this._nodeParams?.get(dId) || {} }, dIns);
                  const dOut = (dRaw && typeof dRaw.then === 'function') ? await dRaw : dRaw;
                  if (dOut !== undefined && dOut !== null) {
                    this._values.set(dId, dOut);
                    this._emit('node:emit', { id: dId, outputs: dOut });
                    this._valueBubbles.push({ nodeId: dId, text: bubbleSummary(dOut), t0: performance.now(), dur: 700 });
                    if (typeof dOut === 'number') this.pushNodeMetric(dId, dOut);
                  }
                  this.setNodeStatus(dId, 'ok');
                } catch (e) { this.setNodeStatus(dId, 'error'); }
              }
              await new Promise((r) => setTimeout(r, 60));
            }
            out = lastEmission;
          } else {
            out = (outRaw && typeof outRaw.then === 'function') ? await outRaw : outRaw;
          }
          if (ac.signal.aborted || mySeq !== this._runSeq) break;
          succeeded = true; lastErr = null; break;
        } catch (err) {
          lastErr = err;
          this._emit('node:retry', { id, attempt, error: err });
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
      try {
        if (!succeeded) throw lastErr;
        if (ac.signal.aborted || mySeq !== this._runSeq) break;
        if (out !== undefined && out !== null) {
          this._values.set(id, out);
          result.values.set(id, out);
          // Show a floating value bubble above the node.
          let summary;
          if (typeof out === 'number')  summary = formatRuntimeValue(out);
          else if (out && typeof out === 'object') {
            const entries = Object.entries(out).filter(([, v]) => v !== undefined && v !== null);
            summary = entries.map(([k, v]) => `${k}: ${formatRuntimeValue(v)}`).join('  ');
          } else summary = formatRuntimeValue(out);
          this._valueBubbles.push({ nodeId: id, text: summary, t0: performance.now(), dur: 1400 });
          if (typeof out === 'number') this.pushNodeMetric(id, out);
          else if (out && typeof out === 'object') {
            for (const v of Object.values(out)) if (typeof v === 'number') { this.pushNodeMetric(id, v); break; }
          }
        }
        this.setNodeStatus(id, 'ok');
        this.setNodeProgress(id, 1);
        result.executed++;
        if (this._hooks) this._runHook('onAfterExec', id, out);
        this._emit('node:done', { id, outputs: out });
      } catch (err) {
        this.setNodeStatus(id, 'error');
        result.errors.push({ id, error: err });
        this._emit('node:error', { id, error: err });
        if (this.options.stopOnError) break;
      }
    }

    this._running = false;
    this._runAbort = null;
    this._emit('run:done', result);
    return result;
  }
  runFrom(nodeId) { return this.run({ from: nodeId }); }

  // ── Debug: breakpoints + step-through ──────────────────────────────
  setBreakpoint(nodeId, on = true) {
    if (on) this.breakpoints.add(nodeId); else this.breakpoints.delete(nodeId);
  }
  toggleBreakpoint(nodeId) {
    if (this.breakpoints.has(nodeId)) this.breakpoints.delete(nodeId);
    else this.breakpoints.add(nodeId);
  }
  clearBreakpoints() { this.breakpoints.clear(); }
  setStepMode(on) { this._stepMode = !!on; }
  /** When paused at a breakpoint, advance one node. */
  stepOver() {
    if (this._resumeNext) { const r = this._resumeNext; this._resumeNext = null; r(); }
  }
  /** Resume normal execution. */
  resume() {
    this._paused = false; this._stepMode = false;
    if (this._resumeNext) { const r = this._resumeNext; this._resumeNext = null; r(); }
  }
  isPaused() { return this._paused; }
  _awaitContinue(nodeId) {
    return new Promise((resolve) => {
      this._paused = true;
      this._emit('run:paused', { nodeId });
      this._resumeNext = resolve;
    });
  }

  // ── Sub-flows: turn a frame into a reusable kind ───────────────────
  /** Snapshot a frame's contents as a callable kind. Returns the new kind name. */
  registerSubflowFromFrame(frameId, opts = {}) {
    const f = this.frames.find((ff) => ff.id === frameId);
    if (!f) throw new Error('frame not found');
    const inside = [];
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      if (this.V.posX[i] >= f.x && this.V.posX[i] <= f.x + f.w &&
          this.V.posY[i] >= f.y && this.V.posY[i] <= f.y + f.h) inside.push(i);
    }
    if (!inside.length) throw new Error('frame is empty');
    const setIn = new Set(inside);
    // Capture node specs by current state.
    const localToSnap = new Map();
    const nodes = inside.map((id, i) => {
      localToSnap.set(id, i);
      return {
        kind: this.kinds[this.V.kind[id]].name,
        x: this.V.posX[id] - f.x, y: this.V.posY[id] - f.y,
        w: this.V.sizeW[id], h: this.V.sizeH[id],
        title: this.titles.get(id), color: this.colors.get(id),
        params: this._nodeParams?.get(id),
      };
    });
    const edges = [];
    const m = this.w.edgeCount_();
    for (let e = 0; e < m; e++) {
      if (setIn.has(this.V.edgeFromN[e]) && setIn.has(this.V.edgeToN[e])) {
        edges.push({
          from: localToSnap.get(this.V.edgeFromN[e]),
          to:   localToSnap.get(this.V.edgeToN[e]),
          fp: this.V.edgeFromP[e], tp: this.V.edgeToP[e],
        });
      }
    }
    // Boundary detection: nodes with no inside-predecessor are inputs;
    // nodes with no inside-successor are outputs.
    const hasIncoming = new Set(), hasOutgoing = new Set();
    for (const ed of edges) { hasIncoming.add(ed.to); hasOutgoing.add(ed.from); }
    const inputs = inside.map((_, i) => i).filter((i) => !hasIncoming.has(i));
    const outputs = inside.map((_, i) => i).filter((i) => !hasOutgoing.has(i));

    const kindName = opts.name || `subflow_${f.label || frameId}`.replace(/\s+/g, '_');
    // Surface inputs/outputs with the label from the node's title or kind.
    const inputLabels = inputs.map((idx) => {
      const local = inside[idx];
      const t = this.titles.get(local);
      return t || this.kinds[this.V.kind[local]].name;
    });
    const outputLabels = outputs.map((idx) => {
      const local = inside[idx];
      const t = this.titles.get(local);
      return t || this.kinds[this.V.kind[local]].name;
    });
    this._subflows.set(kindName, { nodes, edges, inputs, outputs, inputLabels, outputLabels });
    const self = this;
    this.registerKind({
      name: kindName, color: opts.color || '#5be0d0', badge: opts.badge || 'Σ',
      w: 180, h: 90, nin: Math.max(1, inputs.length), nout: Math.max(1, outputs.length),
      shape: 'rect',
      portIn:  inputLabels,
      portOut: outputLabels,
      inputs:  inputLabels.map((n) => ({ name: n, type: 'any' })),
      outputs: outputLabels.map((n) => ({ name: n, type: 'any' })),
      execute: async (ctx, ins) => {
        // Spawn ephemeral nodes for execution? Cheap path: rebuild a transient
        // value map inside this call using the snapshot's adjacency.
        const sf = self._subflows.get(kindName);
        const tmpVals = new Map();
        for (let i = 0; i < sf.inputs.length; i++) {
          const val = ins[i] ?? ins[`in${i}`] ?? ins[sf.inputLabels[i]];
          tmpVals.set(sf.inputs[i], val);
        }
        // Walk in topo order over snapshot edges.
        const indeg = sf.nodes.map(() => 0);
        const out = sf.nodes.map(() => []);
        for (const e of sf.edges) { indeg[e.to]++; out[e.from].push(e); }
        const q = [];
        for (let i = 0; i < sf.nodes.length; i++) if (indeg[i] === 0) q.push(i);
        while (q.length) {
          const u = q.shift();
          const node = sf.nodes[u];
          const cat = self.kinds[self.kindByName.get(node.kind)];
          let val;
          if (!tmpVals.has(u) && typeof cat?.execute === 'function') {
            const localIns = {};
            for (const e of sf.edges) {
              if (e.to === u && tmpVals.has(e.from)) {
                const srcVal = tmpVals.get(e.from);
                const v = (srcVal && typeof srcVal === 'object') ? (srcVal.value ?? srcVal[e.fp] ?? srcVal) : srcVal;
                localIns[`in${e.tp}`] = v;
                localIns[e.tp] = v;
              }
            }
            val = await cat.execute({ ...ctx, params: node.params || {} }, localIns);
            tmpVals.set(u, val);
          } else val = tmpVals.get(u);
          for (const e of out[u]) if (--indeg[e.to] === 0) q.push(e.to);
        }
        // Aggregated output keyed by BOTH index and label.
        const result = {};
        for (let i = 0; i < sf.outputs.length; i++) {
          const v = tmpVals.get(sf.outputs[i]);
          const unwrapped = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
          result[i] = unwrapped;
          result[sf.outputLabels[i]] = unwrapped;
        }
        return result;
      },
    });
    return kindName;
  }
  runFrame(frameId) {
    const f = this.frames.find((ff) => ff.id === frameId);
    if (!f) return Promise.resolve({ executed: 0, errors: [] });
    const inside = new Set();
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      if (this.V.posX[i] >= f.x && this.V.posX[i] <= f.x + f.w &&
          this.V.posY[i] >= f.y && this.V.posY[i] <= f.y + f.h) inside.add(i);
    }
    return this.run({ filter: (id) => inside.has(id) });
  }
  stop() { if (this._runAbort) this._runAbort.abort(); this._running = false; }
  isRunning() { return this._running; }

  /** Set per-node runtime parameters (used by built-in kinds: const, if). */
  setNodeParams(nodeId, params) {
    if (!this._nodeParams) this._nodeParams = new Map();
    this._nodeParams.set(nodeId, params);
  }
  getNodeParams(nodeId) { return this._nodeParams?.get(nodeId); }

  /** Long-running loop: re-run every `interval` ms until stopped. */
  startLoop(interval = 500) {
    this._loopStop = false;
    const tick = async () => {
      if (this._loopStop) return;
      await this.run();
      if (this._loopStop) return;
      setTimeout(tick, interval);
    };
    tick();
  }
  stopLoop() { this._loopStop = true; this.stop(); }

  // ── Locks + read-only ────────────────────────────────────────────────
  lockNode(id, on = true) { if (on) this.locked.add(id); else this.locked.delete(id); }
  isLocked(id) { return this.locked.has(id); }
  setReadOnly(on) { this.readOnly = !!on; }

  // ── Reachable highlight ──────────────────────────────────────────────
  setReachableFrom(nodeId) {
    if (nodeId === null || nodeId === undefined || nodeId < 0) { this._reachableSet = null; return; }
    const reach = new Set([nodeId]);
    const q = [nodeId];
    const m = this.w.edgeCount_();
    while (q.length) {
      const u = q.shift();
      for (let i = 0; i < m; i++) {
        if (this.V.edgeFromN[i] === u && !reach.has(this.V.edgeToN[i])) {
          reach.add(this.V.edgeToN[i]); q.push(this.V.edgeToN[i]);
        }
      }
    }
    this._reachableSet = reach;
  }
  clearReachable() { this._reachableSet = null; }

  // ── Remote cursor presence (collaboration UI primitive) ───────────────
  setRemoteCursor(userId, x, y, name = userId, color = '#5be0d0') {
    if (x === null) { this.remoteCursors.delete(userId); return; }
    this.remoteCursors.set(userId, { x, y, name, color, t: performance.now() });
  }
  clearRemoteCursors() { this.remoteCursors.clear(); }

  // ── Edge waypoints ───────────────────────────────────────────────────
  setEdgeWaypoints(edgeIdx, points) {
    if (!points || !points.length) this._edgeWaypoints.delete(edgeIdx);
    else this._edgeWaypoints.set(edgeIdx, points.map((p) => ({ x: p.x, y: p.y })));
  }
  clearEdgeWaypoints(edgeIdx) { this._edgeWaypoints.delete(edgeIdx); }

  // ── Frame collapse ───────────────────────────────────────────────────
  toggleFrameCollapse(frameIdx) {
    if (this.frameCollapsed.has(frameIdx)) this.frameCollapsed.delete(frameIdx);
    else this.frameCollapsed.add(frameIdx);
    this._emit('change');
  }
  isFrameCollapsed(idx) { return this.frameCollapsed.has(idx); }
  _nodeHiddenByCollapse(nodeId) {
    if (!this.frameCollapsed.size) return false;
    for (const fidx of this.frameCollapsed) {
      const f = this.frames[fidx]; if (!f) continue;
      if (this.V.posX[nodeId] >= f.x && this.V.posX[nodeId] <= f.x + f.w &&
          this.V.posY[nodeId] >= f.y + 26 && this.V.posY[nodeId] <= f.y + f.h) return true;
    }
    return false;
  }

  // ── Palette: any DOM element can drag-drop into the canvas ───────────
  makeDraggable(el, spec) {
    if (!el || !spec || !spec.kind) throw new Error('makeDraggable: spec.kind required');
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      if (this.readOnly) return;
      const ghost = el.cloneNode(true);
      Object.assign(ghost.style, { position: 'fixed', pointerEvents: 'none', opacity: '0.75', zIndex: '900', transform: 'translate(-50%,-50%) scale(1.02)' });
      document.body.appendChild(ghost);
      const move = (e) => { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; };
      move(ev);
      const up = (e) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        ghost.remove();
        const r = this.canvas.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        const wp = this._s2w(e.clientX, e.clientY);
        const nodeSpec = { ...spec, x: wp.x, y: wp.y };
        delete nodeSpec.element;
        const id = this.addNode(nodeSpec);
        this._emit('palette:drop', { id, x: wp.x, y: wp.y, spec });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // ── Theme ─────────────────────────────────────────────────────────────
  setTheme(name) {
    this._theme = name === 'light' ? LIGHT_THEME : DARK_THEME;
    this.options.theme = name;
    this.options.background = this._theme.bg;
    this.canvas.style.background = this._theme.bg;
    this._emit('theme', name);
  }
  toggleTheme() { this.setTheme(this.options.theme === 'light' ? 'dark' : 'light'); }

  // ── Live metrics (sparkline) ──────────────────────────────────────────
  pushNodeMetric(id, value) {
    let buf = this.metrics.get(id);
    if (!buf) {
      buf = { data: new Float32Array(this._metricCap), idx: 0, count: 0 };
      this.metrics.set(id, buf);
    }
    buf.data[buf.idx] = value;
    buf.idx = (buf.idx + 1) % this._metricCap;
    if (buf.count < this._metricCap) buf.count++;
    const prev = this.metricMax.get(id) || 1;
    this.metricMax.set(id, Math.max(prev * 0.99, Math.abs(value), 1));
  }
  clearNodeMetric(id) { this.metrics.delete(id); this.metricMax.delete(id); }

  // ── Edge animation ────────────────────────────────────────────────────
  setEdgeAnimated(edgeIdx, on) {
    if (on) this.animatedEdges.add(edgeIdx); else this.animatedEdges.delete(edgeIdx);
  }
  setAllEdgesAnimated(on) {
    if (!on) { this.animatedEdges.clear(); return; }
    const m = this.w.edgeCount_();
    for (let i = 0; i < m; i++) this.animatedEdges.add(i);
  }

  // ── Connection validation ─────────────────────────────────────────────
  setConnectionValidator(fn) { this._connValidator = typeof fn === 'function' ? fn : null; }

  // ── Templates ─────────────────────────────────────────────────────────
  registerTemplate(name, builder) { this._templates.set(name, builder); }
  insertTemplate(name, x = 0, y = 0) {
    const b = this._templates.get(name);
    if (!b) return -1;
    return b(this, x, y);
  }
  listTemplates() { return [...this._templates.keys()]; }

  // ── Search ────────────────────────────────────────────────────────────
  search(query) {
    this._searchQuery = (query || '').toLowerCase();
    this._searchHits = [];
    if (!this._searchQuery) return [];
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      const title = (this.titles.get(i) || '').toLowerCase();
      const desc = (this.descriptions.get(i) || '').toLowerCase();
      const kind = this.kinds[this.V.kind[i]].name.toLowerCase();
      const tagStr = (this.tags.get(i) || []).join(' ').toLowerCase();
      if (title.includes(this._searchQuery) || desc.includes(this._searchQuery) ||
          kind.includes(this._searchQuery)  || tagStr.includes(this._searchQuery)) {
        this._searchHits.push(i);
      }
    }
    return this._searchHits.slice();
  }
  jumpToSearchHit(idx) {
    if (!this._searchHits.length) return;
    const i = this._searchHits[((idx % this._searchHits.length) + this._searchHits.length) % this._searchHits.length];
    this.clearSelection();
    this.w.setSelected(i, 1);
    this.panTo(this.V.posX[i], this.V.posY[i]);
  }
  clearSearch() { this._searchQuery = ''; this._searchHits = []; }

  // ── Command palette ───────────────────────────────────────────────────
  openCommandPalette() {
    if (this._cmdPaletteEl) { this._cmdPaletteEl.remove(); this._cmdPaletteEl = null; return; }
    const cmds = this._builtinCommands();
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:80px;left:50%;transform:translateX(-50%);width:480px;max-height:60vh;overflow:hidden;background:${this._theme.panel};border:1px solid ${this._theme.border};border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,0.6);z-index:500;color:${this._theme.fg};font-family:Inter, ui-sans-serif;`;
    el.innerHTML = `
      <input id="zf-cmd-q" type="text" placeholder="Type a command…" style="width:100%;padding:14px 16px;background:transparent;color:${this._theme.fg};border:0;border-bottom:1px solid ${this._theme.border};outline:none;font-size:14px;">
      <div id="zf-cmd-list" style="max-height:46vh;overflow:auto;"></div>`;
    this.container.appendChild(el);
    this._cmdPaletteEl = el;
    const input = el.querySelector('#zf-cmd-q'), list = el.querySelector('#zf-cmd-list');
    let cursor = 0, filtered = cmds;
    const render = () => {
      list.innerHTML = filtered.map((c, i) => `
        <div data-i="${i}" style="padding:9px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:${i === cursor ? this._theme.hi : 'transparent'};">
          <span>${escapeHtml(c.label)}</span>
          <span style="color:${this._theme.muted};font-family:ui-monospace,Consolas,monospace;font-size:11px;">${c.hotkey || ''}</span>
        </div>`).join('');
    };
    render();
    const run = (i) => { const cmd = filtered[i]; if (cmd) cmd.run(); this.openCommandPalette(); };
    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      run(parseInt(row.dataset.i, 10));
    });
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      filtered = q ? cmds.filter((c) => c.label.toLowerCase().includes(q)) : cmds;
      cursor = 0; render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowDown') { cursor = Math.min(filtered.length - 1, cursor + 1); render(); e.preventDefault(); }
      if (e.code === 'ArrowUp')   { cursor = Math.max(0, cursor - 1); render(); e.preventDefault(); }
      if (e.code === 'Enter')     { run(cursor); }
      if (e.code === 'Escape')    { this.openCommandPalette(); }
    });
    input.focus();
  }
  _builtinCommands() {
    return [
      { label: 'Auto layout (Sugiyama)',     hotkey: 'L',          run: () => this.runAutoLayout() },
      { label: 'Force layout',               hotkey: 'F',          run: () => this.runForceLayout() },
      { label: 'Fit view',                   hotkey: '0',          run: () => this.fitView() },
      { label: 'Toggle theme (light/dark)',  hotkey: 'Ctrl+T',     run: () => this.toggleTheme() },
      { label: 'Toggle minimap',             hotkey: 'Ctrl+M',     run: () => this.setMinimap(!this.options.minimap) },
      { label: 'Toggle edge animation',      hotkey: 'Ctrl+E',     run: () => this.setAllEdgesAnimated(this.animatedEdges.size === 0) },
      { label: 'Toggle edge style',          hotkey: '',           run: () => this.setEdgeStyle(this.options.edgeStyle === 'bezier' ? 'orthogonal' : 'bezier') },
      { label: 'Toggle snap-to-grid',        hotkey: 'G',          run: () => this.setSnapToGrid(!this.options.snapToGrid) },
      { label: 'Toggle path highlight',      hotkey: '',           run: () => this.setPathHighlight(!this._pathHighlightEnabled) },
      { label: 'Toggle hover preview',       hotkey: '',           run: () => this.setHoverPreview(!this.options.hoverPreview) },
      { label: 'Find…',                      hotkey: 'Ctrl+F',     run: () => this.openSearch() },
      { label: 'Highlight critical path',    hotkey: '',           run: () => { const e = this.criticalPath(); for (const i of e) this.w.setEdgeSelected_(i, 1); } },
      { label: 'Find SCCs (cycle groups)',   hotkey: '',           run: () => { const sccs = this.findSCCs(); for (const g of sccs) for (const n of g) this.w.setSelected(n, 1); } },
      { label: 'Color nodes by degree',      hotkey: '',           run: () => this.colorByDegree() },
      { label: 'Clear node colors',          hotkey: '',           run: () => this.clearNodeColors() },
      { label: 'Group selection',            hotkey: 'Ctrl+G',     run: () => this.groupSelection() },
      { label: 'Add sticky note',            hotkey: '',           run: () => this.addNote(-this.cam.x, -this.cam.y) },
      { label: 'Select all',                 hotkey: 'Ctrl+A',     run: () => this.selectAll() },
      { label: 'Duplicate selection',        hotkey: 'Ctrl+D',     run: () => this.duplicateSelection() },
      { label: 'Delete selection',           hotkey: 'Del',        run: () => this.deleteSelection() },
      { label: 'Export PNG',                 hotkey: '',           run: async () => { const b = await this.exportPNG(); window.open(URL.createObjectURL(b)); } },
      { label: 'Export SVG',                 hotkey: '',           run: () => { const blob = new Blob([this.exportSVG()], { type: 'image/svg+xml' }); window.open(URL.createObjectURL(blob)); } },
      { label: 'Export JSON',                hotkey: '',           run: () => { const blob = new Blob([JSON.stringify(this.toJSON(), null, 2)], { type: 'application/json' }); window.open(URL.createObjectURL(blob)); } },
      { label: 'Undo',                       hotkey: 'Ctrl+Z',     run: () => this.undo() },
      { label: 'Redo',                       hotkey: 'Ctrl+Y',     run: () => this.redo() },
      { label: 'Run graph',                  hotkey: 'F5',         run: () => this.run() },
      { label: 'Stop run',                   hotkey: 'Shift+F5',   run: () => this.stop() },
      { label: 'Clear runtime state',        hotkey: '',           run: () => this.clearRuntimeState() },
      ...[...this._templates.keys()].map((name) => ({
        label: `Insert template: ${name}`, hotkey: '',
        run: () => this.insertTemplate(name, -this.cam.x, -this.cam.y),
      })),
      ...((this._extraCommands || []).map((c) => ({ label: c.label, hotkey: c.hotkey || '', run: c.run }))),
    ];
  }

  // ── Search UI ─────────────────────────────────────────────────────────
  openSearch() {
    if (this._searchEl) { this._searchEl.remove(); this._searchEl = null; this.clearSearch(); return; }
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:14px;left:50%;transform:translateX(-50%);background:${this._theme.panel};color:${this._theme.fg};border:1px solid ${this._theme.border};border-radius:8px;padding:6px 10px;display:flex;align-items:center;gap:8px;z-index:500;font-family:Inter, ui-sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.4);`;
    el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${this._theme.muted}" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="zf-s" type="text" placeholder="Find nodes…" style="background:transparent;border:0;outline:none;color:${this._theme.fg};font-size:13px;width:240px;">
      <span id="zf-sn" style="color:${this._theme.muted};font-size:11px;font-family:ui-monospace,Consolas,monospace;"></span>`;
    this.container.appendChild(el);
    this._searchEl = el;
    const input = el.querySelector('#zf-s'), counter = el.querySelector('#zf-sn');
    let idx = 0;
    const onChange = () => {
      const hits = this.search(input.value);
      counter.textContent = hits.length ? `${idx + 1}/${hits.length}` : (input.value ? '0' : '');
      if (hits.length) this.jumpToSearchHit(idx);
    };
    input.addEventListener('input', () => { idx = 0; onChange(); });
    input.addEventListener('keydown', (e) => {
      if (e.code === 'Enter')  { idx = (idx + (e.shiftKey ? -1 : 1) + this._searchHits.length) % Math.max(this._searchHits.length, 1); onChange(); e.preventDefault(); }
      if (e.code === 'Escape') { this.openSearch(); }
    });
    input.focus();
  }

  // ── Minimap ───────────────────────────────────────────────────────────
  setMinimap(on) {
    this.options.minimap = !!on;
    if (on) this._setupMinimap();
    else if (this._minimapEl) { this._minimapEl.remove(); this._minimapEl = null; this._minimapCtx = null; }
  }
  _setupMinimap() {
    if (this._minimapEl) return;
    const el = document.createElement('canvas');
    el.width = 200 * (window.devicePixelRatio || 1);
    el.height = 140 * (window.devicePixelRatio || 1);
    el.style.cssText = `position:absolute;right:14px;bottom:14px;width:200px;height:140px;background:${this._theme.panel};border:1px solid ${this._theme.border};border-radius:8px;cursor:pointer;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,0.4);`;
    this.container.appendChild(el);
    el.addEventListener('mousedown', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      const bb = this._graphBounds(); if (!bb) return;
      this.cam.x = -(bb.minX + px * (bb.maxX - bb.minX));
      this.cam.y = -(bb.minY + py * (bb.maxY - bb.minY));
    });
    this._minimapEl = el;
    this._minimapCtx = el.getContext('2d', { alpha: false });
  }
  _graphBounds() {
    const n = this.w.nodeCount_(); if (n === 0) return null;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let i = 0; i < n; i++) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (this.V.posX[i] - hw < mnx) mnx = this.V.posX[i] - hw;
      if (this.V.posX[i] + hw > mxx) mxx = this.V.posX[i] + hw;
      if (this.V.posY[i] - hh < mny) mny = this.V.posY[i] - hh;
      if (this.V.posY[i] + hh > mxy) mxy = this.V.posY[i] + hh;
    }
    const padX = (mxx - mnx) * 0.1 + 40, padY = (mxy - mny) * 0.1 + 40;
    return { minX: mnx - padX, maxX: mxx + padX, minY: mny - padY, maxY: mxy + padY };
  }
  _drawValueBubbles() {
    if (!this._valueBubbles.length) return;
    const now = performance.now();
    const ctx = this.ctx;
    for (let i = this._valueBubbles.length - 1; i >= 0; i--) {
      const b = this._valueBubbles[i];
      const t = (now - b.t0) / b.dur;
      if (t >= 1) { this._valueBubbles.splice(i, 1); continue; }
      const alpha = t < 0.15 ? t / 0.15 : t > 0.7 ? (1 - t) / 0.3 : 1;
      const rise = t * 30;
      const id = b.nodeId;
      if (id >= this.w.nodeCount_()) continue;
      const cx = this.V.posX[id], cy = this.V.posY[id];
      const hh = this.V.sizeH[id] * 0.5;
      const sp = this._w2s(cx, cy - hh);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `600 12px ui-monospace, Consolas, monospace`;
      const tw = ctx.measureText(b.text).width;
      const padX = 8, padY = 5;
      const bw = tw + padX * 2, bh = 22;
      const bx = sp.x - bw / 2, by = sp.y - bh - 10 - rise;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#161b27';
      this._roundRect(bx, by, bw, bh, 5); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#5b8def'; ctx.lineWidth = 1.4;
      this._roundRect(bx, by, bw, bh, 5); ctx.stroke();
      ctx.fillStyle = '#5be0d0';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(b.text, sp.x, by + bh / 2);
      // Tail.
      ctx.fillStyle = '#161b27';
      ctx.strokeStyle = '#5b8def';
      ctx.beginPath();
      ctx.moveTo(sp.x - 5, by + bh);
      ctx.lineTo(sp.x + 5, by + bh);
      ctx.lineTo(sp.x, by + bh + 6);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  _drawWaypoints() {
    for (const [edgeIdx, list] of this._edgeWaypoints) {
      void edgeIdx;
      for (const p of list) {
        const sp = this._w2s(p.x, p.y);
        this.ctx.fillStyle = '#f0b93a';
        this.ctx.beginPath(); this.ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.strokeStyle = '#0b0f17'; this.ctx.lineWidth = 1.2; this.ctx.stroke();
      }
    }
  }

  _hitWaypoint(qx, qy) {
    const tol = 8 / this.cam.zoom;
    for (const [edgeIdx, list] of this._edgeWaypoints) {
      for (let i = 0; i < list.length; i++) {
        if (Math.hypot(list[i].x - qx, list[i].y - qy) < tol) return { edgeIdx, wpIdx: i };
      }
    }
    return null;
  }

  _drawRemoteCursors() {
    if (!this.remoteCursors.size) return;
    const now = performance.now();
    for (const [id, c] of this.remoteCursors) {
      if (now - c.t > 30000) { this.remoteCursors.delete(id); continue; }
      const sp = this._w2s(c.x, c.y);
      const ctx = this.ctx;
      ctx.save();
      // Arrow.
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sp.x + 12, sp.y + 4);
      ctx.lineTo(sp.x + 5,  sp.y + 6);
      ctx.lineTo(sp.x + 4,  sp.y + 13);
      ctx.closePath(); ctx.fill();
      // Name tag.
      ctx.font = '600 11px Inter, ui-sans-serif';
      const tw = ctx.measureText(c.name).width;
      ctx.fillStyle = c.color;
      this._roundRect(sp.x + 12, sp.y + 12, tw + 12, 16, 4); ctx.fill();
      ctx.fillStyle = '#0b0f17';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.name, sp.x + 18, sp.y + 20);
      ctx.restore();
    }
  }

  _getImage(url) {
    let entry = this._imageCache.get(url);
    if (!entry) {
      entry = { img: new Image(), ready: false };
      entry.img.crossOrigin = 'anonymous';
      entry.img.onload = () => { entry.ready = true; };
      entry.img.onerror = () => { entry.ready = false; };
      entry.img.src = url;
      this._imageCache.set(url, entry);
    }
    return entry;
  }

  _drawMinimap() {
    if (!this._minimapEl || !this._minimapCtx) return;
    const m = this._minimapCtx;
    const W = this._minimapEl.width, H = this._minimapEl.height;
    m.fillStyle = this._theme.panel;
    m.fillRect(0, 0, W, H);
    const bb = this._graphBounds();
    if (!bb) return;
    const sx = W / (bb.maxX - bb.minX), sy = H / (bb.maxY - bb.minY);
    const s = Math.min(sx, sy);
    const ox = (W - s * (bb.maxX - bb.minX)) * 0.5;
    const oy = (H - s * (bb.maxY - bb.minY)) * 0.5;
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      const cat = this.kinds[this.V.kind[i]];
      const hw = this.V.sizeW[i] * 0.5 * s, hh = this.V.sizeH[i] * 0.5 * s;
      const x = ox + (this.V.posX[i] - bb.minX) * s, y = oy + (this.V.posY[i] - bb.minY) * s;
      m.fillStyle = this.colors.get(i) || cat.color;
      m.fillRect(x - hw, y - hh, Math.max(2, hw * 2), Math.max(2, hh * 2));
    }
    // Viewport rect.
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.width / dpr / this.cam.zoom;
    const ch = this.canvas.height / dpr / this.cam.zoom;
    const vx = ox + (-this.cam.x - cw * 0.5 - bb.minX) * s;
    const vy = oy + (-this.cam.y - ch * 0.5 - bb.minY) * s;
    m.strokeStyle = this._theme.accent;
    m.lineWidth = 2;
    m.strokeRect(vx, vy, cw * s, ch * s);
  }
  // Path-highlight on hover (Obsidian-style fade).
  setPathHighlight(on) { this._pathHighlightEnabled = !!on; if (!on) this._focusedSet = null; }

  // ── Plugin API ────────────────────────────────────────────────────────
  registerKind(spec) {
    const idx = this.kinds.length;
    const cat = {
      name:    spec.name  ?? `custom${idx}`,
      color:   spec.color ?? '#94a3b8',
      badge:   spec.badge ?? 'C',
      w:       spec.w     ?? 140,
      h:       spec.h     ?? 60,
      nin:     spec.nin   ?? 1,
      nout:    spec.nout  ?? 1,
      shape:   spec.shape ?? 'rect',
      html:    spec.html === true,
      template: spec.template || null,
      execute: typeof spec.execute === 'function' ? spec.execute : null,
      portIn:  Array.isArray(spec.portIn)  ? spec.portIn.slice()  : null,
      portOut: Array.isArray(spec.portOut) ? spec.portOut.slice() : null,
      // Schema declarations — each entry: { name, type, required?, default? }
      // Type is a string used by isCompatibleType(). Special: 'any' matches everything.
      inputs:  Array.isArray(spec.inputs)  ? spec.inputs.slice()  : null,
      outputs: Array.isArray(spec.outputs) ? spec.outputs.slice() : null,
      retry:   spec.retry || null,
    };
    this.kinds.push(cat);
    this.kindByName.set(cat.name, idx);
    this._runOrder = null;
    return idx;
  }

  // ── Sticky notes ──────────────────────────────────────────────────────
  addNote(x, y, text = '', opts = {}) {
    const palette = [
      { fill: 'rgba(254,249,195,0.94)', text: '#5b3d12', border: '#caa54a' },
      { fill: 'rgba(252,231,243,0.94)', text: '#831843', border: '#db5895' },
      { fill: 'rgba(220,252,231,0.94)', text: '#14532d', border: '#5cad75' },
      { fill: 'rgba(219,234,254,0.94)', text: '#1e3a8a', border: '#5b8def' },
    ];
    const color = opts.color || palette[this.notes.length % palette.length];
    const note = { id: ++this._noteSeq, x, y, w: opts.w || 220, h: opts.h || 130, text, color };
    this.notes.push(note);
    this._emit('change');
    return note.id;
  }
  deleteNote(id) { this.notes = this.notes.filter((n) => n.id !== id); this._emit('change'); }

  // ── Frames (groups) ───────────────────────────────────────────────────
  addFrame(x, y, w, h, label = 'Group', color = '#5b8def') {
    const f = { id: ++this._frameSeq, x, y, w, h, label, color };
    this.frames.push(f);
    this._emit('change');
    return f.id;
  }
  groupSelection(label) {
    const sel = this.getSelection();
    if (sel.length === 0) return -1;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const i of sel) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (this.V.posX[i] - hw < mnx) mnx = this.V.posX[i] - hw;
      if (this.V.posX[i] + hw > mxx) mxx = this.V.posX[i] + hw;
      if (this.V.posY[i] - hh < mny) mny = this.V.posY[i] - hh;
      if (this.V.posY[i] + hh > mxy) mxy = this.V.posY[i] + hh;
    }
    const pad = 30;
    return this.addFrame(mnx - pad, mny - pad - 26, mxx - mnx + pad * 2, mxy - mny + pad * 2 + 26, label || `Group ${this.frames.length + 1}`);
  }
  deleteFrame(id) { this.frames = this.frames.filter((f) => f.id !== id); this._emit('change'); }

  // Subflow drill-in: focus on a frame.
  enterSubflow(fid) {
    const idx = this.frames.findIndex((f) => f.id === fid);
    if (idx === -1) return;
    this._focusFrame = idx;
    const f = this.frames[idx];
    this.cam.x = -(f.x + f.w / 2); this.cam.y = -(f.y + f.h / 2);
    this.cam.zoom = Math.min(this.canvas.width / (f.w + 80), this.canvas.height / (f.h + 80)) * 0.9;
    this._emit('subflow', f.id);
  }
  exitSubflow() {
    if (this._focusFrame === -1) return;
    this._focusFrame = -1;
    this.fitView();
    this._emit('subflow', null);
  }
  _isInsideFocusFrame(nodeId) {
    if (this._focusFrame === -1) return true;
    const f = this.frames[this._focusFrame];
    return this.V.posX[nodeId] >= f.x && this.V.posX[nodeId] <= f.x + f.w &&
           this.V.posY[nodeId] >= f.y && this.V.posY[nodeId] <= f.y + f.h;
  }

  _resolveKind(k) {
    if (typeof k === 'number') return k;
    const idx = this.kindByName.get(k);
    if (idx === undefined) throw new Error(`zflow: unknown kind "${k}"`);
    return idx;
  }

  // ── Layout / view ─────────────────────────────────────────────────────
  runAutoLayout() {
    const layers = this.w.autoLayout();
    this.w.snapshot();
    this._emit('change');
    return layers;
  }
  runForceLayout(maxFrames = 220) {
    if (this._forceRaf) cancelAnimationFrame(this._forceRaf);
    this.w.forceLayoutReset();
    let i = 0;
    const tick = () => {
      this.w.forceLayoutTick(0.05);
      i++;
      if (i < maxFrames) this._forceRaf = requestAnimationFrame(tick);
      else { this._forceRaf = null; this.w.snapshot(); this._emit('change'); }
    };
    this._forceRaf = requestAnimationFrame(tick);
  }
  fitView(padding = 80) {
    const n = this.w.nodeCount_();
    if (n === 0) return;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let i = 0; i < n; i++) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (this.V.posX[i] - hw < mnx) mnx = this.V.posX[i] - hw;
      if (this.V.posX[i] + hw > mxx) mxx = this.V.posX[i] + hw;
      if (this.V.posY[i] - hh < mny) mny = this.V.posY[i] - hh;
      if (this.V.posY[i] + hh > mxy) mxy = this.V.posY[i] + hh;
    }
    const bw = mxx - mnx + padding * 2, bh = mxy - mny + padding * 2;
    this.cam.x = -(mnx + (mxx - mnx) / 2);
    this.cam.y = -(mny + (mxy - mny) / 2);
    this.cam.zoom = Math.min(this.canvas.width / bw, this.canvas.height / bh) * 0.85;
  }
  zoomTo(zoom) { this.cam.zoom = Math.max(0.2, Math.min(3.0, zoom)); }
  panTo(x, y)  { this.cam.x = -x; this.cam.y = -y; }

  // ── History ───────────────────────────────────────────────────────────
  undo()     { if (this.w.undo()) this._emit('change'); }
  redo()     { if (this.w.redo()) this._emit('change'); }
  snapshot() { this.w.snapshot(); }

  // ── Algorithms ────────────────────────────────────────────────────────
  /** Longest path in the DAG via topo-sort + DP. Returns [edgeIds] or []. */
  criticalPath() {
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    if (n === 0) return [];
    const inDeg = new Uint32Array(n);
    for (let i = 0; i < m; i++) inDeg[this.V.edgeToN[i]]++;
    const queue = [];
    for (let i = 0; i < n; i++) if (inDeg[i] === 0) queue.push(i);
    const dist = new Int32Array(n);
    const predEdge = new Int32Array(n); predEdge.fill(-1);
    const adj = this._buildAdj();
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      for (const e of (adj.get(u) || [])) {
        if (dist[u] + 1 > dist[e.to]) { dist[e.to] = dist[u] + 1; predEdge[e.to] = e.edge; }
        inDeg[e.to]--;
        if (inDeg[e.to] === 0) queue.push(e.to);
      }
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (dist[i] > dist[best]) best = i;
    if (dist[best] === 0) return [];
    const path = [];
    let cur = best;
    while (predEdge[cur] !== -1) { path.push(predEdge[cur]); cur = this.V.edgeFromN[predEdge[cur]]; }
    return path;
  }

  /** Tarjan's SCC. Returns array of arrays (each non-trivial SCC's node ids). */
  findSCCs() {
    const n = this.w.nodeCount_();
    const adj = this._buildAdj();
    const index = new Int32Array(n).fill(-1);
    const lowlink = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const stack = [];
    const sccs = [];
    let counter = 0;
    for (let start = 0; start < n; start++) {
      if (index[start] !== -1) continue;
      const work = [{ v: start, child: 0 }];
      index[start] = counter; lowlink[start] = counter++;
      stack.push(start); onStack[start] = 1;
      while (work.length) {
        const top = work[work.length - 1];
        const out = adj.get(top.v) || [];
        if (top.child < out.length) {
          const wto = out[top.child++].to;
          if (index[wto] === -1) {
            index[wto] = counter; lowlink[wto] = counter++;
            stack.push(wto); onStack[wto] = 1;
            work.push({ v: wto, child: 0 });
          } else if (onStack[wto]) {
            if (index[wto] < lowlink[top.v]) lowlink[top.v] = index[wto];
          }
        } else {
          if (lowlink[top.v] === index[top.v]) {
            const scc = [];
            while (stack.length) {
              const x = stack.pop(); onStack[x] = 0; scc.push(x);
              if (x === top.v) break;
            }
            if (scc.length >= 2) sccs.push(scc);
          }
          const finished = top.v;
          work.pop();
          if (work.length && lowlink[finished] < lowlink[work[work.length - 1].v]) {
            lowlink[work[work.length - 1].v] = lowlink[finished];
          }
        }
      }
    }
    return sccs;
  }

  /** Heatmap: color every node by its in+out degree. Pass null to clear. */
  colorByDegree() {
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    const deg = new Uint16Array(n);
    for (let i = 0; i < m; i++) { deg[this.V.edgeFromN[i]]++; deg[this.V.edgeToN[i]]++; }
    let max = 1;
    for (let i = 0; i < n; i++) if (deg[i] > max) max = deg[i];
    const ramp = ['#3b5fc4', '#5b8def', '#5be0d0', '#5bd17a', '#f0b93a', '#fb923c', '#e8462b'];
    const lerp = (t) => {
      if (t <= 0) return ramp[0]; if (t >= 1) return ramp[ramp.length - 1];
      const idx = t * (ramp.length - 1), i0 = Math.floor(idx), i1 = Math.min(ramp.length - 1, i0 + 1);
      const f = idx - i0; const a = parseHex(ramp[i0]), b = parseHex(ramp[i1]);
      return `rgb(${Math.round(a[0]*(1-f)+b[0]*f)},${Math.round(a[1]*(1-f)+b[1]*f)},${Math.round(a[2]*(1-f)+b[2]*f)})`;
    };
    for (let i = 0; i < n; i++) this.colors.set(i, lerp(deg[i] / max));
    this._emit('change');
  }
  clearNodeColors() {
    this.colors.clear();
    this._emit('change');
  }

  // ── Imports (Mermaid + DOT) ───────────────────────────────────────────
  importMermaid(text) {
    const parsed = parseMermaid(text);
    if (!parsed || parsed.nodes.size === 0) return 0;
    const shapeMap = { rect: 'process', rhombus: 'decision', circle: 'branch', round: 'process', subroutine: 'aggregator', default: 'process' };
    const idMap = new Map();
    let drop = 0;
    for (const [mid, def] of parsed.nodes) {
      const id = this.addNode({
        kind: shapeMap[def.shape] || 'process',
        x: (drop % 8) * 200 - 700, y: Math.floor(drop / 8) * 110,
        title: def.label,
      });
      if (id < 0) break;
      idMap.set(mid, id); drop++;
    }
    for (const e of parsed.edges) {
      const a = idMap.get(e.from), b = idMap.get(e.to);
      if (a === undefined || b === undefined) continue;
      this.addEdge({ from: a, to: b, label: e.label });
    }
    this.runAutoLayout();
    this.fitView();
    return parsed.nodes.size;
  }
  importDot(text) {
    const parsed = parseDot(text);
    if (!parsed || parsed.nodes.size === 0) return 0;
    const idMap = new Map();
    let drop = 0;
    for (const [mid, def] of parsed.nodes) {
      const id = this.addNode({ kind: 'process', x: (drop % 8) * 200 - 700, y: Math.floor(drop / 8) * 110, title: def.label });
      if (id < 0) break;
      idMap.set(mid, id); drop++;
    }
    for (const e of parsed.edges) {
      const a = idMap.get(e.from), b = idMap.get(e.to);
      if (a === undefined || b === undefined) continue;
      const eid = this.addEdge({ from: a, to: b });
      if (eid >= 0 && e.label) this.setEdgeLabel(eid, e.label);
    }
    this.runAutoLayout();
    this.fitView();
    return parsed.nodes.size;
  }

  /** Returns an array of edge indices forming the shortest path, or [] if unreachable. */
  shortestPathSafe(from, to) { return this.shortestPath(from, to) || []; }
  shortestPath(from, to) {
    const adj = this._buildAdj();
    const prev = new Map(); prev.set(from, null);
    const queue = [from];
    while (queue.length) {
      const u = queue.shift();
      if (u === to) break;
      for (const e of (adj.get(u) || [])) {
        if (!prev.has(e.to)) { prev.set(e.to, { from: u, edgeIdx: e.edge }); queue.push(e.to); }
      }
    }
    if (!prev.has(to)) return [];
    const path = [];
    let cur = to;
    while (prev.get(cur)) { path.push(prev.get(cur).edgeIdx); cur = prev.get(cur).from; }
    return path.reverse();
  }
  findCycles() {
    const n = this.w.nodeCount_();
    const color = new Uint8Array(n);
    const result = new Set();
    const adj = this._buildAdj();
    for (let start = 0; start < n; start++) {
      if (color[start] !== 0) continue;
      const stack = [{ u: start, iter: (adj.get(start) || [])[Symbol.iterator]() }];
      color[start] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const next = top.iter.next();
        if (next.done) { color[top.u] = 2; stack.pop(); continue; }
        const e = next.value;
        if (color[e.to] === 1) result.add(e.edge);
        else if (color[e.to] === 0) {
          color[e.to] = 1;
          stack.push({ u: e.to, iter: (adj.get(e.to) || [])[Symbol.iterator]() });
        }
      }
    }
    return [...result];
  }
  /** Build per-node edge-id adjacency for fast dirty-marking. */
  _ensureAdj() {
    if (!this._adjDirty && this._nodeAdj) return;
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    const adj = new Array(n);
    for (let i = 0; i < n; i++) adj[i] = [];
    for (let e = 0; e < m; e++) {
      const a = this.V.edgeFromN[e], b = this.V.edgeToN[e];
      if (a < n) adj[a].push(e);
      if (b < n && a !== b) adj[b].push(e);
    }
    this._nodeAdj = adj;
    this._adjDirty = false;
  }

  _buildAdj() {
    const m = this.w.edgeCount_();
    const adj = new Map();
    for (let i = 0; i < m; i++) {
      const a = this.V.edgeFromN[i];
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ to: this.V.edgeToN[i], edge: i });
    }
    return adj;
  }

  // ── Persistence ───────────────────────────────────────────────────────
  toJSON() {
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const node = {
        id: i, kind: this.kinds[this.V.kind[i]].name,
        x: this.V.posX[i], y: this.V.posY[i],
        w: this.V.sizeW[i], h: this.V.sizeH[i],
        nin: this.V.nIn[i], nout: this.V.nOut[i],
      };
      if (this.titles.has(i))       node.title = this.titles.get(i);
      if (this.colors.has(i))       node.color = this.colors.get(i);
      if (this.descriptions.has(i)) node.description = this.descriptions.get(i);
      if (this.tags.has(i))         node.tags = this.tags.get(i);
      if (this.status.has(i))       node.status = this.status.get(i);
      if (this.progress.has(i))     node.progress = this.progress.get(i);
      if (this.data.has(i))         node.data = this.data.get(i);
      nodes.push(node);
    }
    const edges = [];
    for (let i = 0; i < m; i++) {
      const edge = { from: this.V.edgeFromN[i], fp: this.V.edgeFromP[i],
                     to:   this.V.edgeToN[i],   tp: this.V.edgeToP[i] };
      if (this.edgeLabels.has(i)) edge.label = this.edgeLabels.get(i);
      edges.push(edge);
    }
    return {
      version: 1, nodes, edges,
      camera: { ...this.cam },
      edgeStyle: this.options.edgeStyle,
    };
  }
  /**
   * Atomic load: wipes the current graph and inserts `nodes`/`edges` whose
   * `from`/`to` reference the caller's free-form ids (strings, numbers, refs).
   *
   *   loadGraph({
   *     nodes: [{ id: 'a', kind: 'process', x: 0, y: 0, title: 'A' }],
   *     edges: [{ from: 'a', to: 'b', label: 'next' }],
   *   })
   *
   * Returns Map<userId, zflowId> for the host to keep around if needed —
   * but you can also rely on `data.id` round-tripping through toJSON, since
   * each node's `id` (if provided) is also stored under `node.data.__id`.
   * Single 'change' event and a single undo snapshot, regardless of N.
   */
  loadGraph(spec = {}) {
    const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
    const edges = Array.isArray(spec.edges) ? spec.edges : [];
    const idMap = new Map();
    this.transaction(() => {
      this.w.reset();
      this.titles.clear(); this.colors.clear(); this.descriptions.clear();
      this.tags.clear(); this.status.clear(); this.progress.clear();
      this.edgeLabels.clear(); this.data.clear();
      this.bookmarks.clear(); this.locked.clear(); this.breakpoints.clear();
      this._values.clear?.();
      for (const n of nodes) {
        const userId = n.id;
        const merged = userId !== undefined
          ? { ...n, data: { ...(n.data || {}), __id: userId } }
          : n;
        const zid = this.addNode(merged);
        if (zid < 0) continue;
        if (userId !== undefined) idMap.set(userId, zid);
      }
      for (const e of edges) {
        const a = typeof e.from === 'number' && e.from < this.w.nodeCount_() ? e.from : idMap.get(e.from);
        const b = typeof e.to   === 'number' && e.to   < this.w.nodeCount_() ? e.to   : idMap.get(e.to);
        if (a === undefined || b === undefined) continue;
        this.addEdge({ from: a, to: b, fp: e.fp, tp: e.tp, label: e.label });
      }
    });
    if (this._gl) this._gl.markAllDirty();
    return idMap;
  }
  /** Lookup the zflow id that was assigned to a user-supplied id during loadGraph. */
  findNodeByUserId(userId) {
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      const d = this.data.get(i);
      if (d && d.__id === userId) return i;
    }
    return -1;
  }

  loadJSON(data) {
    this.w.reset();
    this.titles.clear(); this.colors.clear(); this.descriptions.clear();
    this.tags.clear(); this.status.clear(); this.progress.clear();
    this.edgeLabels.clear(); this.data.clear();
    const idMap = new Map();
    for (const node of (data.nodes || [])) {
      const id = this.addNode({
        kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h,
        title: node.title, color: node.color, description: node.description,
        tags: node.tags, status: node.status, progress: node.progress,
        data: node.data,
      });
      idMap.set(node.id ?? id, id);
    }
    for (const edge of (data.edges || [])) {
      this.addEdge({
        from: idMap.get(edge.from) ?? edge.from, fp: edge.fp,
        to:   idMap.get(edge.to)   ?? edge.to,   tp: edge.tp,
        label: edge.label,
      });
    }
    if (data.camera) Object.assign(this.cam, data.camera);
    if (data.edgeStyle) this.options.edgeStyle = data.edgeStyle;
    this.w.snapshot();
    this._emit('change');
  }
  async exportPNG() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /** Build a standalone SVG document representing the current graph. */
  exportSVG() {
    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    if (n === 0 && this.notes.length === 0 && this.frames.length === 0) {
      return '<svg xmlns="http://www.w3.org/2000/svg"/>';
    }
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    const expand = (x0, y0, x1, y1) => {
      if (x0 < mnx) mnx = x0; if (x1 > mxx) mxx = x1;
      if (y0 < mny) mny = y0; if (y1 > mxy) mxy = y1;
    };
    for (let i = 0; i < n; i++) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      expand(this.V.posX[i] - hw, this.V.posY[i] - hh, this.V.posX[i] + hw, this.V.posY[i] + hh);
    }
    for (const f of this.frames) expand(f.x, f.y, f.x + f.w, f.y + f.h);
    for (const nt of this.notes) expand(nt.x, nt.y, nt.x + nt.w, nt.y + nt.h);
    const pad = 40;
    const bw = mxx - mnx + pad * 2, bh = mxy - mny + pad * 2;
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mnx - pad} ${mny - pad} ${bw} ${bh}" width="${bw}" height="${bh}" style="background:${this.options.background}">`];

    // Defs: gather all edge gradients up front so consumers can serialize cleanly.
    const defs = [];
    for (let i = 0; i < m; i++) {
      const a = this.V.edgeFromN[i], b = this.V.edgeToN[i];
      const ap = this._portWorld(a, 1, this.V.edgeFromP[i]);
      const bp = this._portWorld(b, 0, this.V.edgeToP[i]);
      const cA = this.colors.get(a) || this.kinds[this.V.kind[a]].color;
      const cB = this.colors.get(b) || this.kinds[this.V.kind[b]].color;
      defs.push(`<linearGradient id="zfg${i}" x1="${ap.x}" y1="${ap.y}" x2="${bp.x}" y2="${bp.y}" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${cA}"/><stop offset="100%" stop-color="${cB}"/></linearGradient>`);
    }
    if (defs.length) out.push(`<defs>${defs.join('')}</defs>`);

    // Frames (background layer): dashed border + translucent header strip + label.
    for (const f of this.frames) {
      const fillA = alphaize(f.color, 0.05);
      const strokeA = alphaize(f.color, 0.45);
      const headA = alphaize(f.color, 0.16);
      out.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="12" fill="${fillA}" stroke="${strokeA}" stroke-width="1.4" stroke-dasharray="8 4"/>`);
      out.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="26" rx="12" fill="${headA}"/>`);
      out.push(`<text x="${f.x + 10}" y="${f.y + 17}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600" fill="${f.color}">${escapeXml(f.label || '')}</text>`);
    }

    // Sticky notes.
    for (const nt of this.notes) {
      const fill = (nt.color && nt.color.fill) || '#fef9c3';
      const border = (nt.color && nt.color.border) || '#caa54a';
      const textCol = (nt.color && nt.color.text) || '#5b3d12';
      out.push(`<rect x="${nt.x}" y="${nt.y}" width="${nt.w}" height="${nt.h}" rx="4" fill="${fill}" stroke="${border}" stroke-width="1"/>`);
      if (nt.text) {
        const lines = wrapTextForSvg(nt.text, nt.w - 20, 7); // rough char-width estimate
        const startY = nt.y + 18;
        for (let li = 0; li < lines.length; li++) {
          out.push(`<text x="${nt.x + 10}" y="${startY + li * 16}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="${textCol}">${escapeXml(lines[li])}</text>`);
        }
      }
    }

    // Edges.
    for (let i = 0; i < m; i++) {
      const a = this.V.edgeFromN[i], b = this.V.edgeToN[i];
      const ap = this._portWorld(a, 1, this.V.edgeFromP[i]);
      const bp = this._portWorld(b, 0, this.V.edgeToP[i]);
      const selected = this.V.edgeSel[i] !== 0;
      const stroke = selected ? '#f0b93a' : `url(#zfg${i})`;
      const sw = selected ? 2.4 : 1.7;
      let d;
      if (this.options.edgeStyle === 'orthogonal') {
        const path = this._orthoPath(ap, bp);
        d = `M ${path[0].x} ${path[0].y} ` + path.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ');
      } else {
        const dx = bp.x - ap.x, dy = bp.y - ap.y;
        const off = Math.max(50, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.4);
        d = `M ${ap.x} ${ap.y} C ${ap.x + off} ${ap.y} ${bp.x - off} ${bp.y} ${bp.x} ${bp.y}`;
      }
      out.push(`<path d="${d}" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linejoin="round"/>`);
      const label = this.edgeLabels.get(i);
      if (label) {
        // Midpoint approximation: average of endpoints (close enough for export).
        const mx = (ap.x + bp.x) / 2, my = (ap.y + bp.y) / 2;
        const tw = Math.max(20, label.length * 6.5);
        out.push(`<rect x="${mx - tw / 2 - 5}" y="${my - 9}" width="${tw + 10}" height="16" rx="5" fill="#0b0f17" stroke="${selected ? '#f0b93a' : alphaize(this.colors.get(a) || this.kinds[this.V.kind[a]].color, 0.6)}" stroke-width="1"/>`);
        out.push(`<text x="${mx}" y="${my + 3}" font-family="ui-monospace, Consolas, monospace" font-size="10.5" font-weight="600" fill="#e6edf3" text-anchor="middle">${escapeXml(label)}</text>`);
      }
    }

    // Nodes.
    for (let i = 0; i < n; i++) {
      const cat = this.kinds[this.V.kind[i]];
      const color = this.colors.get(i) || cat.color;
      const x = this.V.posX[i] - this.V.sizeW[i] / 2;
      const y = this.V.posY[i] - this.V.sizeH[i] / 2;
      const w = this.V.sizeW[i], h = this.V.sizeH[i];
      const sel = this.V.selected[i] !== 0;
      const borderColor = sel ? '#f0b93a' : color;
      const borderW = sel ? 2 : 1.4;
      if (cat.shape === 'diamond') {
        const cx = this.V.posX[i], cy = this.V.posY[i];
        out.push(`<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="#161b27" stroke="${borderColor}" stroke-width="${borderW}"/>`);
      } else if (cat.shape === 'ellipse') {
        out.push(`<ellipse cx="${this.V.posX[i]}" cy="${this.V.posY[i]}" rx="${w/2}" ry="${h/2}" fill="#161b27" stroke="${borderColor}" stroke-width="${borderW}"/>`);
      } else if (cat.shape === 'hexagon') {
        const cx = this.V.posX[i], cy = this.V.posY[i];
        const hw = w / 2, a = hw * 0.45;
        out.push(`<polygon points="${cx - hw + a},${y} ${cx + hw - a},${y} ${x + w},${cy} ${cx + hw - a},${y + h} ${cx - hw + a},${y + h} ${x},${cy}" fill="#161b27" stroke="${borderColor}" stroke-width="${borderW}"/>`);
      } else {
        out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#161b27" stroke="${borderColor}" stroke-width="${borderW}"/>`);
        if (cat.shape === 'rect') {
          out.push(`<path d="M ${x + 8} ${y} L ${x + w - 8} ${y} Q ${x + w} ${y} ${x + w} ${y + 8} L ${x + w} ${y + 22} L ${x} ${y + 22} L ${x} ${y + 8} Q ${x} ${y} ${x + 8} ${y} Z" fill="${color}"/>`);
        }
      }
      const title = this.titles.get(i) || `${cat.name} #${i}`;
      const titleY = cat.shape === 'rect' ? y + 14 : y + h / 2;
      const titleFill = cat.shape === 'rect' ? '#0b0f17' : color;
      out.push(`<text x="${this.V.posX[i]}" y="${titleY}" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="600" text-anchor="middle" fill="${titleFill}" dominant-baseline="middle">${escapeXml(title)}</text>`);

      // Progress bar (bottom strip of rect bodies).
      const prog = this.progress.get(i);
      if (prog !== undefined && prog > 0 && cat.shape === 'rect') {
        const barY = y + h - 5;
        const barX = x + 8, barW = w - 16, barH = 3;
        const fillW = barW * Math.min(1, Math.max(0, prog));
        out.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="rgba(255,255,255,0.06)"/>`);
        out.push(`<rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" fill="${color}"/>`);
      }

      // Status dot (top-right of header for rect shapes).
      const st = this.status.get(i);
      if (st && cat.shape === 'rect') {
        const sCol = STATUS_COLORS[st] || '#8b95a7';
        out.push(`<circle cx="${x + w - 12}" cy="${y + 11}" r="3.5" fill="${sCol}"/>`);
      }

      // Tags.
      const tags = this.tags.get(i);
      if (tags && tags.length) {
        let tx = x + 8;
        const ty = y + h - 24;
        const tagFill = alphaize(color, 0.18);
        for (const tag of tags) {
          const tw = tag.length * 6 + 12;
          if (tx + tw > x + w - 8) break;
          out.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="14" rx="3" fill="${tagFill}"/>`);
          out.push(`<text x="${tx + tw / 2}" y="${ty + 7}" font-family="Inter, system-ui, sans-serif" font-size="9" text-anchor="middle" fill="${color}" dominant-baseline="middle">${escapeXml(tag)}</text>`);
          tx += tw + 4;
        }
      }

      // Ports (circles on left/right edges).
      const ni = this.V.nIn[i], no = this.V.nOut[i];
      for (let p = 0; p < ni; p++) {
        const py = y + h * ((p + 1) / (ni + 1));
        out.push(`<circle cx="${x}" cy="${py}" r="4.5" fill="${color}" stroke="#07090f" stroke-width="1.5"/>`);
      }
      for (let p = 0; p < no; p++) {
        const py = y + h * ((p + 1) / (no + 1));
        out.push(`<circle cx="${x + w}" cy="${py}" r="4.5" fill="${color}" stroke="#07090f" stroke-width="1.5"/>`);
      }
    }
    out.push('</svg>');
    return out.join('\n');
  }

  // ── Events ────────────────────────────────────────────────────────────
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return () => { const arr = this.listeners.get(event); const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
  }
  _emit(event, ...args) {
    if (this._suspendEvents) return;
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr.slice()) try { fn(...args); } catch (e) { console.error(e); }
  }

  // ── Coordinate helpers ────────────────────────────────────────────────
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.container.getBoundingClientRect();
    this.canvas.width = Math.floor(r.width * dpr);
    this.canvas.height = Math.floor(r.height * dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
  }
  _w2s(wx, wy) {
    return { x: this.canvas.width / 2 + (wx + this.cam.x) * this.cam.zoom,
             y: this.canvas.height / 2 + (wy + this.cam.y) * this.cam.zoom };
  }
  _s2w(cx, cy) {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const sx = (cx - r.left) * dpr, sy = (cy - r.top) * dpr;
    return { x: (sx - this.canvas.width / 2) / this.cam.zoom - this.cam.x,
             y: (sy - this.canvas.height / 2) / this.cam.zoom - this.cam.y };
  }
  /** Public coordinate helpers. Internal `_w2s`/`_s2w` kept as aliases. */
  worldToScreen(wx, wy) { return this._w2s(wx, wy); }
  screenToWorld(cx, cy) { return this._s2w(cx, cy); }
  /** Read-only camera snapshot — preferred over reading `flow.cam` directly. */
  getCamera() { return { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom }; }
  /** Public node geometry accessor. Returns null if id is out of range. */
  getNodePosition(id) {
    if (id < 0 || id >= this.w.nodeCount_()) return null;
    return { x: this.V.posX[id], y: this.V.posY[id], w: this.V.sizeW[id], h: this.V.sizeH[id] };
  }
  /** Open the inline title editor for a node. */
  startEditTitle(id) { if (id >= 0 && id < this.w.nodeCount_()) this._startEditingTitle(id); }

  // ── Interactions ──────────────────────────────────────────────────────
  _attachEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('mousedown', (e) => {
      this._hideMenu();
      if (this._editingNoteEl && this._editingNote !== -1) this._editingNoteEl.blur();
      if (this._editingTitleEl && this._editingTitle !== -1) this._editingTitleEl.blur();
      const wp = this._s2w(e.clientX, e.clientY);
      if (e.button === 2) { this._onRightClick(e, wp); return; }
      if (e.button === 1) { this._startPan(e); return; }
      // Port? (bidirectional)
      const ph = this.w.hitTestPort(wp.x, wp.y, 11);
      if (ph !== -1) {
        const side = (ph >>> 24) & 0xFF, idx = (ph >>> 16) & 0xFF, nid = ph & 0xFFFF;
        this._mode = 'connecting';
        this._edgeStart = { nodeId: nid, side, idx };
        this._edgeCursor = wp;
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      // Resize handle?
      const handle = this._hitHandle(wp.x, wp.y);
      if (handle && !this.readOnly && !this.locked.has(handle.nodeId)) {
        this._mode = 'resize';
        this._resizingHandle = { ...handle, lastX: wp.x, lastY: wp.y };
        return;
      }
      // Edge waypoint drag?
      const wpHit = this._hitWaypoint(wp.x, wp.y);
      if (wpHit && !this.readOnly) {
        this._draggingWaypoint = wpHit;
        this._mode = 'drag-waypoint';
        return;
      }
      // Frame corner resize?
      const fc = this._hitFrameCorner(wp.x, wp.y);
      if (fc) {
        this._mode = 'resize-frame';
        this._resizingFrame = { ...fc, lastX: wp.x, lastY: wp.y };
        return;
      }
      // Frame header drag?
      const fh = this._hitFrameHeader(wp.x, wp.y);
      if (fh !== -1) {
        this._mode = 'drag-frame';
        this._draggingFrame = fh;
        this._frameDragLast = wp;
        return;
      }
      // Sticky note drag?
      const nh = this._hitNote(wp.x, wp.y);
      if (nh !== -1) {
        this._mode = 'drag-note';
        this._draggingNote = nh;
        this._noteDragLast = wp;
        return;
      }
      // Sub-task checkbox click?
      const taskHit = this._hitTaskCheckbox(wp.x, wp.y);
      if (taskHit) {
        const list = this.tasks.get(taskHit.nodeId);
        if (list && list[taskHit.taskIdx]) {
          list[taskHit.taskIdx].done = !list[taskHit.taskIdx].done;
          const done = list.filter((t) => t.done).length;
          this.progress.set(taskHit.nodeId, done / list.length);
          this._emit('change');
        }
        return;
      }
      // Node?
      const nid = this.w.hitTestNode(wp.x, wp.y);
      if (nid !== -1) {
        if (!e.shiftKey && this.V.selected[nid] === 0) { this.w.clearSelection(); this.w.setSelected(nid, 1); }
        else if (e.shiftKey) this.w.toggleSelected(nid);
        // Locked / read-only → select but do not drag.
        if (!this.readOnly && !this.locked.has(nid)) {
          this._mode = 'drag';
          this._dragLast = wp;
        }
        this._emit('select', this.getSelection());
        return;
      }
      // Edge click → select.
      const eid = this._hitTestEdge(wp.x, wp.y, 6 / this.cam.zoom);
      if (eid !== -1) {
        if (!e.shiftKey) this.w.clearSelection();
        this.w.setEdgeSelected(eid, 1);
        this._emit('select', this.getSelection());
        return;
      }
      // Alt-drag empty → lasso.
      if (e.altKey) {
        if (!e.shiftKey) this.w.clearSelection();
        this._mode = 'lasso';
        this._lasso = [{ x: wp.x, y: wp.y }];
        return;
      }
      // Empty space → marquee.
      if (!e.shiftKey) this.w.clearSelection();
      this._mode = 'marquee';
      this._marquee = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
    });

    c.addEventListener('mousemove', (e) => {
      const wp = this._s2w(e.clientX, e.clientY);
      if (this._mode === 'pan') {
        const dpr = window.devicePixelRatio || 1;
        const dxW = (e.clientX - this._dragStart.sx) * dpr / this.cam.zoom;
        const dyW = (e.clientY - this._dragStart.sy) * dpr / this.cam.zoom;
        this.cam.x += dxW; this.cam.y += dyW;
        const now = performance.now();
        const dt = Math.max(1, now - (this._panVel.lastTs || now)) / 1000;
        this._panVel.x = dxW / dt; this._panVel.y = dyW / dt; this._panVel.lastTs = now;
        this._dragStart.sx = e.clientX; this._dragStart.sy = e.clientY;
        return;
      }
      if (this._mode === 'resize' && this._resizingHandle) {
        const dx = wp.x - this._resizingHandle.lastX, dy = wp.y - this._resizingHandle.lastY;
        this._applyResize(this._resizingHandle.corner, dx, dy);
        this._resizingHandle.lastX = wp.x; this._resizingHandle.lastY = wp.y;
        return;
      }
      if (this._mode === 'drag-waypoint' && this._draggingWaypoint) {
        const { edgeIdx, wpIdx } = this._draggingWaypoint;
        const list = this._edgeWaypoints.get(edgeIdx);
        if (list && list[wpIdx]) { list[wpIdx].x = wp.x; list[wpIdx].y = wp.y; }
        return;
      }
      if (this._mode === 'drag') {
        if (this._gl) {
          this._ensureAdj();
          for (let i = 0; i < this.w.nodeCount_(); i++) if (this.V.selected[i]) {
            this._gl.markNodeDirty(i);
            const edges = this._nodeAdj[i];
            if (edges) for (let k = 0; k < edges.length; k++) this._gl.markEdgeDirty(edges[k]);
          }
        }
        let dx = wp.x - this._dragLast.x, dy = wp.y - this._dragLast.y;
        if (this.options.snapToGrid) {
          // Snap by the first selected node.
          for (let i = 0; i < this.w.nodeCount_(); i++) {
            if (this.V.selected[i]) {
              const grid = this.options.gridSize;
              const nx = Math.round((this.V.posX[i] + dx) / grid) * grid;
              const ny = Math.round((this.V.posY[i] + dy) / grid) * grid;
              dx = nx - this.V.posX[i]; dy = ny - this.V.posY[i]; break;
            }
          }
          this._alignGuides = null;
        } else {
          const sa = this._computeAlignSnap(dx, dy);
          dx += sa.dx; dy += sa.dy;
          this._alignGuides = { v: sa.guideX !== null ? [sa.guideX] : [],
                                h: sa.guideY !== null ? [sa.guideY] : [] };
        }
        this.w.moveSelectedBy(dx, dy);
        this._dragLast = { x: this._dragLast.x + dx, y: this._dragLast.y + dy };
        return;
      }
      if (this._mode === 'drag-frame') {
        const dx = wp.x - this._frameDragLast.x, dy = wp.y - this._frameDragLast.y;
        const f = this.frames[this._draggingFrame];
        f.x += dx; f.y += dy;
        for (let i = 0; i < this.w.nodeCount_(); i++) {
          if (this.V.posX[i] >= f.x && this.V.posX[i] <= f.x + f.w &&
              this.V.posY[i] >= f.y && this.V.posY[i] <= f.y + f.h) {
            this.V.posX[i] += dx; this.V.posY[i] += dy;
          }
        }
        this._frameDragLast = wp;
        return;
      }
      if (this._mode === 'resize-frame' && this._resizingFrame) {
        const dx = wp.x - this._resizingFrame.lastX, dy = wp.y - this._resizingFrame.lastY;
        this._applyFrameResize(this._resizingFrame.idx, this._resizingFrame.corner, dx, dy);
        this._resizingFrame.lastX = wp.x; this._resizingFrame.lastY = wp.y;
        return;
      }
      if (this._mode === 'drag-note') {
        const dx = wp.x - this._noteDragLast.x, dy = wp.y - this._noteDragLast.y;
        const n = this.notes[this._draggingNote];
        n.x += dx; n.y += dy;
        this._noteDragLast = wp;
        return;
      }
      if (this._mode === 'connecting') {
        this._edgeCursor = wp;
        return;
      }
      if (this._mode === 'lasso' && this._lasso) {
        const last = this._lasso[this._lasso.length - 1];
        if (Math.hypot(wp.x - last.x, wp.y - last.y) > 6 / this.cam.zoom) {
          this._lasso.push({ x: wp.x, y: wp.y });
        }
        return;
      }
      if (this._mode === 'marquee') {
        this._marquee.x1 = wp.x; this._marquee.y1 = wp.y;
        this.w.selectInRect(this._marquee.x0, this._marquee.y0, this._marquee.x1, this._marquee.y1, 1);
        return;
      }
      // Idle hover.
      const newHover = this.w.hitTestNode(wp.x, wp.y);
      if (newHover !== this._hoveredNode) {
        this._hoveredNode = newHover;
        this._hoveredNodeSince = performance.now();
        this._lastFocusComputed = -2;
      }
      this._hoveredEdge = newHover === -1 ? this._hitTestEdge(wp.x, wp.y, 6 / this.cam.zoom) : -1;
      const handle = this._hitHandle(wp.x, wp.y);
      c.style.cursor = handle ? HANDLE_CURSOR[handle.corner] : '';
    });

    c.addEventListener('mouseup', () => {
      if (this._mode === 'connecting' && this._edgeCursor) {
        // Bidirectional: accept either output→input or input→output drop.
        const ph = this.w.hitTestPort(this._edgeCursor.x, this._edgeCursor.y, 14);
        if (ph !== -1) {
          const ts = (ph >>> 24) & 0xFF, ti = (ph >>> 16) & 0xFF, tn = ph & 0xFFFF;
          if (ts !== this._edgeStart.side && tn !== this._edgeStart.nodeId) {
            const fromN = this._edgeStart.side === 1 ? this._edgeStart.nodeId : tn;
            const fromP = this._edgeStart.side === 1 ? this._edgeStart.idx    : ti;
            const toN   = this._edgeStart.side === 0 ? this._edgeStart.nodeId : tn;
            const toP   = this._edgeStart.side === 0 ? this._edgeStart.idx    : ti;
            const reason = this.validateConnection(fromN, fromP, toN, toP);
            if (reason === null) {
              this.addEdge({ from: fromN, fp: fromP, to: toN, tp: toP });
            } else {
              this._emit('connection:rejected', { fromN, fromP, toN, toP, reason });
              this._flashReject = { x: this._edgeCursor.x, y: this._edgeCursor.y, msg: reason, t0: performance.now() };
            }
          }
        }
      } else if (this._mode === 'lasso' && this._lasso && this._lasso.length > 2) {
        for (let i = 0; i < this.w.nodeCount_(); i++) {
          if (pointInPolygon(this.V.posX[i], this.V.posY[i], this._lasso)) this.w.setSelected(i, 1);
        }
        this._emit('select', this.getSelection());
      } else if (this._mode === 'drag-waypoint') {
        this._draggingWaypoint = null;
        this._emit('change');
      } else if (this._mode === 'drag' || this._mode === 'resize' ||
                 this._mode === 'drag-frame' || this._mode === 'resize-frame' || this._mode === 'drag-note' ||
                 this._mode === 'marquee') {
        if (this._mode !== 'marquee') { this.w.snapshot(); this._emit('change'); }
        this._emit('select', this.getSelection());
      }
      this._mode = 'idle';
      this._edgeStart = null; this._edgeCursor = null;
      this._marquee = null; this._lasso = null; this._alignGuides = null;
      this._resizingHandle = null; this._resizingFrame = null;
      this._draggingFrame = -1; this._draggingNote = -1;
      this.canvas.classList.remove('panning');
      this.canvas.style.cursor = '';
    });

    // ── Touch: pinch zoom + two-finger pan ────────────────────────────
    const pointers = new Map(); // pointerId -> { x, y }
    let pinchPrev = null;       // { dist, mid }
    let longPressTimer = null;
    // Track which mouse events came synthesized from pointer to suppress double-firing.
    this._pointerSynthesizing = false;
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;          // mouse already handled
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        pinchPrev = pinchInfo(pointers);
        this._mode = 'pinch';
      } else if (pointers.size === 1) {
        // Start long-press timer for context menu.
        const x = e.clientX, y = e.clientY;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          const wp = this._s2w(x, y);
          this._onRightClick({ clientX: x, clientY: y, preventDefault() {} }, wp);
        }, 550);
        // Simulate a left mousedown for taps.
        this._pointerSynthesizing = true;
        c.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
        this._pointerSynthesizing = false;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchPrev) {
        const cur = pinchInfo(pointers);
        const zoomFactor = cur.dist / pinchPrev.dist;
        const before = this._s2w(cur.mid.x, cur.mid.y);
        this.cam.zoom = Math.max(0.2, Math.min(3.0, this.cam.zoom * zoomFactor));
        const after  = this._s2w(cur.mid.x, cur.mid.y);
        this.cam.x += after.x - before.x; this.cam.y += after.y - before.y;
        const dpr = window.devicePixelRatio || 1;
        this.cam.x += (cur.mid.x - pinchPrev.mid.x) * dpr / this.cam.zoom;
        this.cam.y += (cur.mid.y - pinchPrev.mid.y) * dpr / this.cam.zoom;
        pinchPrev = cur;
      } else if (pointers.size === 1) {
        if (longPressTimer && Math.hypot(e.movementX || 0, e.movementY || 0) > 4) {
          clearTimeout(longPressTimer); longPressTimer = null;
        }
        this._pointerSynthesizing = true;
        c.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY, button: 0, bubbles: true }));
        this._pointerSynthesizing = false;
      }
    });
    const endPointer = (e) => {
      if (e.pointerType === 'mouse') return;
      pointers.delete(e.pointerId);
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (pointers.size < 2) { pinchPrev = null; if (this._mode === 'pinch') this._mode = 'idle'; }
      if (pointers.size === 0) {
        this._pointerSynthesizing = true;
        c.dispatchEvent(new MouseEvent('mouseup', { clientX: e.clientX, clientY: e.clientY, button: 0, bubbles: true }));
        this._pointerSynthesizing = false;
      }
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const isPinch = e.ctrlKey;
      if (isPinch || e.deltaMode === 1) {
        const before = this._s2w(e.clientX, e.clientY);
        this.cam.zoom = Math.max(0.2, Math.min(3.0,
          this.cam.zoom * Math.exp(-e.deltaY * (isPinch ? 0.012 : 0.05))));
        const after = this._s2w(e.clientX, e.clientY);
        this.cam.x += after.x - before.x; this.cam.y += after.y - before.y;
        return;
      }
      // Trackpad two-finger pan.
      const dpr = window.devicePixelRatio || 1;
      this.cam.x -= e.deltaX * dpr / this.cam.zoom;
      this.cam.y -= e.deltaY * dpr / this.cam.zoom;
    }, { passive: false });

    c.addEventListener('dblclick', (e) => {
      const wp = this._s2w(e.clientX, e.clientY);
      // Frame header → drill into subflow.
      const fh = this._hitFrameHeader(wp.x, wp.y);
      if (fh !== -1) { this.enterSubflow(this.frames[fh].id); return; }
      // Note → edit text.
      const nh = this._hitNote(wp.x, wp.y);
      if (nh !== -1) { this._startEditingNote(nh); return; }
      const nid = this.w.hitTestNode(wp.x, wp.y);
      if (nid !== -1) {
        if (this.options.dblclickEditsTitle !== false) this._startEditingTitle(nid);
        this._emit('node:dblclick', nid);
        return;
      }
      const eid = this._hitTestEdge(wp.x, wp.y, 6 / this.cam.zoom);
      if (eid !== -1) { this._emit('edge:dblclick', eid); return; }
      this._emit('canvas:dblclick', wp);
    });
  }

  _startPan(e) {
    this._mode = 'pan';
    this._dragStart = { sx: e.clientX, sy: e.clientY };
    this._panVel.x = 0; this._panVel.y = 0; this._panVel.lastTs = performance.now();
    this.canvas.style.cursor = 'grabbing';
  }

  _attachKeyboard() {
    const handler = (e) => {
      // Only handle when our container has focus (or the canvas).
      const inOwn = this.container.contains(document.activeElement) || document.activeElement === document.body;
      if (!inOwn) return;
      // Don't steal typing in inputs/textareas.
      const t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.deleteSelection() > 0) e.preventDefault();
        return;
      }
      if (ctrl && e.code === 'KeyZ' && !e.shiftKey) { this.undo(); e.preventDefault(); return; }
      if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { this.redo(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyA') { this.selectAll(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyD') { this.duplicateSelection(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyC') { this._copy(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyV') { this._paste(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyG') { this.groupSelection(); e.preventDefault(); return; }
      if (ctrl && e.code === 'BracketRight') { this.bringToFront(); e.preventDefault(); return; }
      if (ctrl && e.code === 'BracketLeft')  { this.sendToBack();   e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyK')         { this.openCommandPalette(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyF' && this.options.search) { this.openSearch(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyT')         { this.toggleTheme(); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyM')         { this.setMinimap(!this.options.minimap); e.preventDefault(); return; }
      if (ctrl && e.code === 'KeyE')         { this.setAllEdgesAnimated(this.animatedEdges.size === 0); e.preventDefault(); return; }
      if (!ctrl && e.code === 'Digit0')      { this.fitView(); e.preventDefault(); return; }
      if (!ctrl && e.code === 'KeyL' && !this._editingTitle && this._editingNote === -1) { this.runAutoLayout(); e.preventDefault(); return; }
      if (e.code === 'F5' && !e.shiftKey)    { this.run(); e.preventDefault(); return; }
      if (e.code === 'F5' && e.shiftKey)     { this.stop(); e.preventDefault(); return; }
      if (e.code === 'Tab' && !ctrl) {
        const n = this.w.nodeCount_();
        if (n === 0) return;
        let cur = this.getSelection()[0] ?? -1;
        let next = e.shiftKey ? cur - 1 : cur + 1;
        if (cur === -1) next = 0;
        if (next < 0)   next = n - 1;
        if (next >= n)  next = 0;
        this.clearSelection(); this.w.setSelected(next, 1);
        this.panTo(this.V.posX[next], this.V.posY[next]);
        e.preventDefault();
        return;
      }
      if (!ctrl && /^Digit[1-9]$/.test(e.code)) {
        const slot = parseInt(e.code.slice(5), 10);
        if (e.altKey) this.jumpBookmark(slot);
        else          this.setBookmark(slot);
        e.preventDefault();
        return;
      }
      if (e.code === 'Escape') {
        // Cancel an in-progress edge or exit subflow before falling through.
        if (this._mode === 'connecting') {
          this._mode = 'idle'; this._edgeStart = null; this._edgeCursor = null;
          this.canvas.style.cursor = '';
          return;
        }
        if (this._focusFrame !== -1) { this.exitSubflow(); return; }
        this.clearSelection(); this._hideMenu(); return;
      }
      if (e.code.startsWith('Arrow')) {
        const d = e.shiftKey ? 1 : 10;
        const dx = e.code === 'ArrowLeft' ? -d : e.code === 'ArrowRight' ? d : 0;
        const dy = e.code === 'ArrowUp'   ? -d : e.code === 'ArrowDown'  ? d : 0;
        if (this.getSelection().length > 0) {
          this.w.moveSelectedBy(dx, dy);
          if (this._nudgeTimer) clearTimeout(this._nudgeTimer);
          this._nudgeTimer = setTimeout(() => { this.w.snapshot(); this._emit('change'); }, 400);
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handler);
    this._keyHandler = handler;
  }

  // ── Clipboard ─────────────────────────────────────────────────────────
  _copy() {
    const sel = this.getSelection();
    if (sel.length === 0) return;
    const selSet = new Set(sel);
    const nodes = sel.map((i) => ({
      origId: i,
      kind: this.kinds[this.V.kind[i]].name,
      x: this.V.posX[i], y: this.V.posY[i], w: this.V.sizeW[i], h: this.V.sizeH[i],
      title: this.titles.get(i), color: this.colors.get(i),
      description: this.descriptions.get(i), tags: this.tags.get(i),
      status: this.status.get(i), progress: this.progress.get(i),
      data: this.data.get(i),
    }));
    const edges = [];
    for (let e = 0; e < this.w.edgeCount_(); e++) {
      if (selSet.has(this.V.edgeFromN[e]) && selSet.has(this.V.edgeToN[e])) {
        edges.push({ from: this.V.edgeFromN[e], fp: this.V.edgeFromP[e],
                     to:   this.V.edgeToN[e],   tp: this.V.edgeToP[e],
                     label: this.edgeLabels.get(e) });
      }
    }
    let minX = Infinity, minY = Infinity;
    for (const n of nodes) { if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y; }
    this._clipboard = { nodes, edges, anchor: { x: minX, y: minY } };
  }
  _paste() {
    if (!this._clipboard) return;
    const c = this._clipboard;
    const px = -this.cam.x, py = -this.cam.y;
    const dx = px - c.anchor.x, dy = py - c.anchor.y;
    const idMap = new Map();
    this.clearSelection();
    for (const n of c.nodes) {
      const id = this.addNode({
        kind: n.kind, x: n.x + dx, y: n.y + dy, w: n.w, h: n.h,
        title: n.title, color: n.color, description: n.description,
        tags: n.tags, status: n.status, progress: n.progress,
        data: n.data,
      });
      idMap.set(n.origId, id);
      this.w.setSelected(id, 1);
    }
    for (const e of c.edges) {
      const a = idMap.get(e.from), b = idMap.get(e.to);
      if (a !== undefined && b !== undefined) this.addEdge({ from: a, fp: e.fp, to: b, tp: e.tp, label: e.label });
    }
    this._clipboard = { ...c, anchor: { x: c.anchor.x - 24, y: c.anchor.y - 24 } };
    this.w.snapshot();
    this._emit('change');
  }

  // ── Resize handles ────────────────────────────────────────────────────
  // ── Frame hit-tests + resize ──────────────────────────────────────────
  _hitFrameHeader(qx, qy) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (qx < f.x || qx > f.x + f.w) continue;
      if (qy < f.y || qy > f.y + 26) continue;
      return i;
    }
    return -1;
  }
  _hitFrameCorner(qx, qy) {
    const tol = 14 / this.cam.zoom;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      const corners = {
        tl: { x: f.x, y: f.y }, tr: { x: f.x + f.w, y: f.y },
        bl: { x: f.x, y: f.y + f.h }, br: { x: f.x + f.w, y: f.y + f.h },
      };
      for (const c of ['br', 'bl', 'tr', 'tl']) {
        const p = corners[c];
        if (Math.abs(qx - p.x) < tol && Math.abs(qy - p.y) < tol) return { idx: i, corner: c };
      }
    }
    return null;
  }
  _applyFrameResize(idx, corner, dx, dy) {
    const f = this.frames[idx], MIN_W = 120, MIN_H = 80;
    if (corner === 'br') { f.w += dx; f.h += dy; }
    if (corner === 'bl') { f.x += dx; f.w -= dx; f.h += dy; }
    if (corner === 'tr') { f.w += dx; f.y += dy; f.h -= dy; }
    if (corner === 'tl') { f.x += dx; f.w -= dx; f.y += dy; f.h -= dy; }
    if (f.w < MIN_W) { if (corner === 'bl' || corner === 'tl') f.x -= (MIN_W - f.w); f.w = MIN_W; }
    if (f.h < MIN_H) { if (corner === 'tl' || corner === 'tr') f.y -= (MIN_H - f.h); f.h = MIN_H; }
  }
  _hitNote(qx, qy) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (qx >= n.x && qx <= n.x + n.w && qy >= n.y && qy <= n.y + n.h) return i;
    }
    return -1;
  }
  _hitTaskCheckbox(qx, qy) {
    const n = this.w.nodeCount_();
    for (let i = n - 1; i >= 0; i--) {
      const list = this.tasks.get(i);
      if (!list || !list.length) continue;
      const cx = this.V.posX[i], cy = this.V.posY[i];
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (qx < cx - hw || qx > cx + hw || qy < cy - hh || qy > cy + hh) continue;
      // Rough layout: each row 14 world-units tall, starting ~30 from top.
      const innerLeft = cx - hw + 8;
      let curY = cy - hh + 32;
      if (this.descriptions.get(i)) curY += 30;
      const rowH = 14, boxS = 10;
      for (let t = 0; t < list.length; t++) {
        if (qx >= innerLeft && qx <= innerLeft + boxS && qy >= curY && qy <= curY + boxS) {
          return { nodeId: i, taskIdx: t };
        }
        curY += rowH;
        if (curY > cy + hh - 6) break;
      }
    }
    return null;
  }

  _hitHandle(qx, qy) {
    // Only when exactly 1 node selected.
    const sel = this.getSelection();
    if (sel.length !== 1) return null;
    const id = sel[0];
    const cx = this.V.posX[id], cy = this.V.posY[id];
    const hw = this.V.sizeW[id] * 0.5, hh = this.V.sizeH[id] * 0.5;
    const tol = 6 / this.cam.zoom;
    const pts = {
      tl: {x: cx-hw, y: cy-hh}, t: {x: cx, y: cy-hh}, tr: {x: cx+hw, y: cy-hh},
      r:  {x: cx+hw, y: cy},
      br: {x: cx+hw, y: cy+hh}, b: {x: cx, y: cy+hh}, bl: {x: cx-hw, y: cy+hh},
      l:  {x: cx-hw, y: cy},
    };
    for (const c of HANDLE_CORNERS) {
      const p = pts[c];
      if (Math.abs(qx - p.x) < tol && Math.abs(qy - p.y) < tol) return { nodeId: id, corner: c };
    }
    return null;
  }
  _applyResize(corner, dx, dy) {
    const id = this._resizingHandle.nodeId;
    const MIN = 60;
    let nw = this.V.sizeW[id], nh = this.V.sizeH[id];
    let dcx = 0, dcy = 0;
    if (HANDLE_LEFTS.has(corner))  { nw -= dx; dcx = dx * 0.5; }
    if (HANDLE_RIGHTS.has(corner)) { nw += dx; dcx = dx * 0.5; }
    if (HANDLE_TOPS.has(corner))   { nh -= dy; dcy = dy * 0.5; }
    if (HANDLE_BOTS.has(corner))   { nh += dy; dcy = dy * 0.5; }
    if (nw < MIN) { nw = MIN; dcx = 0; }
    if (nh < MIN) { nh = MIN; dcy = 0; }
    this.V.sizeW[id] = nw; this.V.sizeH[id] = nh;
    this.V.posX[id] += dcx; this.V.posY[id] += dcy;
  }

  // ── Alignment guides (during drag) ────────────────────────────────────
  _computeAlignSnap(deltaX, deltaY) {
    const ALIGN_EPS = 6;
    const n = this.w.nodeCount_();
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
      if (this.V.selected[i]) continue;
      const cx = this.V.posX[i], cy = this.V.posY[i];
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      xs.push(cx, cx - hw, cx + hw);
      ys.push(cy, cy - hh, cy + hh);
    }
    let bestDX = 0, bestDY = 0, foundX = null, foundY = null;
    let bestX = ALIGN_EPS + 1, bestY = ALIGN_EPS + 1;
    for (let i = 0; i < n; i++) {
      if (!this.V.selected[i]) continue;
      const tcx = this.V.posX[i] + deltaX, tcy = this.V.posY[i] + deltaY;
      for (const x of xs) {
        const d = tcx - x;
        if (Math.abs(d) < bestX) { bestX = Math.abs(d); bestDX = -d; foundX = x; }
      }
      for (const y of ys) {
        const d = tcy - y;
        if (Math.abs(d) < bestY) { bestY = Math.abs(d); bestDY = -d; foundY = y; }
      }
    }
    return { dx: bestX <= ALIGN_EPS ? bestDX : 0, dy: bestY <= ALIGN_EPS ? bestDY : 0,
             guideX: foundX, guideY: foundY };
  }

  // ── Edge hit-test (JS-side, samples bezier or polyline) ──────────────
  _hitTestEdge(qx, qy, tolWorld) {
    const tol2 = tolWorld * tolWorld;
    const m = this.w.edgeCount_();
    let bestIdx = -1, bestDist = tol2;
    for (let i = 0; i < m; i++) {
      const ap = this._portWorld(this.V.edgeFromN[i], 1, this.V.edgeFromP[i]);
      const bp = this._portWorld(this.V.edgeToN[i],   0, this.V.edgeToP[i]);
      const minx = Math.min(ap.x, bp.x) - tolWorld, maxx = Math.max(ap.x, bp.x) + tolWorld;
      const miny = Math.min(ap.y, bp.y) - tolWorld - 80, maxy = Math.max(ap.y, bp.y) + tolWorld + 80;
      if (qx < minx || qx > maxx || qy < miny || qy > maxy) continue;
      if (this.options.edgeStyle === 'orthogonal') {
        const path = this._orthoPath(ap, bp);
        for (let s = 0; s < path.length - 1; s++) {
          const d2 = distSeg2(qx, qy, path[s].x, path[s].y, path[s+1].x, path[s+1].y);
          if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
        }
      } else {
        const dxe = bp.x - ap.x, dye = bp.y - ap.y;
        const off = Math.max(50, Math.abs(dxe) * 0.5 + Math.abs(dye) * 0.4);
        for (let s = 0; s <= 16; s++) {
          const t = s / 16;
          const pt = bezPt(t, ap.x, ap.y, ap.x + off, ap.y, bp.x - off, bp.y, bp.x, bp.y);
          const ddx = pt.x - qx, ddy = pt.y - qy;
          const d2 = ddx*ddx + ddy*ddy;
          if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
        }
      }
    }
    return bestIdx;
  }

  // ── Right-click menu ──────────────────────────────────────────────────
  _onRightClick(e, wp) {
    if (!this.options.contextMenu) return;
    const nid = this.w.hitTestNode(wp.x, wp.y);
    const eid = nid === -1 ? this._hitTestEdge(wp.x, wp.y, 6 / this.cam.zoom) : -1;
    let items;
    if (nid !== -1) {
      if (this.V.selected[nid] === 0) { this.w.clearSelection(); this.w.setSelected(nid, 1); }
      items = [
        { label: 'Duplicate',      kbd: 'Ctrl+D', fn: () => this.duplicateSelection() },
        { label: 'Delete',         kbd: 'Del',   danger: true, fn: () => this.deleteSelection() },
        { sep: true },
        { label: 'Deselect',       kbd: 'Esc',   fn: () => this.clearSelection() },
      ];
    } else if (eid !== -1) {
      const a = this.V.edgeFromN[eid], b = this.V.edgeToN[eid];
      items = [
        { label: 'Select endpoints', fn: () => { this.clearSelection(); this.w.setSelected(a,1); this.w.setSelected(b,1); this._emit('select', this.getSelection()); } },
        { label: 'Set label…',       fn: () => { const v = prompt('Edge label', this.edgeLabels.get(eid) || ''); if (v !== null) this.setEdgeLabel(eid, v); } },
        { sep: true },
        { label: 'Delete edge', danger: true, fn: () => { this.w.deleteEdge(eid); this.edgeLabels.delete(eid); this.w.snapshot(); this._emit('change'); } },
      ];
    } else {
      items = [
        { label: 'Add Process node here', fn: () => this.addNode({ kind: 'process', x: wp.x, y: wp.y }) },
        { sep: true },
        { label: 'Select all', kbd: 'Ctrl+A', fn: () => this.selectAll() },
        { label: 'Auto-layout',            fn: () => this.runAutoLayout() },
        { label: 'Fit view',               fn: () => this.fitView() },
      ];
    }
    this._showMenu(e.clientX, e.clientY, items);
  }
  // ── Inline editors (title + note) ─────────────────────────────────────
  _startEditingTitle(nodeId) {
    this._editingTitle = nodeId;
    if (!this._editingTitleEl) {
      const el = document.createElement('input');
      el.type = 'text';
      Object.assign(el.style, {
        position: 'absolute', background: '#161b27', color: '#e6edf3',
        border: '1px solid #f0b93a', borderRadius: '4px',
        fontFamily: 'Inter, ui-sans-serif', fontSize: '12px', fontWeight: '600',
        padding: '4px 8px', outline: 'none', zIndex: '300',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
      });
      this.container.appendChild(el);
      el.addEventListener('blur', () => this._stopEditingTitle());
      el.addEventListener('keydown', (e) => { if (e.code === 'Enter' || e.code === 'Escape') el.blur(); });
      this._editingTitleEl = el;
    }
    this._positionTitleEditor();
    this._editingTitleEl.value = this.titles.get(nodeId) || '';
    this._editingTitleEl.placeholder = `${this.kinds[this.V.kind[nodeId]].name} #${nodeId}`;
    this._editingTitleEl.style.display = 'block';
    setTimeout(() => { this._editingTitleEl.focus(); this._editingTitleEl.select(); }, 20);
  }
  _positionTitleEditor() {
    if (this._editingTitle === -1 || !this._editingTitleEl) return;
    const i = this._editingTitle;
    const cx = this.V.posX[i], cy = this.V.posY[i];
    const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
    const tl = this._w2s(cx - hw, cy - hh);
    const dpr = window.devicePixelRatio || 1;
    this._editingTitleEl.style.left  = (tl.x / dpr) + 'px';
    this._editingTitleEl.style.top   = (tl.y / dpr - 32) + 'px';
    this._editingTitleEl.style.width = Math.max(120, this.V.sizeW[i] * this.cam.zoom / dpr) + 'px';
  }
  _stopEditingTitle() {
    if (this._editingTitle === -1) return;
    const v = this._editingTitleEl.value.trim();
    if (v) this.titles.set(this._editingTitle, v);
    else   this.titles.delete(this._editingTitle);
    this._editingTitleEl.style.display = 'none';
    this._editingTitle = -1;
    this._emit('change');
  }
  _startEditingNote(idx) {
    this._editingNote = idx;
    if (!this._editingNoteEl) {
      const el = document.createElement('textarea');
      el.spellcheck = false;
      Object.assign(el.style, {
        position: 'absolute', resize: 'none', outline: 'none',
        border: '1px solid #f0b93a', borderRadius: '4px',
        padding: '8px 10px', fontFamily: 'Inter, ui-sans-serif',
        fontSize: '12px', lineHeight: '16px', zIndex: '300',
      });
      this.container.appendChild(el);
      el.addEventListener('blur', () => this._stopEditingNote());
      el.addEventListener('keydown', (e) => { if (e.code === 'Escape') el.blur(); });
      this._editingNoteEl = el;
    }
    this._positionNoteEditor();
    const n = this.notes[idx];
    this._editingNoteEl.style.background = n.color.fill;
    this._editingNoteEl.style.color = n.color.text;
    this._editingNoteEl.value = n.text;
    this._editingNoteEl.style.display = 'block';
    setTimeout(() => this._editingNoteEl.focus(), 20);
  }
  _positionNoteEditor() {
    if (this._editingNote === -1 || !this._editingNoteEl) return;
    const n = this.notes[this._editingNote];
    const tl = this._w2s(n.x, n.y);
    const dpr = window.devicePixelRatio || 1;
    this._editingNoteEl.style.left  = (tl.x / dpr) + 'px';
    this._editingNoteEl.style.top   = (tl.y / dpr) + 'px';
    this._editingNoteEl.style.width  = (n.w * this.cam.zoom / dpr) + 'px';
    this._editingNoteEl.style.height = (n.h * this.cam.zoom / dpr) + 'px';
  }
  _stopEditingNote() {
    if (this._editingNote === -1) return;
    this.notes[this._editingNote].text = this._editingNoteEl.value;
    this._editingNoteEl.style.display = 'none';
    this._editingNote = -1;
    this._emit('change');
  }

  _showMenu(x, y, items) {
    this._hideMenu();
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;min-width:200px;padding:4px;background:#161b27;border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.45);z-index:99999;color:#e6edf3;font:13px/1.45 ui-sans-serif, system-ui, sans-serif;';
    for (const it of items) {
      if (it.sep) { const d = document.createElement('div'); d.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px;'; m.appendChild(d); continue; }
      const d = document.createElement('div');
      d.style.cssText = `padding:6px 10px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;${it.danger ? 'color:#ffb4a4;' : ''}`;
      d.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.kbd ? `<span style="color:#5a6577;font-family:ui-monospace,Consolas,monospace;font-size:11px;">${escapeHtml(it.kbd)}</span>` : ''}`;
      d.onmouseenter = () => d.style.background = it.danger ? 'rgba(232,70,43,0.18)' : 'rgba(255,255,255,0.04)';
      d.onmouseleave = () => d.style.background = '';
      d.onclick = () => { it.fn(); this._hideMenu(); };
      m.appendChild(d);
    }
    m.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    m.style.top  = Math.min(y, window.innerHeight - 280) + 'px';
    document.body.appendChild(m);
    this._menuEl = m;
    setTimeout(() => {
      const off = (ev) => { if (!m.contains(ev.target)) { this._hideMenu(); document.removeEventListener('mousedown', off, true); } };
      document.addEventListener('mousedown', off, true);
    }, 0);
  }
  _hideMenu() { if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; } }

  // ── Render loop ───────────────────────────────────────────────────────
  _loop() { this._render(); this._raf = requestAnimationFrame(() => this._loop()); }

  _render() {
    // Pan inertia.
    if (this._mode !== 'pan') {
      const v2 = this._panVel.x * this._panVel.x + this._panVel.y * this._panVel.y;
      if (v2 < 16) { this._panVel.x = 0; this._panVel.y = 0; }
      else {
        this.cam.x += this._panVel.x * (1/60); this.cam.y += this._panVel.y * (1/60);
        this._panVel.x *= 0.91; this._panVel.y *= 0.91;
      }
    }

    const ctx = this.ctx;
    if (this._hooks?.beforeRender?.length) this._runHook('beforeRender', ctx);
    if (this._gl) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._gl.render();
    } else {
      ctx.fillStyle = this.options.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this._drawGrid();
    this._drawFrames();
    this._drawNotes();
    this._refreshFocus();
    this._refreshPreview();
    this._positionTitleEditor();
    this._positionNoteEditor();
    this._drawDying();
    this._drawWaypoints();
    this._drawRemoteCursors();
    this._drawValueBubbles();
    if (this.options.minimap) this._drawMinimap();

    const n = this.w.nodeCount_(), m = this.w.edgeCount_();
    // Edges first.
    this._edgePhase = (this._edgePhase + (this.options.edgeFlowSpeed || 60) * (1 / 60)) % 1000;
    for (let i = 0; i < m; i++) {
      const a = this.V.edgeFromN[i], b = this.V.edgeToN[i];
      const ap = this._portWorld(a, 1, this.V.edgeFromP[i]);
      const bp = this._portWorld(b, 0, this.V.edgeToP[i]);
      let dim = false;
      if (this._focusedSet && (!this._focusedSet.has(a) || !this._focusedSet.has(b))) dim = true;
      if (this._hoveredEdge !== -1 && this._hoveredEdge !== i) dim = true;
      if (this._focusFrame !== -1 && !(this._isInsideFocusFrame(a) && this._isInsideFocusFrame(b))) dim = true;
      if (dim) ctx.globalAlpha = 0.18;
      this._currentEdgeIdx = i;
      this._drawEdge(ap, bp,
        this.colors.get(a) || this.kinds[this.V.kind[a]].color,
        this.colors.get(b) || this.kinds[this.V.kind[b]].color,
        this.V.edgeSel[i] !== 0, false, this.edgeLabels.get(i));
      ctx.globalAlpha = 1;
    }
    this._currentEdgeIdx = undefined;
    // Edge in-flight preview.
    // Show rejection toast briefly (auto-clear after expiry).
    if (this._flashReject && performance.now() - this._flashReject.t0 >= 1400) {
      this._flashReject = null;
    }
    if (this._flashReject && performance.now() - this._flashReject.t0 < 1400) {
      const r = this._flashReject;
      const sp = this._w2s(r.x, r.y);
      const ctx = this.ctx;
      const alpha = 1 - (performance.now() - r.t0) / 1400;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e8462b'; ctx.font = '600 12px Inter, ui-sans-serif';
      const tw = ctx.measureText(r.msg).width;
      const bx = sp.x - tw / 2 - 8, by = sp.y - 36, bw = tw + 16, bh = 22;
      ctx.fillStyle = '#1a0e0e';
      this._roundRect(bx, by, bw, bh, 4); ctx.fill();
      ctx.strokeStyle = '#e8462b'; ctx.lineWidth = 1.4;
      this._roundRect(bx, by, bw, bh, 4); ctx.stroke();
      ctx.fillStyle = '#e8462b';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(r.msg, sp.x, by + bh / 2);
      ctx.restore();
    }
    if (this._mode === 'connecting' && this._edgeStart && this._edgeCursor) {
      const ap = this._portWorld(this._edgeStart.nodeId, 1, this._edgeStart.idx);
      this._drawEdge(ap, this._edgeCursor, '#8b95a7', '#8b95a7', false, true);
    }

    // Nodes — viewport culled via spatial grid for >300 nodes.
    const dpr = window.devicePixelRatio || 1;
    const halfW = this.canvas.width / (2 * this.cam.zoom);
    const halfH = this.canvas.height / (2 * this.cam.zoom);
    const viewMinX = -this.cam.x - halfW - 80, viewMaxX = -this.cam.x + halfW + 80;
    const viewMinY = -this.cam.y - halfH - 80, viewMaxY = -this.cam.y + halfH + 80;
    let order;
    if (n > 300) {
      const c = this.w.queryRect(viewMinX, viewMinY, viewMaxX, viewMaxY);
      order = Array.from(this.V.queryRes.subarray(0, c));
    } else {
      order = [];
      for (let i = 0; i < n; i++) order.push(i);
    }
    // Sort by z-order so bringToFront'd nodes paint last.
    order.sort((a, b) => {
      const za = this.zOrder.get(a) || 0, zb = this.zOrder.get(b) || 0;
      return za === zb ? a - b : za - zb;
    });
    for (const i of order) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (this.V.posX[i] + hw < viewMinX || this.V.posX[i] - hw > viewMaxX) continue;
      if (this.V.posY[i] + hh < viewMinY || this.V.posY[i] - hh > viewMaxY) continue;
      // Skip canvas render for HTML-overlay kinds (DOM handled separately).
      if (this.kinds[this.V.kind[i]].html) continue;
      if (this._nodeHiddenByCollapse(i)) continue;
      // Subflow / hovered-edge / focusedSet / reachable dimming.
      let dim = false;
      if (this._focusedSet && !this._focusedSet.has(i)) dim = true;
      if (this._reachableSet && !this._reachableSet.has(i)) dim = true;
      if (this._hoveredEdge !== -1) {
        const a = this.V.edgeFromN[this._hoveredEdge], b = this.V.edgeToN[this._hoveredEdge];
        if (i !== a && i !== b) dim = true;
      }
      if (this._focusFrame !== -1 && !this._isInsideFocusFrame(i)) dim = true;
      if (dim) ctx.globalAlpha = 0.22;
      // Pop-in animation.
      const popped = this._openPopAnim(i);
      if (this._gl) this._drawNodeOverlay(i);   // GL handled body+border; only paint text/badges/ports/etc
      else          this._drawNode(i);
      if (popped) ctx.restore();
      if (dim) ctx.globalAlpha = 1;
    }
    this._syncHTMLOverlays();
    this._drawMultiSelectBBox();
    this._drawMarquee();
    this._drawLasso();
    this._drawAlignGuides();
    this._drawResizeHandles();
    this._drawFrameHandles();
    void dpr;
  }

  _openPopAnim(i) {
    const at = this._nodeAddedAt.get(i);
    if (at === undefined) return false;
    const t = (performance.now() - at) / 280;
    if (t >= 1) { this._nodeAddedAt.delete(i); return false; }
    const e = 1 - Math.pow(1 - t, 3);
    const sp = this._w2s(this.V.posX[i], this.V.posY[i]);
    this.ctx.save();
    this.ctx.globalAlpha = e;
    this.ctx.translate(sp.x, sp.y);
    this.ctx.scale(0.85 + e * 0.15, 0.85 + e * 0.15);
    this.ctx.translate(-sp.x, -sp.y);
    return true;
  }

  _drawDying() {
    const now = performance.now();
    for (let i = this._dyingEdges.length - 1; i >= 0; i--) {
      const d = this._dyingEdges[i];
      const t = (now - d.t0) / 220;
      if (t >= 1) { this._dyingEdges.splice(i, 1); continue; }
      this.ctx.save();
      this.ctx.globalAlpha = (1 - t) * 0.7;
      this._drawEdge(d.ap, d.bp, d.colA, d.colB, false, true);
      this.ctx.restore();
    }
    for (let i = this._dyingNodes.length - 1; i >= 0; i--) {
      const d = this._dyingNodes[i];
      const t = (now - d.t0) / 220;
      if (t >= 1) { this._dyingNodes.splice(i, 1); continue; }
      const ease = 1 - Math.pow(1 - t, 3);
      const alpha = 1 - ease, scale = 1 - ease * 0.18;
      const hw = d.w * 0.5 * scale, hh = d.h * 0.5 * scale;
      const tl = this._w2s(d.x - hw, d.y - hh);
      const sw = d.w * scale * this.cam.zoom, sh = d.h * scale * this.cam.zoom;
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = '#161b27';
      this._shapePath(d.shape, tl.x, tl.y, sw, sh);
      this.ctx.fill();
      this.ctx.strokeStyle = alphaize(d.color, 0.6);
      this.ctx.lineWidth = 1.4 * this.cam.zoom;
      this._shapePath(d.shape, tl.x, tl.y, sw, sh);
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  _drawMultiSelectBBox() {
    if (this._mode !== 'idle') return;
    const sel = this.getSelection();
    if (sel.length < 2) return;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const i of sel) {
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      if (this.V.posX[i] - hw < mnx) mnx = this.V.posX[i] - hw;
      if (this.V.posX[i] + hw > mxx) mxx = this.V.posX[i] + hw;
      if (this.V.posY[i] - hh < mny) mny = this.V.posY[i] - hh;
      if (this.V.posY[i] + hh > mxy) mxy = this.V.posY[i] + hh;
    }
    const pad = 10;
    const a = this._w2s(mnx - pad, mny - pad), b = this._w2s(mxx + pad, mxy + pad);
    this.ctx.strokeStyle = 'rgba(240,185,58,0.55)';
    this.ctx.lineWidth = 1.2;
    this.ctx.setLineDash([5, 4]);
    this.ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    this.ctx.setLineDash([]);
  }

  _drawLasso() {
    if (!this._lasso || this._lasso.length < 2) return;
    this.ctx.strokeStyle = 'rgba(192,98,232,0.85)';
    this.ctx.fillStyle   = 'rgba(192,98,232,0.10)';
    this.ctx.lineWidth = 1.4;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    const first = this._w2s(this._lasso[0].x, this._lasso[0].y);
    this.ctx.moveTo(first.x, first.y);
    for (let i = 1; i < this._lasso.length; i++) {
      const p = this._w2s(this._lasso[i].x, this._lasso[i].y);
      this.ctx.lineTo(p.x, p.y);
    }
    this.ctx.closePath();
    this.ctx.fill(); this.ctx.stroke();
    this.ctx.setLineDash([]);
  }

  _drawFrames() {
    for (let fi = 0; fi < this.frames.length; fi++) {
      const f = this.frames[fi];
      const collapsed = this.frameCollapsed.has(fi);
      const tl = this._w2s(f.x, f.y);
      const sw = f.w * this.cam.zoom;
      const sh = (collapsed ? 26 : f.h) * this.cam.zoom;
      this.ctx.fillStyle = alphaize(f.color, 0.05);
      this._roundRect(tl.x, tl.y, sw, sh, 12 * this.cam.zoom);
      this.ctx.fill();
      this.ctx.strokeStyle = alphaize(f.color, 0.45);
      this.ctx.lineWidth = 1.4 * this.cam.zoom;
      this.ctx.setLineDash([8 * this.cam.zoom, 4 * this.cam.zoom]);
      this._roundRect(tl.x, tl.y, sw, sh, 12 * this.cam.zoom);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      const hH = 26 * this.cam.zoom;
      this.ctx.save();
      this._roundRect(tl.x, tl.y, sw, sh, 12 * this.cam.zoom);
      this.ctx.clip();
      this.ctx.fillStyle = alphaize(f.color, 0.16);
      this.ctx.fillRect(tl.x, tl.y, sw, hH);
      this.ctx.restore();
      if (this.cam.zoom > 0.4) {
        this.ctx.fillStyle = f.color;
        this.ctx.font = `600 ${12 * this.cam.zoom}px Inter, ui-sans-serif`;
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = 'left';
        const chev = collapsed ? '▸' : '▾';
        this.ctx.fillText(`${chev}  ${f.label}`, tl.x + 10 * this.cam.zoom, tl.y + hH * 0.5);
      }
    }
  }
  _drawFrameHandles() {
    for (const f of this.frames) {
      const tl = this._w2s(f.x, f.y);
      const br = this._w2s(f.x + f.w, f.y + f.h);
      const s = 6 * this.cam.zoom;
      this.ctx.fillStyle = f.color;
      for (const [x, y] of [[tl.x, tl.y], [br.x, tl.y], [tl.x, br.y], [br.x, br.y]]) {
        this.ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
  }

  _drawNotes() {
    for (const n of this.notes) {
      const tl = this._w2s(n.x, n.y);
      const sw = n.w * this.cam.zoom, sh = n.h * this.cam.zoom;
      this.ctx.save();
      this.ctx.shadowColor = 'rgba(0,0,0,0.4)';
      this.ctx.shadowBlur = 12 * this.cam.zoom;
      this.ctx.shadowOffsetY = 4 * this.cam.zoom;
      this.ctx.fillStyle = n.color.fill;
      this._roundRect(tl.x, tl.y, sw, sh, 4 * this.cam.zoom);
      this.ctx.fill();
      this.ctx.restore();
      this.ctx.strokeStyle = n.color.border;
      this.ctx.lineWidth = 1 * this.cam.zoom;
      this._roundRect(tl.x, tl.y, sw, sh, 4 * this.cam.zoom);
      this.ctx.stroke();
      if (this.cam.zoom > 0.4 && n.text) {
        this.ctx.fillStyle = n.color.text;
        this.ctx.font = `500 ${12 * this.cam.zoom}px Inter, ui-sans-serif`;
        this.ctx.textBaseline = 'top';
        this.ctx.textAlign = 'left';
        const lineH = 16 * this.cam.zoom;
        const padX = 10 * this.cam.zoom, padY = 8 * this.cam.zoom;
        const maxW = sw - padX * 2;
        let ty = tl.y + padY;
        for (const para of n.text.split('\n')) {
          const words = para.split(/\s+/);
          let line = '';
          for (const word of words) {
            const test = line ? line + ' ' + word : word;
            if (this.ctx.measureText(test).width > maxW && line) {
              this.ctx.fillText(line, tl.x + padX, ty); ty += lineH; line = word;
              if (ty > tl.y + sh - lineH) break;
            } else line = test;
          }
          if (line && ty < tl.y + sh - lineH * 0.5) { this.ctx.fillText(line, tl.x + padX, ty); ty += lineH; }
        }
      }
    }
  }

  // ── Path-highlight focus ──────────────────────────────────────────────
  _refreshFocus() {
    if (!this._pathHighlightEnabled) { this._focusedSet = null; return; }
    if (this._mode !== 'idle' || this._hoveredNode < 0) { this._focusedSet = null; this._lastFocusComputed = -2; return; }
    if (performance.now() - this._hoveredNodeSince < 200) return;
    if (this._hoveredNode === this._lastFocusComputed) return;
    const reach = new Set([this._hoveredNode]);
    const queue = [this._hoveredNode];
    const m = this.w.edgeCount_();
    while (queue.length) {
      const u = queue.shift();
      for (let i = 0; i < m; i++) {
        if (this.V.edgeFromN[i] === u && !reach.has(this.V.edgeToN[i])) { reach.add(this.V.edgeToN[i]); queue.push(this.V.edgeToN[i]); }
        if (this.V.edgeToN[i] === u && !reach.has(this.V.edgeFromN[i])) { reach.add(this.V.edgeFromN[i]); queue.push(this.V.edgeFromN[i]); }
      }
    }
    this._focusedSet = reach;
    this._lastFocusComputed = this._hoveredNode;
  }

  // ── Hover preview popover ────────────────────────────────────────────
  _refreshPreview() {
    if (!this.options.hoverPreview) { this._hidePreview(); return; }
    if (this._mode !== 'idle' || this._hoveredNode < 0) { this._hidePreview(); return; }
    if (performance.now() - this._hoveredNodeSince < 600) return;
    if (this._previewedNode === this._hoveredNode) { this._positionPreview(this._hoveredNode); return; }
    this._showPreview(this._hoveredNode);
    this._previewedNode = this._hoveredNode;
  }
  _showPreview(id) {
    if (!this._previewEl) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;width:260px;padding:12px 14px;background:#161b27;border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.45);color:#e6edf3;font:13px/1.45 ui-sans-serif, system-ui, sans-serif;pointer-events:none;opacity:0;transition:opacity 140ms;z-index:200;';
      this.container.appendChild(el);
      this._previewEl = el;
    }
    const cat = this.kinds[this.V.kind[id]];
    const title = this.titles.get(id) || cat.name;
    const desc = this.descriptions.get(id);
    const tags = this.tags.get(id) || [];
    const status = this.status.get(id);
    const progress = this.progress.get(id);
    const parts = [
      `<div style="display:flex;align-items:center;gap:8px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08);">
         <span style="width:24px;height:24px;border-radius:5px;background:${alphaize(cat.color, 0.18)};color:${cat.color};display:grid;place-items:center;font:700 12px Inter">${this.icon.get(id) || cat.badge}</span>
         <div><div style="font-weight:600">${escapeHtml(title)}</div><div style="color:#8b95a7;font-family:ui-monospace,Consolas,monospace;font-size:11px;">#${id} · ${cat.name}</div></div>
       </div>`,
    ];
    if (desc) parts.push(`<div style="font-size:12px;color:#8b95a7;margin-bottom:8px;">${escapeHtml(desc)}</div>`);
    if (status || progress !== undefined) {
      const bits = [];
      if (status) bits.push(`<span style="padding:2px 7px;border-radius:10px;background:rgba(255,255,255,0.06);">${status}</span>`);
      if (progress !== undefined) bits.push(`<span style="padding:2px 7px;border-radius:10px;background:rgba(255,255,255,0.06);">${Math.round(progress * 100)}%</span>`);
      parts.push(`<div style="display:flex;gap:6px;margin-bottom:8px;font-size:11px;">${bits.join('')}</div>`);
    }
    if (tags.length) parts.push(`<div style="display:flex;flex-wrap:wrap;gap:4px;">${tags.map((t) => `<span style="font-size:10.5px;padding:2px 7px;border-radius:3px;background:${alphaize(cat.color, 0.18)};color:${cat.color};">${escapeHtml(t)}</span>`).join('')}</div>`);
    this._previewEl.innerHTML = parts.join('');
    this._positionPreview(id);
    this._previewEl.style.opacity = '1';
  }
  _positionPreview(id) {
    if (!this._previewEl) return;
    const cx = this.V.posX[id], cy = this.V.posY[id];
    const hw = this.V.sizeW[id] * 0.5, hh = this.V.sizeH[id] * 0.5;
    const tr = this._w2s(cx + hw, cy - hh), tl = this._w2s(cx - hw, cy - hh);
    const cr = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let lx = tr.x / dpr + 12, ty = tr.y / dpr;
    if (lx + 280 > cr.width) lx = tl.x / dpr - 280 - 12;
    if (lx < 8) lx = 8;
    this._previewEl.style.left = lx + 'px';
    this._previewEl.style.top  = Math.max(8, ty) + 'px';
  }
  _hidePreview() {
    if (this._previewEl) this._previewEl.style.opacity = '0';
    this._previewedNode = -1;
  }

  // ── HTML overlay nodes ────────────────────────────────────────────────
  _syncHTMLOverlays() {
    const seen = new Set();
    const n = this.w.nodeCount_();
    for (let i = 0; i < n; i++) {
      const cat = this.kinds[this.V.kind[i]];
      if (!cat.html) continue;
      seen.add(i);
      let el = this._htmlOverlays.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = 'zflow-html-node';
        el.style.cssText = 'position:absolute;border:1px solid rgba(255,255,255,0.16);border-radius:8px;background:#161b27;color:#e6edf3;overflow:hidden;font-family:Inter, ui-sans-serif;font-size:12px;transform-origin:top left;';
        // cat.template comes from the plugin author who registered the kind —
        // treat as trusted. cat.name passes through escape to be safe.
        el.innerHTML = cat.template || `<div style="padding:8px;">${escapeHtml(cat.name)} #${i}</div>`;
        this.container.appendChild(el);
        this._htmlOverlays.set(i, el);
      }
      const cx = this.V.posX[i], cy = this.V.posY[i];
      const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
      const tl = this._w2s(cx - hw, cy - hh);
      const dpr = window.devicePixelRatio || 1;
      el.style.left   = (tl.x / dpr) + 'px';
      el.style.top    = (tl.y / dpr) + 'px';
      el.style.width  = (this.V.sizeW[i] * this.cam.zoom / dpr) + 'px';
      el.style.height = (this.V.sizeH[i] * this.cam.zoom / dpr) + 'px';
    }
    for (const [id, el] of this._htmlOverlays) {
      if (!seen.has(id)) { el.remove(); this._htmlOverlays.delete(id); }
    }
  }

  _drawGrid() {
    const ctx = this.ctx;
    const step = 40 * this.cam.zoom;
    if (step < 6) return;
    const cx = this.canvas.width / 2 + this.cam.x * this.cam.zoom;
    const cy = this.canvas.height / 2 + this.cam.y * this.cam.zoom;
    const startX = cx - Math.ceil(cx / step) * step;
    const startY = cy - Math.ceil(cy / step) * step;
    ctx.fillStyle = this.options.snapToGrid ? 'rgba(240,185,58,0.10)' : 'rgba(255,255,255,0.045)';
    const dpr = window.devicePixelRatio || 1;
    for (let x = startX; x < this.canvas.width; x += step) {
      for (let y = startY; y < this.canvas.height; y += step) {
        ctx.fillRect(x, y, 1.4 * dpr, 1.4 * dpr);
      }
    }
  }

  _drawMarquee() {
    if (!this._marquee) return;
    const a = this._w2s(this._marquee.x0, this._marquee.y0);
    const b = this._w2s(this._marquee.x1, this._marquee.y1);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(240,185,58,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(240,185,58,0.7)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  _drawAlignGuides() {
    if (!this._alignGuides) return;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(192,98,232,0.85)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 4]);
    for (const g of this._alignGuides.v) {
      const x = this._w2s(g, 0).x;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    }
    for (const g of this._alignGuides.h) {
      const y = this._w2s(0, g).y;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.canvas.width, y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _drawResizeHandles() {
    if (this._mode !== 'idle') return;
    const sel = this.getSelection();
    if (sel.length !== 1) return;
    const id = sel[0];
    const cx = this.V.posX[id], cy = this.V.posY[id];
    const hw = this.V.sizeW[id] * 0.5, hh = this.V.sizeH[id] * 0.5;
    const pts = {
      tl: {x: cx-hw, y: cy-hh}, t: {x: cx, y: cy-hh}, tr: {x: cx+hw, y: cy-hh},
      r:  {x: cx+hw, y: cy},
      br: {x: cx+hw, y: cy+hh}, b: {x: cx, y: cy+hh}, bl: {x: cx-hw, y: cy+hh},
      l:  {x: cx-hw, y: cy},
    };
    const ctx = this.ctx;
    const s = 4 * this.cam.zoom;
    ctx.fillStyle = '#f0b93a';
    ctx.strokeStyle = '#07090f';
    ctx.lineWidth = 1 * this.cam.zoom;
    for (const c of HANDLE_CORNERS) {
      const sp = this._w2s(pts[c].x, pts[c].y);
      ctx.beginPath();
      ctx.rect(sp.x - s, sp.y - s, s * 2, s * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  _portWorld(nodeId, side, idx) {
    const cx = this.V.posX[nodeId], cy = this.V.posY[nodeId];
    const hw = this.V.sizeW[nodeId] * 0.5, hh = this.V.sizeH[nodeId] * 0.5;
    const total = side === 0 ? this.V.nIn[nodeId] : this.V.nOut[nodeId];
    const t = (idx + 1) / (total + 1);
    const py = cy - hh + this.V.sizeH[nodeId] * t;
    return { x: side === 0 ? cx - hw : cx + hw, y: py };
  }

  _orthoPath(p1, p2) {
    const minOff = 30, dx = p2.x - p1.x;
    if (dx > 2 * minOff) {
      const midX = (p1.x + p2.x) / 2;
      return [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
    }
    const midY = (p1.y + p2.y) / 2;
    return [p1, { x: p1.x + minOff, y: p1.y }, { x: p1.x + minOff, y: midY },
            { x: p2.x - minOff, y: midY }, { x: p2.x - minOff, y: p2.y }, p2];
  }

  _drawEdge(ap, bp, colA, colB, selected, preview, label) {
    const as = this._w2s(ap.x, ap.y), bs = this._w2s(bp.x, bp.y);
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(as.x, as.y, bs.x, bs.y);
    grad.addColorStop(0, colA); grad.addColorStop(1, colB);
    const isActive = this._currentEdgeIdx !== undefined && this._activeEdges.has(this._currentEdgeIdx) &&
                     this._activeEdges.get(this._currentEdgeIdx) > performance.now();
    ctx.strokeStyle = selected ? '#f0b93a' : isActive ? '#5b8def' : (preview ? '#8b95a7' : grad);
    ctx.lineWidth = (selected ? 2.4 : isActive ? 3.0 : 1.6) * this.cam.zoom;
    if (isActive) { ctx.shadowColor = '#5b8def'; ctx.shadowBlur = 10 * this.cam.zoom; }
    ctx.lineJoin = 'round';
    let midPt;
    if (this.options.edgeStyle === 'orthogonal') {
      const path = this._orthoPath(as, bs);
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();
      midPt = path[Math.floor(path.length / 2)];
    } else {
      const dxe = bs.x - as.x, dye = bs.y - as.y;
      const off = Math.max(50, Math.abs(dxe) * 0.5 + Math.abs(dye) * 0.4);
      ctx.beginPath();
      ctx.moveTo(as.x, as.y);
      ctx.bezierCurveTo(as.x + off, as.y, bs.x - off, bs.y, bs.x, bs.y);
      ctx.stroke();
      midPt = bezPt(0.5, as.x, as.y, as.x + off, as.y, bs.x - off, bs.y, bs.x, bs.y);
    }
    // Flow particles (set per-edge via setEdgeAnimated or globally).
    if (!preview && this._currentEdgeIdx !== undefined && this.animatedEdges.has(this._currentEdgeIdx)) {
      const N = 4;
      for (let k = 0; k < N; k++) {
        const t = ((this._edgePhase / 1000) + k / N) % 1;
        let p;
        if (this.options.edgeStyle === 'orthogonal') {
          const dxe = bs.x - as.x, dye = bs.y - as.y;
          const off = Math.max(50, Math.abs(dxe) * 0.5 + Math.abs(dye) * 0.4);
          p = bezPt(t, as.x, as.y, as.x + off, as.y, bs.x - off, bs.y, bs.x, bs.y);
        } else {
          const dxe = bs.x - as.x, dye = bs.y - as.y;
          const off = Math.max(50, Math.abs(dxe) * 0.5 + Math.abs(dye) * 0.4);
          p = bezPt(t, as.x, as.y, as.x + off, as.y, bs.x - off, bs.y, bs.x, bs.y);
        }
        ctx.fillStyle = colB;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.2 * this.cam.zoom, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Edge label badge.
    if (!preview && label && this.cam.zoom > 0.45) {
      ctx.font = `600 ${10.5 * this.cam.zoom}px ui-monospace, Consolas, monospace`;
      const tw = ctx.measureText(label).width;
      const pad = 5 * this.cam.zoom;
      const bw = tw + pad * 2;
      const bh = 16 * this.cam.zoom;
      ctx.fillStyle = '#0b0f17';
      this._roundRect(midPt.x - bw / 2, midPt.y - bh / 2, bw, bh, 5 * this.cam.zoom);
      ctx.fill();
      ctx.strokeStyle = selected ? '#f0b93a' : alphaize(colA, 0.6);
      ctx.lineWidth = 1 * this.cam.zoom;
      ctx.stroke();
      ctx.fillStyle = '#e6edf3';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, midPt.x, midPt.y);
    }
  }

  /** Slim overlay: only paints what WebGL didn't, with LOD gating. */
  _drawNodeOverlay(i) {
    const z = this.cam.zoom;
    // LOD: below 0.3 zoom (or with >5k nodes far out) skip text + ports entirely.
    if (z < 0.25) return;
    if (this.w.nodeCount_() > 5000 && z < 0.55) return;
    const cx = this.V.posX[i], cy = this.V.posY[i];
    const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
    const tl = this._w2s(cx - hw, cy - hh);
    const sw = this.V.sizeW[i] * z;
    const sh = this.V.sizeH[i] * z;
    const cat = this.kinds[this.V.kind[i]];
    const color = this.colors.get(i) || cat.color;
    const ctx = this.ctx;
    if (z > 0.4) {
      const title = this.titles.get(i) || cat.name;
      ctx.font = `600 ${12 * z}px Inter, ui-sans-serif`;
      ctx.fillStyle = '#0b0f17';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(title, tl.x + sw / 2, tl.y + 11 * z);
    }
    // Ports only when zoom is decent.
    if (z > 0.35) {
      for (let s = 0; s < 2; s++) {
        const count = s === 0 ? this.V.nIn[i] : this.V.nOut[i];
        for (let p = 0; p < count; p++) {
          const wp = this._portWorld(i, s, p);
          const sp = this._w2s(wp.x, wp.y);
          ctx.fillStyle = color;
          ctx.strokeStyle = '#07090f';
          ctx.lineWidth = 1.5 * z;
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 4.5 * z, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        }
      }
    }
    if (this.breakpoints.has(i)) {
      ctx.fillStyle = '#e8462b';
      ctx.beginPath(); ctx.arc(tl.x - 4 * z, tl.y + sh / 2, 4.5 * z, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawNode(i) {
    const cx = this.V.posX[i], cy = this.V.posY[i];
    const hw = this.V.sizeW[i] * 0.5, hh = this.V.sizeH[i] * 0.5;
    const tl = this._w2s(cx - hw, cy - hh);
    const sw = this.V.sizeW[i] * this.cam.zoom;
    const sh = this.V.sizeH[i] * this.cam.zoom;
    const cat = this.kinds[this.V.kind[i]];
    const color = this.colors.get(i) || cat.color;
    const sel = this.V.selected[i] !== 0;
    const hov = this._hoveredNode === i && this._mode === 'idle';
    const ctx = this.ctx;

    // Body shadow + fill.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = (hov ? 14 : 10) * this.cam.zoom;
    ctx.shadowOffsetY = 4 * this.cam.zoom;
    ctx.fillStyle = '#161b27';
    this._shapePath(cat.shape, tl.x, tl.y, sw, sh);
    ctx.fill();
    ctx.restore();

    // Header strip (rect kinds only).
    if (cat.shape === 'rect') {
      ctx.save();
      this._shapePath(cat.shape, tl.x, tl.y, sw, sh);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(tl.x, tl.y, sw, 22 * this.cam.zoom);
      ctx.restore();
    }

    // Running pulse — strong blue glow while exec is in flight.
    if (this.status.get(i) === 'running') {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      ctx.save();
      ctx.shadowColor = '#5b8def';
      ctx.shadowBlur = (18 + 14 * pulse) * this.cam.zoom;
      ctx.strokeStyle = `rgba(91,141,239,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = (2.2 + pulse) * this.cam.zoom;
      this._shapePath(cat.shape, tl.x - 2, tl.y - 2, sw + 4, sh + 4);
      ctx.stroke();
      ctx.restore();
    }

    // Border / selection.
    if (sel) {
      ctx.save();
      ctx.shadowColor = 'rgba(240,185,58,0.55)';
      ctx.shadowBlur = 14 * this.cam.zoom;
      ctx.strokeStyle = '#f0b93a'; ctx.lineWidth = 1.6 * this.cam.zoom;
      this._shapePath(cat.shape, tl.x, tl.y, sw, sh); ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = hov ? alphaize(color, 0.55) : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = (hov ? 1.3 : 1) * this.cam.zoom;
      this._shapePath(cat.shape, tl.x, tl.y, sw, sh); ctx.stroke();
    }

    // Title.
    if (this.cam.zoom > 0.42) {
      const title = this.titles.get(i) || `${cat.name} #${i}`;
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${11 * this.cam.zoom}px Inter, ui-sans-serif`;
      if (cat.shape === 'rect') {
        ctx.fillStyle = '#0b0f17'; ctx.textAlign = 'left';
        ctx.fillText(title, tl.x + 10 * this.cam.zoom, tl.y + 11 * this.cam.zoom);
      } else {
        ctx.fillStyle = color; ctx.textAlign = 'center';
        ctx.fillText(title, tl.x + sw / 2, tl.y + sh / 2);
      }
    }


    // Progress bar (bottom).
    const prog = this.progress.get(i);
    if (prog !== undefined && prog > 0) {
      const barH = 3 * this.cam.zoom;
      const barY = tl.y + sh - barH - 2 * this.cam.zoom;
      const barX = tl.x + 8 * this.cam.zoom;
      const barW = sw - 16 * this.cam.zoom;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = color;
      ctx.fillRect(barX, barY, barW * Math.min(1, Math.max(0, prog)), barH);
    }

    // Tags.
    const tags = this.tags.get(i);
    if (tags && tags.length && this.cam.zoom > 0.5) {
      let tx = tl.x + 8 * this.cam.zoom;
      const ty = tl.y + sh - 24 * this.cam.zoom;
      ctx.font = `500 ${9 * this.cam.zoom}px Inter, ui-sans-serif`;
      ctx.textBaseline = 'middle';
      for (const tag of tags) {
        const wText = ctx.measureText(tag).width;
        const w0 = wText + 10 * this.cam.zoom;
        if (tx + w0 > tl.x + sw - 8 * this.cam.zoom) break;
        ctx.fillStyle = alphaize(color, 0.18);
        this._roundRect(tx, ty, w0, 14 * this.cam.zoom, 3 * this.cam.zoom);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(tag, tx + 5 * this.cam.zoom, ty + 7 * this.cam.zoom);
        tx += w0 + 4 * this.cam.zoom;
      }
    }

    // Sparkline (live metric).
    const m = this.metrics.get(i);
    if (m && m.count > 1 && cat.shape === 'rect' && this.cam.zoom > 0.45) {
      const max = this.metricMax.get(i) || 1;
      const px = tl.x + 8 * this.cam.zoom, py = tl.y + sh - 22 * this.cam.zoom;
      const pw = sw - 16 * this.cam.zoom, ph = 16 * this.cam.zoom;
      ctx.strokeStyle = alphaize(color, 0.85);
      ctx.lineWidth = 1.5 * this.cam.zoom;
      ctx.beginPath();
      for (let k = 0; k < m.count; k++) {
        const v = m.data[(m.idx + this._metricCap - m.count + k) % this._metricCap];
        const xx = px + (k / Math.max(1, m.count - 1)) * pw;
        const yy = py + ph - (Math.min(Math.max(v / max, 0), 1)) * ph;
        if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    // Breakpoint indicator (red filled circle on left edge).
    if (this.breakpoints.has(i)) {
      const bx = tl.x - 4 * this.cam.zoom, by = tl.y + sh / 2;
      ctx.save();
      ctx.shadowColor = '#e8462b'; ctx.shadowBlur = 8 * this.cam.zoom;
      ctx.fillStyle = '#e8462b';
      ctx.beginPath(); ctx.arc(bx, by, 4.5 * this.cam.zoom, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Status dot (top-right of header).
    const st = this.status.get(i);
    if (st && cat.shape === 'rect') {
      const sCol = STATUS_COLORS[st] || '#8b95a7';
      const dotX = tl.x + sw - 12 * this.cam.zoom;
      const dotY = tl.y + 11 * this.cam.zoom;
      ctx.save();
      ctx.shadowColor = sCol; ctx.shadowBlur = 6 * this.cam.zoom;
      ctx.fillStyle = sCol;
      ctx.beginPath(); ctx.arc(dotX, dotY, 3.5 * this.cam.zoom, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Locked indicator (small lock glyph top-left).
    if (this.locked.has(i)) {
      const lx = tl.x + 6 * this.cam.zoom, ly = tl.y + 6 * this.cam.zoom;
      const lz = 10 * this.cam.zoom;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this._roundRect(lx, ly, lz, lz, 2 * this.cam.zoom); ctx.fill();
      ctx.strokeStyle = '#f0b93a'; ctx.lineWidth = 1.2 * this.cam.zoom;
      ctx.strokeRect(lx + 2.5 * this.cam.zoom, ly + 5 * this.cam.zoom, lz - 5 * this.cam.zoom, lz - 6 * this.cam.zoom);
      ctx.beginPath();
      ctx.arc(lx + lz * 0.5, ly + 5 * this.cam.zoom, 2 * this.cam.zoom, Math.PI, 0);
      ctx.stroke();
    }

    // Image thumbnail (top of body).
    const imgUrl = this.image.get(i);
    if (imgUrl && cat.shape === 'rect' && this.cam.zoom > 0.5) {
      const img = this._getImage(imgUrl);
      if (img && img.ready) {
        const ix = tl.x + 8 * this.cam.zoom;
        const iy = tl.y + 28 * this.cam.zoom;
        const iw = sw - 16 * this.cam.zoom;
        const ih = Math.min(54 * this.cam.zoom, sh * 0.45);
        ctx.save();
        this._roundRect(ix, iy, iw, ih, 4 * this.cam.zoom);
        ctx.clip();
        ctx.drawImage(img.img, ix, iy, iw, ih);
        ctx.restore();
      }
    }

    // Inline markdown description (one line, runs).
    const desc = this.descriptions.get(i);
    if (desc && cat.shape === 'rect' && this.cam.zoom > 0.5 && !imgUrl) {
      const runs = this.options.inlineMarkdown !== false ? parseInlineMd(desc) : [{ t: desc, style: 'p' }];
      let dx = tl.x + 8 * this.cam.zoom;
      const dyy = tl.y + 44 * this.cam.zoom;
      ctx.font = `400 ${10 * this.cam.zoom}px Inter, ui-sans-serif`;
      ctx.textBaseline = 'top';
      const maxX = tl.x + sw - 8 * this.cam.zoom;
      for (const run of runs) {
        let f = `${10 * this.cam.zoom}px `;
        if (run.style === 'b')  f = `700 ${10 * this.cam.zoom}px Inter, ui-sans-serif`;
        else if (run.style === 'i')  f = `italic 400 ${10 * this.cam.zoom}px Inter, ui-sans-serif`;
        else if (run.style === 'c')  f = `${10 * this.cam.zoom}px ui-monospace, Consolas, monospace`;
        else if (run.style === 'a')  f = `400 ${10 * this.cam.zoom}px Inter, ui-sans-serif`;
        else                          f = `400 ${10 * this.cam.zoom}px Inter, ui-sans-serif`;
        ctx.font = f;
        ctx.fillStyle = run.style === 'a' ? '#5be0d0' : run.style === 'c' ? '#f0b93a' : '#c8d1de';
        const tw = ctx.measureText(run.t).width;
        if (dx + tw > maxX) break;
        ctx.fillText(run.t, dx, dyy);
        dx += tw;
      }
    }

    // Search hit glow.
    if (this._searchHits && this._searchHits.includes(i)) {
      ctx.save();
      ctx.shadowColor = '#5be0d0';
      ctx.shadowBlur = 18 * this.cam.zoom;
      ctx.strokeStyle = '#5be0d0';
      ctx.lineWidth = 1.6 * this.cam.zoom;
      this._shapePath(cat.shape, tl.x - 3, tl.y - 3, sw + 6, sh + 6);
      ctx.stroke();
      ctx.restore();
    }

    // Ports.
    for (let s = 0; s < 2; s++) {
      const count = s === 0 ? this.V.nIn[i] : this.V.nOut[i];
      for (let p = 0; p < count; p++) {
        const wp = this._portWorld(i, s, p);
        const sp = this._w2s(wp.x, wp.y);
        ctx.fillStyle = color;
        ctx.strokeStyle = '#07090f';
        ctx.lineWidth = 1.5 * this.cam.zoom;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 4.5 * this.cam.zoom, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
  }

  _shapePath(shape, x, y, w, h) {
    const ctx = this.ctx;
    if (shape === 'diamond') {
      const cx = x + w / 2, cy = y + h / 2;
      ctx.beginPath();
      ctx.moveTo(cx, y); ctx.lineTo(x + w, cy);
      ctx.lineTo(cx, y + h); ctx.lineTo(x, cy);
      ctx.closePath(); return;
    }
    if (shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    }
    if (shape === 'hexagon') {
      const cx = x + w / 2, cy = y + h / 2;
      const hw = w / 2, hh = h / 2, a = hw * 0.45;
      ctx.beginPath();
      ctx.moveTo(cx - hw + a, y); ctx.lineTo(cx + hw - a, y);
      ctx.lineTo(x + w, cy);      ctx.lineTo(cx + hw - a, y + h);
      ctx.lineTo(cx - hw + a, y + h); ctx.lineTo(x, cy);
      ctx.closePath(); return;
    }
    this._roundRect(x, y, w, h, 8);
  }
  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

// ── Free helpers ──────────────────────────────────────────────────────────
function bezPt(t, x1, y1, cx1, cy1, cx2, cy2, x2, y2) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  const a = mt2 * mt, b = 3 * mt2 * t, c = 3 * mt * t2, d = t2 * t;
  return { x: a*x1 + b*cx1 + c*cx2 + d*x2, y: a*y1 + b*cy1 + c*cy2 + d*y2 };
}
function distSeg2(qx, qy, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) { const ddx = qx - x1, ddy = qy - y1; return ddx*ddx + ddy*ddy; }
  let t = ((qx - x1) * dx + (qy - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx, py = y1 + t * dy;
  const ddx = qx - px, ddy = qy - py;
  return ddx*ddx + ddy*ddy;
}
function alphaize(hex, a) {
  if (hex.startsWith('rgb')) return hex.replace(')', `, ${a})`).replace('rgb(', 'rgba(');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const STATUS_COLORS = {
  ok: '#5bd17a', live: '#5bd17a', running: '#5b8def', idle: '#8b95a7',
  warn: '#f0b93a', error: '#e8462b', failed: '#e8462b', stopped: '#8b95a7',
};

function parseInlineMd(s) {
  if (!s) return [{ t: '', style: 'p' }];
  const runs = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) runs.push({ t: s.slice(last, m.index), style: 'p' });
    const tok = m[1];
    if (tok.startsWith('**')) runs.push({ t: tok.slice(2, -2), style: 'b' });
    else if (tok.startsWith('`')) runs.push({ t: tok.slice(1, -1), style: 'c' });
    else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      runs.push({ t: tok.slice(1, close), style: 'a', href: tok.slice(close + 2, -1) });
    }
    else runs.push({ t: tok.slice(1, -1), style: 'i' });
    last = m.index + tok.length;
  }
  if (last < s.length) runs.push({ t: s.slice(last), style: 'p' });
  return runs;
}

function pinchInfo(pointers) {
  const [a, b] = [...pointers.values()];
  const dx = b.x - a.x, dy = b.y - a.y;
  return { dist: Math.hypot(dx, dy) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function isCompatibleType(out, inn) {
  if (!out || !inn) return true;
  if (out === inn) return true;
  if (out === 'any' || inn === 'any') return true;
  if (inn === 'string') return true; // anything stringifies
  const numerics = new Set(['number', 'int', 'float', 'integer']);
  if (numerics.has(out) && numerics.has(inn)) return true;
  return false;
}

function fnvHash(v) {
  // Fast structural hash for primitives / shallow objects / arrays. Avoids JSON.
  let h = 0x811c9dc5;
  const visit = (x) => {
    if (x === null || x === undefined) { h = (h ^ 0xff) * 0x01000193 >>> 0; return; }
    const t = typeof x;
    if (t === 'number') { h = (h ^ ((x * 1e6) | 0)) * 0x01000193 >>> 0; return; }
    if (t === 'string') { for (let i = 0; i < x.length; i++) h = (h ^ x.charCodeAt(i)) * 0x01000193 >>> 0; return; }
    if (t === 'boolean') { h = (h ^ (x ? 1 : 0)) * 0x01000193 >>> 0; return; }
    if (Array.isArray(x)) { for (const e of x) visit(e); return; }
    if (t === 'object') { for (const k of Object.keys(x).sort()) { for (let i = 0; i < k.length; i++) h = (h ^ k.charCodeAt(i)) * 0x01000193 >>> 0; visit(x[k]); } return; }
  };
  visit(v);
  return h >>> 0;
}

function bubbleSummary(v) {
  if (typeof v === 'number') return formatRuntimeValue(v);
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${k}: ${formatRuntimeValue(x)}`).join('  ');
  }
  return formatRuntimeValue(v);
}

function formatRuntimeValue(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.length > 22 ? v.slice(0, 22) + '…' : v;
  try { const s = JSON.stringify(v); return s.length > 30 ? s.slice(0, 30) + '…' : s; }
  catch { return '[obj]'; }
}

function parseHex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeXml(s) { return escapeHtml(s); }
// Rough word-wrap for SVG export. avgCharPx is a coarse estimate (~7 px per
// char at 12px font) since SVG export has no live metrics to measure against.
function wrapTextForSvg(text, maxWidth, avgCharPx = 7) {
  const lines = [];
  const maxChars = Math.max(4, Math.floor(maxWidth / avgCharPx));
  for (const para of String(text).split('\n')) {
    if (para.length <= maxChars) { lines.push(para); continue; }
    let cur = '';
    for (const word of para.split(/\s+/)) {
      const test = cur ? cur + ' ' + word : word;
      if (test.length > maxChars && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

// ── Mermaid + DOT importers ───────────────────────────────────────────────
export function parseMermaid(text) {
  const nodes = new Map(), edges = [];
  const lines = text.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  let i0 = 0;
  if (lines[0] && /^(graph|flowchart)\b/i.test(lines[0])) i0 = 1;
  const NODE_RE = /([A-Za-z_][A-Za-z0-9_]*)(?:(\[\[)([^\]]+)\]\]|\[([^\]]+)\]|\(\(([^)]+)\)\)|\(([^)]+)\)|\{([^}]+)\})?/;
  function consume(s, pos) {
    const sub = s.slice(pos);
    const m = sub.match(NODE_RE);
    if (!m || m.index !== 0) return null;
    const id = m[1];
    let shape = 'default', label = id;
    if (m[2]) { shape = 'subroutine'; label = m[3]; }
    else if (m[4]) { shape = 'rect';   label = m[4]; }
    else if (m[5]) { shape = 'circle'; label = m[5]; }
    else if (m[6]) { shape = 'round';  label = m[6]; }
    else if (m[7]) { shape = 'rhombus';label = m[7]; }
    if (!nodes.has(id) || nodes.get(id).shape === 'default') nodes.set(id, { label, shape });
    return { id, end: pos + m[0].length };
  }
  for (let li = i0; li < lines.length; li++) {
    const ln = lines[li];
    const a = consume(ln, 0); if (!a) continue;
    let rest = ln.slice(a.end).trim();
    const arrow = rest.match(/^([-=.~]+>?|---|===)\s*(?:\|([^|]+)\|\s*)?/);
    if (!arrow) continue;
    rest = rest.slice(arrow[0].length).trim();
    const offset = ln.length - rest.length;
    const b = consume(ln, offset); if (!b) continue;
    edges.push({ from: a.id, to: b.id, label: arrow[2] || null });
  }
  return { nodes, edges };
}
export function parseDot(text) {
  const nodes = new Map(), edges = [];
  text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*#.*$/gm, '').replace(/\/\/.*$/gm, '');
  text = text.replace(/^\s*(?:strict\s+)?(?:di)?graph\s+\w*\s*\{/i, '').replace(/\}\s*$/, '');
  const stmts = []; let buf = '', depth = 0;
  for (const ch of text) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if ((ch === ';' || ch === '\n') && depth === 0) {
      if (buf.trim()) stmts.push(buf.trim());
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) stmts.push(buf.trim());
  const ID_RE = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)/;
  function takeId(s, p) {
    const m = s.slice(p).match(ID_RE);
    if (!m || m.index !== 0) return null;
    return { id: m[1] || m[2], end: p + m[0].length };
  }
  function takeAttrs(s, p) {
    const sub = s.slice(p).match(/^\s*\[([^\]]*)\]/);
    if (!sub) return null;
    const lm = sub[1].match(/label\s*=\s*"([^"]*)"|label\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/);
    return { label: lm ? (lm[1] || lm[2]) : null, end: p + sub[0].length };
  }
  for (const stmt of stmts) {
    let p = 0;
    const a = takeId(stmt, p); if (!a) continue;
    p = a.end;
    while (stmt[p] === ' ' || stmt[p] === '\t') p++;
    const arrow = stmt.slice(p).match(/^(->|--)\s*/);
    if (arrow) {
      p += arrow[0].length;
      const b = takeId(stmt, p); if (!b) continue;
      p = b.end;
      const attrs = takeAttrs(stmt, p);
      if (!nodes.has(a.id)) nodes.set(a.id, { label: a.id });
      if (!nodes.has(b.id)) nodes.set(b.id, { label: b.id });
      edges.push({ from: a.id, to: b.id, label: attrs ? attrs.label : null });
    } else {
      const attrs = takeAttrs(stmt, p);
      const label = attrs && attrs.label ? attrs.label : a.id;
      if (!nodes.has(a.id) || nodes.get(a.id).label === a.id) nodes.set(a.id, { label });
    }
  }
  return { nodes, edges };
}
