//! zflow node-edge engine, v2.
//!
//! What v2 adds over v1:
//!   • Per-port edges: an edge knows its source port index and destination
//!     port index, not just the two node ids. Lets a node have many edges in
//!     and out without them all stacking on the same point.
//!   • Selection bitset + group ops (selectInRect, moveSelectedBy, deleteSelected,
//!     duplicateSelected) so the renderer drives marquee + multi-drag with one
//!     WASM call per frame, not N.
//!   • Undo/redo via full-state snapshots. Snapshot is ~60 KB, stack is 64 deep,
//!     ~4 MB total — trivial in wasm32. We trade memory for simplicity: no
//!     diff tracking, just a copy.
//!   • Compaction-style deletion: removing nodes rewrites the SoA in place and
//!     remaps edge endpoints so the JS-side views remain valid (no fragmenting).
//!
//! Memory contract still holds: init pre-allocates everything, then we never
//! grow. JS Float32Array views over memory.buffer remain attached for life.

const std = @import("std");

const alloc = std.heap.wasm_allocator;

const NODE_CAP: u32 = 100_000;
const EDGE_CAP: u32 = 200_000;
const UNDO_CAP: u32 = 8;       // smaller undo history so snapshot RAM stays sane at 100k nodes

// ── Node SoA ────────────────────────────────────────────────────────────────
var pos_x: []f32 = &.{};
var pos_y: []f32 = &.{};
var size_w: []f32 = &.{};
var size_h: []f32 = &.{};
var kind: []u8 = &.{};
var n_in: []u8 = &.{};
var n_out: []u8 = &.{};
var selected: []u8 = &.{};
var node_count: u32 = 0;

// ── Edge SoA (per-port) ─────────────────────────────────────────────────────
var edge_from_node: []u32 = &.{};
var edge_to_node: []u32 = &.{};
var edge_from_port: []u8 = &.{};
var edge_to_port: []u8 = &.{};
var edge_selected: []u8 = &.{};
var edge_count: u32 = 0;

// ── Undo/redo via full-state snapshots ──────────────────────────────────────
// The cursor model: snapshots[0..cursor] are "past" states, snapshots[cursor]
// is the LATEST committed state (== current), and snapshots[cursor+1..top]
// are redo candidates. Calling snapshot() truncates redo and appends.
const Snapshot = struct {
    node_count: u32 = 0,
    edge_count: u32 = 0,
    pos_x: [NODE_CAP]f32 = [_]f32{0} ** NODE_CAP,
    pos_y: [NODE_CAP]f32 = [_]f32{0} ** NODE_CAP,
    size_w: [NODE_CAP]f32 = [_]f32{0} ** NODE_CAP,
    size_h: [NODE_CAP]f32 = [_]f32{0} ** NODE_CAP,
    kind: [NODE_CAP]u8 = [_]u8{0} ** NODE_CAP,
    n_in: [NODE_CAP]u8 = [_]u8{0} ** NODE_CAP,
    n_out: [NODE_CAP]u8 = [_]u8{0} ** NODE_CAP,
    selected: [NODE_CAP]u8 = [_]u8{0} ** NODE_CAP,
    edge_from_node: [EDGE_CAP]u32 = [_]u32{0} ** EDGE_CAP,
    edge_to_node: [EDGE_CAP]u32 = [_]u32{0} ** EDGE_CAP,
    edge_from_port: [EDGE_CAP]u8 = [_]u8{0} ** EDGE_CAP,
    edge_to_port: [EDGE_CAP]u8 = [_]u8{0} ** EDGE_CAP,
    edge_selected: [EDGE_CAP]u8 = [_]u8{0} ** EDGE_CAP,
};

var undo_stack: []Snapshot = &.{};
var undo_top: u32 = 0;     // exclusive end
var undo_cursor: u32 = 0;  // index of the latest committed state (current)

// Scratch buffers for deletion-compaction, allocated once to avoid blowing
// the wasm shadow stack on big delete calls.
var tmp_removed: []u8 = &.{};
var tmp_remap: []i32 = &.{};

// Spatial grid — uniform 256-unit cells covering ±8192 world units (64×64).
// Each cell holds up to GRID_BUCKET node ids whose AABB overlaps it. Marked
// dirty on every mutation; rebuilt lazily before any spatial query.
const GRID_DIM: u32 = 64;
const GRID_CELL: f32 = 256.0;
const GRID_BUCKET: u32 = 64;
const GRID_HALF: f32 = (@as(f32, @floatFromInt(GRID_DIM)) * GRID_CELL) * 0.5;
const GRID_TOTAL_CELLS: u32 = GRID_DIM * GRID_DIM;

var grid_cells: []u32 = &.{};   // GRID_TOTAL_CELLS * GRID_BUCKET = 64K u32 = 256KB
var grid_count: []u32 = &.{};   // count per cell
var grid_dirty: bool = true;
var query_results: []u32 = &.{};
var query_seen: []u8 = &.{};
var query_count: u32 = 0;

fn invalidateGrid() void { grid_dirty = true; }

fn worldToGrid(wx: f32, wy: f32, cx: *u32, cy: *u32) void {
    const gx_f = @floor((wx + GRID_HALF) / GRID_CELL);
    const gy_f = @floor((wy + GRID_HALF) / GRID_CELL);
    var gx: i32 = @intFromFloat(gx_f);
    var gy: i32 = @intFromFloat(gy_f);
    if (gx < 0) gx = 0;
    if (gy < 0) gy = 0;
    if (gx >= GRID_DIM) gx = GRID_DIM - 1;
    if (gy >= GRID_DIM) gy = GRID_DIM - 1;
    cx.* = @intCast(gx);
    cy.* = @intCast(gy);
}

fn rebuildGrid() void {
    @memset(grid_count[0..GRID_TOTAL_CELLS], 0);
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        const hw = size_w[i] * 0.5;
        const hh = size_h[i] * 0.5;
        var cx0: u32 = 0;
        var cy0: u32 = 0;
        var cx1: u32 = 0;
        var cy1: u32 = 0;
        worldToGrid(pos_x[i] - hw, pos_y[i] - hh, &cx0, &cy0);
        worldToGrid(pos_x[i] + hw, pos_y[i] + hh, &cx1, &cy1);
        var cy = cy0;
        while (cy <= cy1) : (cy += 1) {
            var cx = cx0;
            while (cx <= cx1) : (cx += 1) {
                const idx = cy * GRID_DIM + cx;
                if (grid_count[idx] < GRID_BUCKET) {
                    grid_cells[idx * GRID_BUCKET + grid_count[idx]] = i;
                    grid_count[idx] += 1;
                }
            }
        }
    }
    grid_dirty = false;
}

// Scratch buffers for auto-layout (Sugiyama). Sized at NODE_CAP so the
// algorithm never allocates on the hot path. ~24 KB total.
var layout_layer: []u32 = &.{};       // node id → layer index
var layout_indeg: []u32 = &.{};       // in-degree counter during topo sort
var layout_queue: []u32 = &.{};       // BFS frontier
var layout_layer_count: []u32 = &.{}; // # nodes per layer
var layout_layer_offset: []u32 = &.{};
var layout_layer_nodes: []u32 = &.{}; // flattened: nodes for layer L start at offset[L]
var layout_bary: []f32 = &.{};

// ── Lifecycle ───────────────────────────────────────────────────────────────

pub export fn init() u32 {
    pos_x = alloc.alloc(f32, NODE_CAP) catch return 0;
    pos_y = alloc.alloc(f32, NODE_CAP) catch return 0;
    size_w = alloc.alloc(f32, NODE_CAP) catch return 0;
    size_h = alloc.alloc(f32, NODE_CAP) catch return 0;
    kind = alloc.alloc(u8, NODE_CAP) catch return 0;
    n_in = alloc.alloc(u8, NODE_CAP) catch return 0;
    n_out = alloc.alloc(u8, NODE_CAP) catch return 0;
    selected = alloc.alloc(u8, NODE_CAP) catch return 0;
    @memset(selected, 0);

    edge_from_node = alloc.alloc(u32, EDGE_CAP) catch return 0;
    edge_to_node = alloc.alloc(u32, EDGE_CAP) catch return 0;
    edge_from_port = alloc.alloc(u8, EDGE_CAP) catch return 0;
    edge_to_port = alloc.alloc(u8, EDGE_CAP) catch return 0;
    edge_selected = alloc.alloc(u8, EDGE_CAP) catch return 0;
    @memset(edge_selected, 0);

    tmp_removed = alloc.alloc(u8, NODE_CAP) catch return 0;
    tmp_remap = alloc.alloc(i32, NODE_CAP) catch return 0;

    grid_cells  = alloc.alloc(u32, GRID_TOTAL_CELLS * GRID_BUCKET) catch return 0;
    grid_count  = alloc.alloc(u32, GRID_TOTAL_CELLS) catch return 0;
    query_results = alloc.alloc(u32, NODE_CAP) catch return 0;
    query_seen    = alloc.alloc(u8, NODE_CAP) catch return 0;
    @memset(grid_count, 0);

    layout_layer        = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_indeg        = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_queue        = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_layer_count  = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_layer_offset = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_layer_nodes  = alloc.alloc(u32, NODE_CAP) catch return 0;
    layout_bary         = alloc.alloc(f32, NODE_CAP) catch return 0;

    // Pre-allocate force-directed + live-compute buffers RIGHT NOW so the
    // wasm_allocator never has to grow memory after init returns. If we
    // allocated these lazily, the first call to force-layout or live-tick
    // would detach every Float32Array view JS holds on memory.buffer —
    // exactly the silent-data-corruption bug v3's docs warned about.
    force_vx    = alloc.alloc(f32, NODE_CAP) catch return 0;
    force_vy    = alloc.alloc(f32, NODE_CAP) catch return 0;
    force_fx    = alloc.alloc(f32, NODE_CAP) catch return 0;
    force_fy    = alloc.alloc(f32, NODE_CAP) catch return 0;
    @memset(force_vx, 0);
    @memset(force_vy, 0);
    force_initialized = true;

    node_value  = alloc.alloc(f32, NODE_CAP) catch return 0;
    edge_value  = alloc.alloc(f32, EDGE_CAP) catch return 0;
    @memset(node_value, 0);
    @memset(edge_value, 0);
    compute_initialized = true;

    undo_stack = alloc.alloc(Snapshot, UNDO_CAP) catch return 0;
    // Note: Snapshot has @sizeOf > 60KB. We initialize lazily on push.

    // No seed: the library starts empty. Consumers populate via addNode/addEdge.
    pushSnapshot();
    return 1;
}

// ── Mutation API ────────────────────────────────────────────────────────────

pub export fn addNode(x: f32, y: f32, w: f32, h: f32, k: u32, ni: u32, no: u32) i32 {
    if (node_count >= NODE_CAP) return -1;
    const id = node_count;
    pos_x[id] = x;
    pos_y[id] = y;
    size_w[id] = w;
    size_h[id] = h;
    kind[id] = @intCast(k);
    n_in[id] = @intCast(ni);
    n_out[id] = @intCast(no);
    selected[id] = 0;
    node_count += 1;
    invalidateGrid();
    return @intCast(id);
}

pub export fn addEdge(from: u32, from_port: u32, to: u32, to_port: u32) i32 {
    if (edge_count >= EDGE_CAP) return -1;
    if (from >= node_count or to >= node_count) return -2;
    // Reject duplicate (same src port, same dst port) — keeps the graph clean.
    var i: u32 = 0;
    while (i < edge_count) : (i += 1) {
        if (edge_from_node[i] == from and edge_to_node[i] == to and
            edge_from_port[i] == from_port and edge_to_port[i] == to_port)
            return -3;
    }
    edge_from_node[edge_count] = from;
    edge_to_node[edge_count] = to;
    edge_from_port[edge_count] = @intCast(from_port);
    edge_to_port[edge_count] = @intCast(to_port);
    edge_selected[edge_count] = 0;
    const id = edge_count;
    edge_count += 1;
    return @intCast(id);
}

pub export fn setEdgeSelected(id: u32, v: u32) void {
    if (id >= edge_count) return;
    edge_selected[id] = @intCast(v & 1);
}
pub export fn toggleEdgeSelected(id: u32) void {
    if (id >= edge_count) return;
    edge_selected[id] = if (edge_selected[id] != 0) 0 else 1;
}
pub export fn clearEdgeSelection() void {
    @memset(edge_selected[0..edge_count], 0);
}
pub export fn countSelectedEdges() u32 {
    var c: u32 = 0;
    var i: u32 = 0;
    while (i < edge_count) : (i += 1) { if (edge_selected[i] != 0) c += 1; }
    return c;
}

pub export fn moveNode(id: u32, x: f32, y: f32) void {
    if (id >= node_count) return;
    pos_x[id] = x;
    pos_y[id] = y;
    invalidateGrid();
}

pub export fn moveSelectedBy(dx: f32, dy: f32) void {
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        if (selected[i] != 0) {
            pos_x[i] += dx;
            pos_y[i] += dy;
        }
    }
    invalidateGrid();
}

pub export fn setSelected(id: u32, v: u32) void {
    if (id >= node_count) return;
    selected[id] = @intCast(v & 1);
}

pub export fn toggleSelected(id: u32) void {
    if (id >= node_count) return;
    selected[id] = if (selected[id] != 0) 0 else 1;
}

pub export fn clearSelection() void {
    @memset(selected[0..node_count], 0);
    @memset(edge_selected[0..edge_count], 0);
}

pub export fn selectAll() void {
    @memset(selected[0..node_count], 1);
}

/// Add every node whose AABB is fully contained in the rectangle to the
/// selection (additive — does not clear). `replace` clears first if non-zero.
pub export fn selectInRect(x0: f32, y0: f32, x1: f32, y1: f32, replace: u32) u32 {
    const minx = @min(x0, x1);
    const maxx = @max(x0, x1);
    const miny = @min(y0, y1);
    const maxy = @max(y0, y1);
    if (replace != 0) clearSelection();
    var hits: u32 = 0;
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        const hw = size_w[i] * 0.5;
        const hh = size_h[i] * 0.5;
        if (pos_x[i] - hw >= minx and pos_x[i] + hw <= maxx and
            pos_y[i] - hh >= miny and pos_y[i] + hh <= maxy)
        {
            selected[i] = 1;
            hits += 1;
        }
    }
    return hits;
}

pub export fn countSelected() u32 {
    var c: u32 = 0;
    var i: u32 = 0;
    while (i < node_count) : (i += 1) { if (selected[i] != 0) c += 1; }
    return c;
}

/// Delete every selected node and any edges touching one, AND every edge
/// individually marked as selected. Compacts SoA so the JS-side views see a
/// contiguous valid range [0..nodeCount). Returns total deleted = nodes+edges.
pub export fn deleteSelected() u32 {
    var removed_count: u32 = 0;
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        const is_sel = selected[i] != 0;
        tmp_removed[i] = if (is_sel) 1 else 0;
        if (is_sel) removed_count += 1;
    }
    if (removed_count == 0) return 0;

    // Compute remap old_id -> new_id (-1 if removed).
    var new_id: u32 = 0;
    i = 0;
    while (i < node_count) : (i += 1) {
        if (tmp_removed[i] != 0) {
            tmp_remap[i] = -1;
        } else {
            tmp_remap[i] = @intCast(new_id);
            new_id += 1;
        }
    }

    // In-place compaction.
    i = 0;
    while (i < node_count) : (i += 1) {
        if (tmp_remap[i] < 0) continue;
        const dst: u32 = @intCast(tmp_remap[i]);
        if (dst == i) continue;
        pos_x[dst] = pos_x[i];
        pos_y[dst] = pos_y[i];
        size_w[dst] = size_w[i];
        size_h[dst] = size_h[i];
        kind[dst] = kind[i];
        n_in[dst] = n_in[i];
        n_out[dst] = n_out[i];
        selected[dst] = selected[i];
    }
    node_count = new_id;
    @memset(selected[0..node_count], 0);
    invalidateGrid();

    // Filter edges: drop those touching a removed node OR individually selected;
    // remap remaining endpoints.
    var edges_dropped: u32 = 0;
    var new_ec: u32 = 0;
    var e: u32 = 0;
    while (e < edge_count) : (e += 1) {
        const a = edge_from_node[e];
        const b = edge_to_node[e];
        if (tmp_removed[a] != 0 or tmp_removed[b] != 0 or edge_selected[e] != 0) {
            edges_dropped += 1;
            continue;
        }
        edge_from_node[new_ec] = @intCast(tmp_remap[a]);
        edge_to_node[new_ec] = @intCast(tmp_remap[b]);
        edge_from_port[new_ec] = edge_from_port[e];
        edge_to_port[new_ec] = edge_to_port[e];
        edge_selected[new_ec] = 0;
        new_ec += 1;
    }
    edge_count = new_ec;
    return removed_count + edges_dropped;
}

/// Convenience: select all edges fully or remove just the edge-selection.
pub export fn deleteSelectedEdgesOnly() u32 {
    var dropped: u32 = 0;
    var new_ec: u32 = 0;
    var e: u32 = 0;
    while (e < edge_count) : (e += 1) {
        if (edge_selected[e] != 0) { dropped += 1; continue; }
        if (new_ec != e) {
            edge_from_node[new_ec] = edge_from_node[e];
            edge_to_node[new_ec] = edge_to_node[e];
            edge_from_port[new_ec] = edge_from_port[e];
            edge_to_port[new_ec] = edge_to_port[e];
            edge_selected[new_ec] = 0;
        }
        new_ec += 1;
    }
    edge_count = new_ec;
    return dropped;
}

/// Group alignment ops over the current node selection. axis: 0=x, 1=y;
/// mode: 0=min, 1=center, 2=max, 3=distribute.
pub export fn alignSelected(axis: u32, mode: u32) u32 {
    invalidateGrid();
    // Collect selected indices.
    var ids: [NODE_CAP]u32 = undefined;
    var k: u32 = 0;
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        if (selected[i] != 0) { ids[k] = i; k += 1; }
    }
    if (k < 2) return 0;
    // For distribute, sort selected by their current axis value.
    if (mode == 3) {
        // Bubble sort fine, k is tiny.
        var a: u32 = 0;
        while (a + 1 < k) : (a += 1) {
            var b: u32 = 0;
            while (b + 1 < k - a) : (b += 1) {
                const va = if (axis == 0) pos_x[ids[b]] else pos_y[ids[b]];
                const vb = if (axis == 0) pos_x[ids[b + 1]] else pos_y[ids[b + 1]];
                if (va > vb) {
                    const tmp = ids[b]; ids[b] = ids[b + 1]; ids[b + 1] = tmp;
                }
            }
        }
        const v0 = if (axis == 0) pos_x[ids[0]] else pos_y[ids[0]];
        const v1 = if (axis == 0) pos_x[ids[k - 1]] else pos_y[ids[k - 1]];
        const step = (v1 - v0) / @as(f32, @floatFromInt(k - 1));
        i = 1;
        while (i + 1 < k) : (i += 1) {
            const target = v0 + step * @as(f32, @floatFromInt(i));
            if (axis == 0) pos_x[ids[i]] = target else pos_y[ids[i]] = target;
        }
        return k;
    }
    // For min/center/max: find target value from bounding box of selection.
    var lo: f32 = if (axis == 0) pos_x[ids[0]] - size_w[ids[0]] * 0.5 else pos_y[ids[0]] - size_h[ids[0]] * 0.5;
    var hi: f32 = if (axis == 0) pos_x[ids[0]] + size_w[ids[0]] * 0.5 else pos_y[ids[0]] + size_h[ids[0]] * 0.5;
    var c: u32 = 1;
    while (c < k) : (c += 1) {
        const idc = ids[c];
        const half = if (axis == 0) size_w[idc] * 0.5 else size_h[idc] * 0.5;
        const center = if (axis == 0) pos_x[idc] else pos_y[idc];
        if (center - half < lo) lo = center - half;
        if (center + half > hi) hi = center + half;
    }
    const target = switch (mode) {
        0 => lo,            // min: align to left/top of bbox
        1 => (lo + hi) * 0.5, // center
        2 => hi,            // max: align to right/bottom
        else => lo,
    };
    c = 0;
    while (c < k) : (c += 1) {
        const idc = ids[c];
        const half = if (axis == 0) size_w[idc] * 0.5 else size_h[idc] * 0.5;
        const new_center = switch (mode) {
            0 => target + half,
            1 => target,
            2 => target - half,
            else => target,
        };
        if (axis == 0) pos_x[idc] = new_center else pos_y[idc] = new_center;
    }
    return k;
}

/// Copy every selected node, offset by (dx, dy). The originals are deselected
/// and the new ones become the selection so the user can immediately drag.
pub export fn duplicateSelected(dx: f32, dy: f32) u32 {
    // Snapshot ids of current selection (selection changes inside the loop).
    var added: u32 = 0;
    const old_count = node_count;
    var i: u32 = 0;
    while (i < old_count) : (i += 1) {
        if (selected[i] == 0) continue;
        const id = addNode(pos_x[i] + dx, pos_y[i] + dy, size_w[i], size_h[i], kind[i], n_in[i], n_out[i]);
        if (id < 0) break;
        selected[i] = 0; // deselect original
        selected[@intCast(id)] = 1;
        added += 1;
    }
    return added;
}

pub export fn deleteEdge(idx: u32) void {
    if (idx >= edge_count) return;
    const last = edge_count - 1;
    if (idx != last) {
        edge_from_node[idx] = edge_from_node[last];
        edge_to_node[idx] = edge_to_node[last];
        edge_from_port[idx] = edge_from_port[last];
        edge_to_port[idx] = edge_to_port[last];
    }
    edge_count -= 1;
}

// ── Auto-layout (Sugiyama-lite) ─────────────────────────────────────────────
//
// Layered DAG layout in three passes:
//   1) Layer assignment: longest-path from sources via Kahn's topo sort. A
//      node's layer is max(layer[predecessors]) + 1. Cycles get placed in
//      layer 0 (the algorithm is a "best effort" on non-DAGs).
//   2) Layer ordering: within each layer, sort nodes by the barycenter of
//      their predecessors' y-positions. One down-sweep is plenty for typical
//      graphs; doing more iterations refines crossings but rarely matters
//      visually below ~50 nodes per layer.
//   3) Coordinate assignment: x = layer * X_SPACING, y = position_in_layer *
//      Y_SPACING centered on the layer's midpoint. Spacing constants chosen
//      so 80x40 px nodes have ~80 px breathing room.
//
// Total work is O(N + E·L) where L is layer count. For 1000 nodes / 1500
// edges with ~30 layers this is sub-millisecond in wasm release builds.
pub export fn autoLayout() u32 {
    if (node_count == 0) return 0;
    invalidateGrid();
    const X_SPACING: f32 = 260.0;
    const Y_SPACING: f32 = 110.0;

    // 1. Init in-degree.
    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        layout_indeg[i] = 0;
        layout_layer[i] = 0;
    }
    var e: u32 = 0;
    while (e < edge_count) : (e += 1) {
        const to = edge_to_node[e];
        if (to < node_count) layout_indeg[to] += 1;
    }

    // 2. Topo sort, accumulating longest-path layer per node.
    var qhead: u32 = 0;
    var qtail: u32 = 0;
    i = 0;
    while (i < node_count) : (i += 1) {
        if (layout_indeg[i] == 0) {
            layout_queue[qtail] = i;
            qtail += 1;
        }
    }
    var max_layer: u32 = 0;
    while (qhead < qtail) {
        const u = layout_queue[qhead];
        qhead += 1;
        // Walk outgoing edges of u and relax layer[v].
        e = 0;
        while (e < edge_count) : (e += 1) {
            if (edge_from_node[e] != u) continue;
            const v = edge_to_node[e];
            if (v >= node_count) continue;
            const cand = layout_layer[u] + 1;
            if (cand > layout_layer[v]) {
                layout_layer[v] = cand;
                if (cand > max_layer) max_layer = cand;
            }
            layout_indeg[v] -= 1;
            if (layout_indeg[v] == 0) {
                layout_queue[qtail] = v;
                qtail += 1;
            }
        }
    }
    const num_layers = max_layer + 1;

    // 3. Bucket nodes per layer (count, exclusive prefix-sum offsets, fill).
    var l: u32 = 0;
    while (l < num_layers) : (l += 1) layout_layer_count[l] = 0;
    i = 0;
    while (i < node_count) : (i += 1) layout_layer_count[layout_layer[i]] += 1;
    var off: u32 = 0;
    l = 0;
    while (l < num_layers) : (l += 1) {
        layout_layer_offset[l] = off;
        off += layout_layer_count[l];
    }
    // Re-use layer_count as fill counter.
    l = 0;
    while (l < num_layers) : (l += 1) layout_layer_count[l] = 0;
    i = 0;
    while (i < node_count) : (i += 1) {
        const lay = layout_layer[i];
        layout_layer_nodes[layout_layer_offset[lay] + layout_layer_count[lay]] = i;
        layout_layer_count[lay] += 1;
    }

    // 4. Within each layer (except 0), sort by barycenter of predecessor y's.
    //    Use a single down-sweep — good enough visually for typical graphs.
    l = 1;
    while (l < num_layers) : (l += 1) {
        const lc = layout_layer_count[l];
        const start = layout_layer_offset[l];
        var idx: u32 = 0;
        while (idx < lc) : (idx += 1) {
            const n = layout_layer_nodes[start + idx];
            var sum: f32 = 0;
            var cnt: f32 = 0;
            e = 0;
            while (e < edge_count) : (e += 1) {
                if (edge_to_node[e] == n) {
                    sum += pos_y[edge_from_node[e]];
                    cnt += 1;
                }
            }
            layout_bary[idx] = if (cnt > 0) sum / cnt else 0;
        }
        // Bubble sort (lc is small per layer).
        var a: u32 = 0;
        while (a + 1 < lc) : (a += 1) {
            var b: u32 = 0;
            while (b + 1 < lc - a) : (b += 1) {
                if (layout_bary[b] > layout_bary[b + 1]) {
                    const t1 = layout_layer_nodes[start + b];
                    layout_layer_nodes[start + b] = layout_layer_nodes[start + b + 1];
                    layout_layer_nodes[start + b + 1] = t1;
                    const t2 = layout_bary[b];
                    layout_bary[b] = layout_bary[b + 1];
                    layout_bary[b + 1] = t2;
                }
            }
        }
        // Apply preliminary y for the next layer's barycenter computation.
        idx = 0;
        while (idx < lc) : (idx += 1) {
            const n = layout_layer_nodes[start + idx];
            pos_y[n] = (@as(f32, @floatFromInt(idx)) - @as(f32, @floatFromInt(lc)) * 0.5 + 0.5) * Y_SPACING;
        }
    }

    // 5. Final coordinates.
    const mid_x = (@as(f32, @floatFromInt(num_layers)) - 1.0) * X_SPACING * 0.5;
    l = 0;
    while (l < num_layers) : (l += 1) {
        const lc = layout_layer_count[l];
        const start = layout_layer_offset[l];
        const layer_x = @as(f32, @floatFromInt(l)) * X_SPACING - mid_x;
        var idx: u32 = 0;
        while (idx < lc) : (idx += 1) {
            const n = layout_layer_nodes[start + idx];
            pos_x[n] = layer_x;
            pos_y[n] = (@as(f32, @floatFromInt(idx)) - @as(f32, @floatFromInt(lc)) * 0.5 + 0.5) * Y_SPACING;
        }
    }
    return num_layers;
}

// ── Force-directed layout (animated) ────────────────────────────────────────
//
// Springs on edges + Coulomb repulsion between all node pairs + light gravity
// toward the origin. JS runs the simulation as an animation by calling
// `forceLayoutTick(dt)` per frame, so you SEE the graph settle (which is a
// better feature demo than dropping into the final state at once).
//
// O(N²) per tick — fine through ~1500 nodes. Above that we'd want a
// Barnes-Hut quadtree; not in this iteration.

var force_vx: []f32 = &.{};
var force_vy: []f32 = &.{};
var force_fx: []f32 = &.{};
var force_fy: []f32 = &.{};
var force_initialized: bool = false;

pub export fn forceLayoutReset() void {
    if (!force_initialized) return;
    @memset(force_vx, 0);
    @memset(force_vy, 0);
}

pub export fn forceLayoutTick(dt: f32) void {
    if (node_count == 0) return;
    if (!force_initialized) return;
    invalidateGrid();
    const K_REPEL: f32 = 12000.0;
    const K_ATTRACT: f32 = 0.04;
    const GRAVITY: f32 = 0.002;
    const DAMPING: f32 = 0.88;
    const MAX_VEL: f32 = 120.0;
    const IDEAL_EDGE: f32 = 180.0;

    var i: u32 = 0;
    while (i < node_count) : (i += 1) {
        force_fx[i] = 0;
        force_fy[i] = 0;
    }

    // Coulomb repulsion (all pairs).
    var a: u32 = 0;
    while (a < node_count) : (a += 1) {
        var b: u32 = a + 1;
        while (b < node_count) : (b += 1) {
            const dx = pos_x[a] - pos_x[b];
            const dy = pos_y[a] - pos_y[b];
            const d2 = dx * dx + dy * dy + 1.0;
            const d = std.math.sqrt(d2);
            const f = K_REPEL / d2;
            const ux = dx / d;
            const uy = dy / d;
            force_fx[a] += ux * f;
            force_fy[a] += uy * f;
            force_fx[b] -= ux * f;
            force_fy[b] -= uy * f;
        }
    }

    // Spring on edges.
    var e: u32 = 0;
    while (e < edge_count) : (e += 1) {
        const u = edge_from_node[e];
        const v = edge_to_node[e];
        const dx = pos_x[v] - pos_x[u];
        const dy = pos_y[v] - pos_y[u];
        const d = std.math.sqrt(dx * dx + dy * dy + 0.01);
        const stretch = d - IDEAL_EDGE;
        const fx_d = (dx / d) * stretch * K_ATTRACT;
        const fy_d = (dy / d) * stretch * K_ATTRACT;
        force_fx[u] += fx_d;
        force_fy[u] += fy_d;
        force_fx[v] -= fx_d;
        force_fy[v] -= fy_d;
    }

    // Gravity + integrate.
    i = 0;
    while (i < node_count) : (i += 1) {
        force_fx[i] -= pos_x[i] * GRAVITY;
        force_fy[i] -= pos_y[i] * GRAVITY;
        force_vx[i] = (force_vx[i] + force_fx[i] * dt) * DAMPING;
        force_vy[i] = (force_vy[i] + force_fy[i] * dt) * DAMPING;
        const vlen2 = force_vx[i] * force_vx[i] + force_vy[i] * force_vy[i];
        if (vlen2 > MAX_VEL * MAX_VEL) {
            const v = std.math.sqrt(vlen2);
            const s = MAX_VEL / v;
            force_vx[i] *= s;
            force_vy[i] *= s;
        }
        pos_x[i] += force_vx[i] * dt;
        pos_y[i] += force_vy[i] * dt;
    }
}

// ── Stress test: deterministic synthetic graph ──────────────────────────────
//
// JS calls this with a node count; we add up to N flow-primitive nodes and
// ~1.5N random edges. Deterministic via a fixed LCG seed so successive runs
// are comparable for benchmarking. Caps respected — if we'd exceed NODE_CAP
// or EDGE_CAP we just stop, returning what actually landed.
pub export fn generateStress(count: u32) u32 {
    var seed: u32 = 0xC0FFEE;
    var added: u32 = 0;

    // Per-kind size/port tables (flow primitives only).
    const sizes_w = [_]f32{ 140, 160, 160, 130, 140, 160, 130 };
    const sizes_h = [_]f32{ 60, 80, 80, 130, 60, 120, 130 };
    const nins  = [_]u32{ 0, 1, 1, 1, 1, 3, 1 };
    const nouts = [_]u32{ 1, 1, 1, 2, 0, 1, 3 };

    var i: u32 = 0;
    while (i < count and node_count < NODE_CAP) : (i += 1) {
        seed = seed *% 1664525 +% 1013904223;
        const k: u32 = seed % 7;
        seed = seed *% 1664525 +% 1013904223;
        const xn = (@as(f32, @floatFromInt(seed % 10000)) / 10000.0) - 0.5;
        seed = seed *% 1664525 +% 1013904223;
        const yn = (@as(f32, @floatFromInt(seed % 10000)) / 10000.0) - 0.5;
        // Scatter in a 4000×3000 area so they don't all overlap.
        const x = xn * 4000.0;
        const y = yn * 3000.0;
        if (addNode(x, y, sizes_w[k], sizes_h[k], k, nins[k], nouts[k]) >= 0) added += 1;
    }

    // Random edges (~1.5N), favouring legal port directions.
    if (node_count > 1) {
        const target_edges: u32 = count * 3 / 2;
        var ec: u32 = 0;
        while (ec < target_edges and edge_count < EDGE_CAP) : (ec += 1) {
            seed = seed *% 1664525 +% 1013904223;
            const a = seed % node_count;
            seed = seed *% 1664525 +% 1013904223;
            const b = seed % node_count;
            if (a == b) continue;
            if (n_out[a] == 0 or n_in[b] == 0) continue;
            seed = seed *% 1664525 +% 1013904223;
            const ap = seed % @as(u32, n_out[a]);
            seed = seed *% 1664525 +% 1013904223;
            const bp = seed % @as(u32, n_in[b]);
            _ = addEdge(a, ap, b, bp);
        }
    }
    return added;
}

// ── Hit tests ───────────────────────────────────────────────────────────────

/// Topmost-id node containing the point. -1 on miss. O(k) where k is the
/// number of nodes overlapping the query cell (typically a handful).
pub export fn hitTestNode(qx: f32, qy: f32) i32 {
    if (grid_dirty) rebuildGrid();
    if (node_count == 0) return -1;
    var cx: u32 = 0;
    var cy: u32 = 0;
    worldToGrid(qx, qy, &cx, &cy);
    const idx = cy * GRID_DIM + cx;
    const count = grid_count[idx];
    // Reverse scan so higher-id (drawn later, on top) wins.
    var k: i32 = @intCast(count);
    while (k > 0) {
        k -= 1;
        const id = grid_cells[idx * GRID_BUCKET + @as(u32, @intCast(k))];
        const hw = size_w[id] * 0.5;
        const hh = size_h[id] * 0.5;
        const dx = qx - pos_x[id];
        const dy = qy - pos_y[id];
        if (dx >= -hw and dx <= hw and dy >= -hh and dy <= hh) return @intCast(id);
    }
    return -1;
}

/// Packed result: -1 miss, else (side<<24)|(port_idx<<16)|node_id.
/// Uses the spatial grid: we only check ports of nodes whose AABB overlaps
/// the query cell (plus 1-cell neighbors to catch ports sitting at the
/// node's outer edge that fall into a neighboring cell).
pub export fn hitTestPort(qx: f32, qy: f32, radius: f32) i32 {
    if (grid_dirty) rebuildGrid();
    if (node_count == 0) return -1;
    const r2 = radius * radius;
    var cx: u32 = 0;
    var cy: u32 = 0;
    worldToGrid(qx, qy, &cx, &cy);
    // 3×3 neighborhood for port hit-tests since ports sit on the AABB edge.
    @memset(query_seen[0..node_count], 0);
    const cy_min: u32 = if (cy == 0) 0 else cy - 1;
    const cy_max: u32 = if (cy + 1 >= GRID_DIM) GRID_DIM - 1 else cy + 1;
    const cx_min: u32 = if (cx == 0) 0 else cx - 1;
    const cx_max: u32 = if (cx + 1 >= GRID_DIM) GRID_DIM - 1 else cx + 1;
    var ny = cy_min;
    while (ny <= cy_max) : (ny += 1) {
        var nx = cx_min;
        while (nx <= cx_max) : (nx += 1) {
            const idx = ny * GRID_DIM + nx;
            const count = grid_count[idx];
            var k: u32 = 0;
            while (k < count) : (k += 1) {
                const i = grid_cells[idx * GRID_BUCKET + k];
                if (query_seen[i] != 0) continue;
                query_seen[i] = 1;
                const result = hitTestPortOnNode(i, qx, qy, r2);
                if (result != -1) return result;
            }
        }
    }
    return -1;
}

fn hitTestPortOnNode(i: u32, qx: f32, qy: f32, r2: f32) i32 {
    const cx = pos_x[i];
    const cy = pos_y[i];
    const hw = size_w[i] * 0.5;
    const hh = size_h[i] * 0.5;
    const ni: u32 = n_in[i];
    var p: u32 = 0;
    while (p < ni) : (p += 1) {
        const py = cy - hh + size_h[i] * (@as(f32, @floatFromInt(p + 1)) / @as(f32, @floatFromInt(ni + 1)));
        const px = cx - hw;
        const dx = qx - px;
        const dy = qy - py;
        if (dx * dx + dy * dy <= r2) return pack(0, p, i);
    }
    const no: u32 = n_out[i];
    p = 0;
    while (p < no) : (p += 1) {
        const py = cy - hh + size_h[i] * (@as(f32, @floatFromInt(p + 1)) / @as(f32, @floatFromInt(no + 1)));
        const px = cx + hw;
        const dx = qx - px;
        const dy = qy - py;
        if (dx * dx + dy * dy <= r2) return pack(1, p, i);
    }
    return -1;
}

/// Fill query_results with all node ids whose AABB overlaps the given rect.
/// Returns count. JS reads via queryResultsPtr + queryCount.
pub export fn queryRect(min_x: f32, min_y: f32, max_x: f32, max_y: f32) u32 {
    if (grid_dirty) rebuildGrid();
    query_count = 0;
    if (node_count == 0) return 0;
    @memset(query_seen[0..node_count], 0);
    var cx0: u32 = 0;
    var cy0: u32 = 0;
    var cx1: u32 = 0;
    var cy1: u32 = 0;
    worldToGrid(min_x, min_y, &cx0, &cy0);
    worldToGrid(max_x, max_y, &cx1, &cy1);
    var cy = cy0;
    while (cy <= cy1) : (cy += 1) {
        var cx = cx0;
        while (cx <= cx1) : (cx += 1) {
            const idx = cy * GRID_DIM + cx;
            const count = grid_count[idx];
            var k: u32 = 0;
            while (k < count) : (k += 1) {
                const id = grid_cells[idx * GRID_BUCKET + k];
                if (query_seen[id] != 0) continue;
                query_seen[id] = 1;
                // True AABB overlap test (the cell test is conservative).
                const hw = size_w[id] * 0.5;
                const hh = size_h[id] * 0.5;
                if (pos_x[id] + hw < min_x or pos_x[id] - hw > max_x) continue;
                if (pos_y[id] + hh < min_y or pos_y[id] - hh > max_y) continue;
                query_results[query_count] = id;
                query_count += 1;
            }
        }
    }
    return query_count;
}

pub export fn queryResultsPtr() u32 { return @intCast(@intFromPtr(query_results.ptr)); }

inline fn pack(side: u32, port_idx: u32, node_id: u32) i32 {
    return @intCast((side << 24) | ((port_idx & 0xFF) << 16) | (node_id & 0xFFFF));
}

// ── Undo / Redo ─────────────────────────────────────────────────────────────

fn captureTo(s: *Snapshot) void {
    s.node_count = node_count;
    s.edge_count = edge_count;
    @memcpy(s.pos_x[0..node_count], pos_x[0..node_count]);
    @memcpy(s.pos_y[0..node_count], pos_y[0..node_count]);
    @memcpy(s.size_w[0..node_count], size_w[0..node_count]);
    @memcpy(s.size_h[0..node_count], size_h[0..node_count]);
    @memcpy(s.kind[0..node_count], kind[0..node_count]);
    @memcpy(s.n_in[0..node_count], n_in[0..node_count]);
    @memcpy(s.n_out[0..node_count], n_out[0..node_count]);
    @memcpy(s.selected[0..node_count], selected[0..node_count]);
    @memcpy(s.edge_from_node[0..edge_count], edge_from_node[0..edge_count]);
    @memcpy(s.edge_to_node[0..edge_count], edge_to_node[0..edge_count]);
    @memcpy(s.edge_from_port[0..edge_count], edge_from_port[0..edge_count]);
    @memcpy(s.edge_to_port[0..edge_count], edge_to_port[0..edge_count]);
    @memcpy(s.edge_selected[0..edge_count], edge_selected[0..edge_count]);
}

fn restoreFrom(s: *const Snapshot) void {
    invalidateGrid();
    node_count = s.node_count;
    edge_count = s.edge_count;
    @memcpy(pos_x[0..node_count], s.pos_x[0..node_count]);
    @memcpy(pos_y[0..node_count], s.pos_y[0..node_count]);
    @memcpy(size_w[0..node_count], s.size_w[0..node_count]);
    @memcpy(size_h[0..node_count], s.size_h[0..node_count]);
    @memcpy(kind[0..node_count], s.kind[0..node_count]);
    @memcpy(n_in[0..node_count], s.n_in[0..node_count]);
    @memcpy(n_out[0..node_count], s.n_out[0..node_count]);
    @memcpy(selected[0..node_count], s.selected[0..node_count]);
    @memcpy(edge_from_node[0..edge_count], s.edge_from_node[0..edge_count]);
    @memcpy(edge_to_node[0..edge_count], s.edge_to_node[0..edge_count]);
    @memcpy(edge_from_port[0..edge_count], s.edge_from_port[0..edge_count]);
    @memcpy(edge_to_port[0..edge_count], s.edge_to_port[0..edge_count]);
    @memcpy(edge_selected[0..edge_count], s.edge_selected[0..edge_count]);
}

fn pushSnapshot() void {
    // Truncate redo branch: everything after the cursor is gone the moment
    // the user makes a new edit. Standard editor semantics.
    undo_top = undo_cursor + 1;

    if (undo_top > UNDO_CAP) {
        // Slide window: drop the oldest, keep the most recent UNDO_CAP-1.
        var i: u32 = 0;
        while (i < UNDO_CAP - 1) : (i += 1) {
            undo_stack[i] = undo_stack[i + 1];
        }
        undo_top = UNDO_CAP;
        undo_cursor = UNDO_CAP - 1;
    }
    captureTo(&undo_stack[undo_cursor]);
}

/// JS calls this after a user-visible change (drag complete, edge added,
/// delete, duplicate). It commits a new state to the undo stack.
pub export fn snapshot() void {
    undo_cursor = if (undo_cursor + 1 < UNDO_CAP) undo_cursor + 1 else UNDO_CAP - 1;
    pushSnapshot();
}

pub export fn undo() u32 {
    if (undo_cursor == 0) return 0;
    undo_cursor -= 1;
    restoreFrom(&undo_stack[undo_cursor]);
    return 1;
}

pub export fn redo() u32 {
    if (undo_cursor + 1 >= undo_top) return 0;
    undo_cursor += 1;
    restoreFrom(&undo_stack[undo_cursor]);
    return 1;
}

pub export fn canUndo() u32 { return if (undo_cursor > 0) 1 else 0; }
pub export fn canRedo() u32 { return if (undo_cursor + 1 < undo_top) 1 else 0; }

/// Wipe the graph state back to "empty document" so the JS host can stream a
/// fresh graph in (Load-from-file, template, etc.). Buffers stay allocated.
/// JS is responsible for re-pushing a snapshot afterwards.
pub export fn reset() void {
    node_count = 0;
    edge_count = 0;
    @memset(selected[0..NODE_CAP], 0);
    @memset(edge_selected[0..EDGE_CAP], 0);
    undo_top = 0;
    undo_cursor = 0;
    invalidateGrid();
}

// History scrubber API — JS reads cursor + top to render a slider, and writes
// a cursor to time-travel to a specific snapshot.
pub export fn historyCursor() u32 { return undo_cursor; }
pub export fn historyTop()    u32 { return undo_top; }
pub export fn historyJump(idx: u32) u32 {
    if (idx >= undo_top) return 0;
    undo_cursor = idx;
    restoreFrom(&undo_stack[undo_cursor]);
    return 1;
}

// ── Live computation engine ─────────────────────────────────────────────────
//
// Each node kind has a deterministic compute function. Sources (in-degree=0)
// of kind Input emit a sine wave keyed on (time, node id). Topological
// traversal then propagates values through the graph, with kind-specific
// semantics:
//   Process    → input * 1.1
//   Filter     → max(input, 0)
//   Decision   → routes input to out-port 0 if val > 0, else port 1
//   Output     → terminal, just shows value
//   Aggregator → sum of all inputs
//   Branch     → fan-out: same value to every output port
//
// The renderer overlays each edge with its current value when "live" is on.
// Cycles get value 0 (nodes never reached by topo sort).
var node_value: []f32 = &.{};
var edge_value: []f32 = &.{};
var compute_initialized: bool = false;

pub export fn computeTick(time_seconds: f32) void {
    if (!compute_initialized) return;
    if (node_count == 0) return;

    // Reset values.
    @memset(node_value[0..node_count], 0);
    @memset(edge_value[0..edge_count], 0);

    // Build in-degree using the layout scratch arrays (we're not concurrent
    // with layout, and they're sized at NODE_CAP).
    var i: u32 = 0;
    while (i < node_count) : (i += 1) layout_indeg[i] = 0;
    var e: u32 = 0;
    while (e < edge_count) : (e += 1) {
        const to = edge_to_node[e];
        if (to < node_count) layout_indeg[to] += 1;
    }

    // Initial frontier: every source.
    var qhead: u32 = 0;
    var qtail: u32 = 0;
    i = 0;
    while (i < node_count) : (i += 1) {
        if (layout_indeg[i] == 0) {
            layout_queue[qtail] = i;
            qtail += 1;
        }
    }

    // Topological propagation.
    while (qhead < qtail) {
        const u = layout_queue[qhead];
        qhead += 1;
        const k = kind[u];

        // Gather incoming values: sum (for Aggregator) and "first" (for the
        // single-input kinds). We do one pass over edges per node, which is
        // O(N·E) total — fine through low thousands of nodes/edges.
        var sum: f32 = 0;
        var first: f32 = 0;
        var got_any: bool = false;
        e = 0;
        while (e < edge_count) : (e += 1) {
            if (edge_to_node[e] != u) continue;
            const ev = edge_value[e];
            sum += ev;
            if (!got_any) { first = ev; got_any = true; }
        }

        // Compute by kind.
        const val: f32 = switch (k) {
            // Sources: animated sine so the demo isn't static.
            0 => @sin(time_seconds * 0.7 + @as(f32, @floatFromInt(u)) * 0.6) * 5.0,
            1 => first * 1.1,
            2 => if (first < 0) 0 else first,
            3 => first,
            4 => first,
            5 => sum,
            6 => first,
            else => 0,
        };
        node_value[u] = val;

        // Propagate to outgoing edges with kind-specific routing.
        e = 0;
        while (e < edge_count) : (e += 1) {
            if (edge_from_node[e] != u) continue;
            if (k == 3) {
                // Decision: out-port 0 carries val when val>0; port 1 when val<=0.
                const route0 = (val > 0 and edge_from_port[e] == 0);
                const route1 = (val <= 0 and edge_from_port[e] == 1);
                edge_value[e] = if (route0 or route1) val else 0;
            } else {
                edge_value[e] = val;
            }
            const target = edge_to_node[e];
            if (target < node_count) {
                layout_indeg[target] -= 1;
                if (layout_indeg[target] == 0) {
                    layout_queue[qtail] = target;
                    qtail += 1;
                }
            }
        }
    }
}

pub export fn nodeValuePtr() u32 { return @intCast(@intFromPtr(node_value.ptr)); }
pub export fn edgeValuePtr() u32 { return @intCast(@intFromPtr(edge_value.ptr)); }

// ── Zero-copy pointer exports ───────────────────────────────────────────────

pub export fn posXPtr() u32 { return @intCast(@intFromPtr(pos_x.ptr)); }
pub export fn posYPtr() u32 { return @intCast(@intFromPtr(pos_y.ptr)); }
pub export fn sizeWPtr() u32 { return @intCast(@intFromPtr(size_w.ptr)); }
pub export fn sizeHPtr() u32 { return @intCast(@intFromPtr(size_h.ptr)); }
pub export fn kindPtr() u32 { return @intCast(@intFromPtr(kind.ptr)); }
pub export fn nInPtr() u32 { return @intCast(@intFromPtr(n_in.ptr)); }
pub export fn nOutPtr() u32 { return @intCast(@intFromPtr(n_out.ptr)); }
pub export fn selectedPtr() u32 { return @intCast(@intFromPtr(selected.ptr)); }
pub export fn edgeFromNodePtr() u32 { return @intCast(@intFromPtr(edge_from_node.ptr)); }
pub export fn edgeToNodePtr() u32 { return @intCast(@intFromPtr(edge_to_node.ptr)); }
pub export fn edgeFromPortPtr() u32 { return @intCast(@intFromPtr(edge_from_port.ptr)); }
pub export fn edgeToPortPtr() u32 { return @intCast(@intFromPtr(edge_to_port.ptr)); }
pub export fn edgeSelectedPtr() u32 { return @intCast(@intFromPtr(edge_selected.ptr)); }
pub export fn nodeCount_() u32 { return node_count; }
pub export fn edgeCount_() u32 { return edge_count; }
pub export fn nodeCap() u32 { return NODE_CAP; }
pub export fn edgeCap() u32 { return EDGE_CAP; }

// ── Freestanding plumbing ───────────────────────────────────────────────────

pub fn panic(msg: []const u8, _: ?*std.builtin.StackTrace, _: ?usize) noreturn {
    _ = msg;
    @trap();
}
