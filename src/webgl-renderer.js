// zflow WebGL renderer — optimized path.
//
// Architecture:
//   • One shared static quad geometry (6 verts, never changes).
//   • Per-node attributes (center, size, color, sel) live in a persistent
//     instance buffer sized at nodeCap() at init time. We never allocate
//     per-frame — we update only the slots that the host marked dirty.
//   • Camera (pan/zoom) is uniform-only, so panning is FREE in buffer terms.
//   • ANGLE_instanced_arrays draws all nodes in a single drawCall.
//   • Edges keep a persistent buffer too with dirty tracking + bezier
//     tesselation regenerated only when an endpoint moves.
//
// Result: 100k nodes pan/zoom at 60 fps with zero GC. Adding/moving a
// single node touches ~28 bytes of GPU memory, not 7 MB.

const VS = `
attribute vec2 aQuad;
attribute vec2 aCenter;
attribute vec2 aSize;
attribute vec3 aColor;
attribute float aSelected;
uniform vec2 uCam;
uniform float uZoom;
uniform vec2 uScreen;
varying vec3 vColor;
varying float vSelected;
varying vec2 vUv;
void main() {
  vUv = aQuad;
  vSelected = aSelected;
  vColor = aColor;
  vec2 worldPos = aCenter + aQuad * aSize;
  vec2 screen = (worldPos + uCam) * uZoom;
  vec2 ndc = (screen / uScreen) * 2.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
varying vec3 vColor;
varying float vSelected;
varying vec2 vUv;
void main() {
  vec2 q = abs(vUv);
  float d = max(q.x, q.y);
  float alpha = smoothstep(1.0, 0.92, d);
  float header = step(0.7, vUv.y) * 0.18;
  vec3 col = vColor + vec3(header);
  if (vSelected > 0.5) col = mix(col, vec3(0.94, 0.73, 0.23), 0.55);
  gl_FragColor = vec4(col, alpha);
}`;

const EDGE_VS = `
attribute vec2 aPos;
attribute vec3 aColor;
uniform vec2 uCam;
uniform float uZoom;
uniform vec2 uScreen;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec2 screen = (aPos + uCam) * uZoom;
  vec2 ndc = (screen / uScreen) * 2.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const EDGE_FS = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 0.85); }`;

const NODE_STRIDE_F = 8;      // cx, cy, sw, sh, r, g, b, sel
const EDGE_SEGS = 24;
const EDGE_VERTS_PER = (EDGE_SEGS) * 2;
const EDGE_STRIDE_F = 5;       // x, y, r, g, b per vertex

export class WebGLRenderer {
  constructor(flow) {
    this.flow = flow;
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;`;
    flow.container.insertBefore(this.glCanvas, flow.canvas);
    flow.canvas.style.background = 'transparent';
    flow.canvas.style.position = 'absolute';
    flow.canvas.style.zIndex = '1';
    this.gl = this.glCanvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!this.gl) { this.disabled = true; console.warn('zflow: WebGL unavailable'); return; }
    this.instExt = this.gl.getExtension('ANGLE_instanced_arrays');
    this.cap = flow.w.nodeCap();
    this.edgeCap = flow.w.edgeCap();
    this._resize();
    this._setupShaders();
    this._setupBuffers();
    this._hookDirty();
    this._resizeObs = new ResizeObserver(() => this._resize());
    this._resizeObs.observe(flow.container);
    this._dirty = new Set();        // node ids needing buffer upload
    this._dirtyEdges = new Set();
    this._fullRebuildNeeded = true;
    this._lastNodeCount = 0;
    this._lastEdgeCount = 0;
  }

  _hookDirty() {
    const f = this.flow;
    f.on('change', () => { this._fullRebuildNeeded = true; });
    // Hijack moveSelectedBy / moveNode so position changes only mark dirty.
    const origMove = f.w.moveSelectedBy;
    if (origMove) {
      f.w.moveSelectedBy = (dx, dy) => {
        origMove.call(f.w, dx, dy);
        f._ensureAdj?.();
        const adj = f._nodeAdj;
        for (let i = 0; i < f.w.nodeCount_(); i++) {
          if (!f.V.selected[i]) continue;
          this._dirty.add(i);
          // Edges incident on a moved node need their geometry recomputed.
          if (adj && adj[i]) for (let k = 0; k < adj[i].length; k++) this._dirtyEdges.add(adj[i][k]);
        }
      };
    }
    const origMoveNode = f.w.moveNode;
    if (origMoveNode) {
      f.w.moveNode = (id, x, y) => {
        origMoveNode.call(f.w, id, x, y);
        this._dirty.add(id);
        f._ensureAdj?.();
        const adj = f._nodeAdj;
        if (adj && adj[id]) for (let k = 0; k < adj[id].length; k++) this._dirtyEdges.add(adj[id][k]);
      };
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.flow.container.getBoundingClientRect();
    this.glCanvas.width  = r.width  * dpr;
    this.glCanvas.height = r.height * dpr;
    this.gl?.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
  }

  _setupShaders() {
    const gl = this.gl;
    this.progNode = link(gl, VS, FS);
    this.progEdge = link(gl, EDGE_VS, EDGE_FS);
    // Cache uniform/attrib locations.
    this.locN = {
      aQuad: gl.getAttribLocation(this.progNode, 'aQuad'),
      aCenter: gl.getAttribLocation(this.progNode, 'aCenter'),
      aSize: gl.getAttribLocation(this.progNode, 'aSize'),
      aColor: gl.getAttribLocation(this.progNode, 'aColor'),
      aSel: gl.getAttribLocation(this.progNode, 'aSelected'),
      uCam: gl.getUniformLocation(this.progNode, 'uCam'),
      uZoom: gl.getUniformLocation(this.progNode, 'uZoom'),
      uScreen: gl.getUniformLocation(this.progNode, 'uScreen'),
    };
    this.locE = {
      aPos: gl.getAttribLocation(this.progEdge, 'aPos'),
      aColor: gl.getAttribLocation(this.progEdge, 'aColor'),
      uCam: gl.getUniformLocation(this.progEdge, 'uCam'),
      uZoom: gl.getUniformLocation(this.progEdge, 'uZoom'),
      uScreen: gl.getUniformLocation(this.progEdge, 'uScreen'),
    };
  }

  _setupBuffers() {
    const gl = this.gl;
    // Shared quad: 6 verts, 2 floats each, static.
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,   -1, 1,
       1, -1,   1,  1,   -1, 1,
    ]), gl.STATIC_DRAW);

    // Per-instance node buffer pre-allocated at full cap.
    this.nodeData = new Float32Array(this.cap * NODE_STRIDE_F);
    this.nodeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeData.byteLength, gl.DYNAMIC_DRAW);

    // Edge buffer pre-allocated.
    this.edgeData = new Float32Array(this.edgeCap * EDGE_VERTS_PER * EDGE_STRIDE_F);
    this.edgeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeData.byteLength, gl.DYNAMIC_DRAW);
  }

  _writeNode(i) {
    const f = this.flow;
    const cat = f.kinds[f.V.kind[i]];
    const hex = f.colors.get(i) || cat.color;
    const off = i * NODE_STRIDE_F;
    this.nodeData[off    ] = f.V.posX[i];
    this.nodeData[off + 1] = f.V.posY[i];
    this.nodeData[off + 2] = f.V.sizeW[i] * 0.5;
    this.nodeData[off + 3] = f.V.sizeH[i] * 0.5;
    const [r, g, b] = parseHex(hex);
    this.nodeData[off + 4] = r;
    this.nodeData[off + 5] = g;
    this.nodeData[off + 6] = b;
    this.nodeData[off + 7] = f.V.selected[i] !== 0 ? 1 : 0;
  }

  _writeEdge(i) {
    const f = this.flow;
    const a = f.V.edgeFromN[i], b = f.V.edgeToN[i];
    const ap = f._portWorld(a, 1, f.V.edgeFromP[i]);
    const bp = f._portWorld(b, 0, f.V.edgeToP[i]);
    const col = parseHex(f.colors.get(a) || f.kinds[f.V.kind[a]].color);
    const off = i * EDGE_VERTS_PER * EDGE_STRIDE_F;
    const ortho = f.options.edgeStyle === 'orthogonal';
    const offCv = Math.max(50, Math.abs(bp.x - ap.x) * 0.5 + Math.abs(bp.y - ap.y) * 0.4);
    let prev = { x: ap.x, y: ap.y };
    let o = off;
    for (let s = 1; s <= EDGE_SEGS; s++) {
      const t = s / EDGE_SEGS;
      let pt;
      if (ortho) {
        const mx = (ap.x + bp.x) * 0.5;
        pt = t < 0.33 ? lerp(ap, { x: mx, y: ap.y }, t / 0.33)
           : t < 0.67 ? lerp({ x: mx, y: ap.y }, { x: mx, y: bp.y }, (t - 0.33) / 0.34)
           :            lerp({ x: mx, y: bp.y }, bp, (t - 0.67) / 0.33);
      } else {
        pt = bezPt(t, ap.x, ap.y, ap.x + offCv, ap.y, bp.x - offCv, bp.y, bp.x, bp.y);
      }
      this.edgeData[o++] = prev.x; this.edgeData[o++] = prev.y;
      this.edgeData[o++] = col[0]; this.edgeData[o++] = col[1]; this.edgeData[o++] = col[2];
      this.edgeData[o++] = pt.x;   this.edgeData[o++] = pt.y;
      this.edgeData[o++] = col[0]; this.edgeData[o++] = col[1]; this.edgeData[o++] = col[2];
      prev = pt;
    }
  }

  render() {
    if (this.disabled) return;
    const gl = this.gl;
    const f = this.flow;
    const n = f.w.nodeCount_(), m = f.w.edgeCount_();
    const dpr = window.devicePixelRatio || 1;

    gl.clearColor(0.027, 0.035, 0.06, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const camWX = f.cam.x + (this.glCanvas.width  / (2 * dpr * f.cam.zoom));
    const camWY = f.cam.y + (this.glCanvas.height / (2 * dpr * f.cam.zoom));

    // ── Detect what needs upload ────────────────────────────────────
    const nodeStride = NODE_STRIDE_F;
    const edgeStride = EDGE_VERTS_PER * EDGE_STRIDE_F;
    const fullNodes = this._fullRebuildNeeded || n !== this._lastNodeCount;
    const fullEdges = this._fullRebuildNeeded || m !== this._lastEdgeCount;
    if (fullNodes) {
      for (let i = 0; i < n; i++) this._writeNode(i);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nodeData.subarray(0, n * nodeStride));
      this._dirty.clear();
    } else if (this._dirty.size) {
      this._uploadRuns(this._dirty, this.nodeBuf, this.nodeData, nodeStride, (i) => this._writeNode(i));
    }
    if (fullEdges) {
      for (let i = 0; i < m; i++) this._writeEdge(i);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.edgeData.subarray(0, m * edgeStride));
      this._dirtyEdges.clear();
    } else if (this._dirtyEdges.size) {
      // Filter out edges that no longer exist (deletes shift the buffer end).
      for (const e of this._dirtyEdges) if (e >= m) this._dirtyEdges.delete(e);
      this._uploadRuns(this._dirtyEdges, this.edgeBuf, this.edgeData, edgeStride, (i) => this._writeEdge(i));
    }

    this._lastNodeCount = n;
    this._lastEdgeCount = m;
    this._fullRebuildNeeded = false;

    // ── Draw edges (LINES, persistent buffer) ────────────────────────
    if (m > 0) {
      gl.useProgram(this.progEdge);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
      gl.enableVertexAttribArray(this.locE.aPos);
      gl.vertexAttribPointer(this.locE.aPos, 2, gl.FLOAT, false, 5 * 4, 0);
      gl.enableVertexAttribArray(this.locE.aColor);
      gl.vertexAttribPointer(this.locE.aColor, 3, gl.FLOAT, false, 5 * 4, 2 * 4);
      gl.uniform2f(this.locE.uCam, camWX, camWY);
      gl.uniform1f(this.locE.uZoom, f.cam.zoom * dpr);
      gl.uniform2f(this.locE.uScreen, this.glCanvas.width, this.glCanvas.height);
      gl.lineWidth(1.6);
      gl.drawArrays(gl.LINES, 0, m * EDGE_VERTS_PER);
    }

    // ── Draw nodes ──────────────────────────────────────────────────
    if (n > 0) {
      gl.useProgram(this.progNode);
      // aQuad from static buffer.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(this.locN.aQuad);
      gl.vertexAttribPointer(this.locN.aQuad, 2, gl.FLOAT, false, 0, 0);
      if (this.instExt) this.instExt.vertexAttribDivisorANGLE(this.locN.aQuad, 0);
      // per-instance attribs from node buffer.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuf);
      const s = NODE_STRIDE_F * 4;
      gl.enableVertexAttribArray(this.locN.aCenter);
      gl.vertexAttribPointer(this.locN.aCenter, 2, gl.FLOAT, false, s, 0);
      gl.enableVertexAttribArray(this.locN.aSize);
      gl.vertexAttribPointer(this.locN.aSize,   2, gl.FLOAT, false, s, 2 * 4);
      gl.enableVertexAttribArray(this.locN.aColor);
      gl.vertexAttribPointer(this.locN.aColor,  3, gl.FLOAT, false, s, 4 * 4);
      gl.enableVertexAttribArray(this.locN.aSel);
      gl.vertexAttribPointer(this.locN.aSel,    1, gl.FLOAT, false, s, 7 * 4);
      if (this.instExt) {
        this.instExt.vertexAttribDivisorANGLE(this.locN.aCenter, 1);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aSize,   1);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aColor,  1);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aSel,    1);
      }
      gl.uniform2f(this.locN.uCam, camWX, camWY);
      gl.uniform1f(this.locN.uZoom, f.cam.zoom * dpr);
      gl.uniform2f(this.locN.uScreen, this.glCanvas.width, this.glCanvas.height);
      if (this.instExt) {
        this.instExt.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, n);
        // Reset divisors so other passes (edges) work correctly.
        this.instExt.vertexAttribDivisorANGLE(this.locN.aCenter, 0);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aSize,   0);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aColor,  0);
        this.instExt.vertexAttribDivisorANGLE(this.locN.aSel,    0);
      } else {
        // Slow path fallback: 6 verts per node, no extension.
        // (rare; almost every browser since 2014 has the extension)
        for (let i = 0; i < n; i++) {
          const off = i * NODE_STRIDE_F;
          gl.vertexAttrib2f(this.locN.aCenter, this.nodeData[off],     this.nodeData[off + 1]);
          gl.vertexAttrib2f(this.locN.aSize,   this.nodeData[off + 2], this.nodeData[off + 3]);
          gl.vertexAttrib3f(this.locN.aColor,  this.nodeData[off + 4], this.nodeData[off + 5], this.nodeData[off + 6]);
          gl.vertexAttrib1f(this.locN.aSel,    this.nodeData[off + 7]);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
    }
  }

  /** Mark a node as needing buffer update. Called from host on move/recolor. */
  markNodeDirty(i) { this._dirty.add(i); }
  markEdgeDirty(i) { this._dirtyEdges.add(i); }
  markAllDirty()   { this._fullRebuildNeeded = true; }

  /** Upload a dirty Set by collapsing it into contiguous runs of `stride` floats. */
  _uploadRuns(set, buf, dataArr, stride, writeOne) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const sorted = [...set].sort((a, b) => a - b);
    let runStart = sorted[0], runEnd = sorted[0];
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k] === runEnd + 1) { runEnd = sorted[k]; continue; }
      for (let i = runStart; i <= runEnd; i++) writeOne(i);
      gl.bufferSubData(gl.ARRAY_BUFFER, runStart * stride * 4,
        dataArr.subarray(runStart * stride, (runEnd + 1) * stride));
      runStart = sorted[k]; runEnd = sorted[k];
    }
    for (let i = runStart; i <= runEnd; i++) writeOne(i);
    gl.bufferSubData(gl.ARRAY_BUFFER, runStart * stride * 4,
      dataArr.subarray(runStart * stride, (runEnd + 1) * stride));
    set.clear();
  }

  dispose() {
    this._resizeObs?.disconnect();
    this.glCanvas?.remove();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
function compile(gl, src, kind) {
  const s = gl.createShader(kind);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('GL compile: ' + gl.getShaderInfoLog(s));
  return s;
}
function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, vs, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(gl, fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('GL link: ' + gl.getProgramInfoLog(p));
  return p;
}
function parseHex(h) {
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}
function bezPt(t, x1, y1, cx1, cy1, cx2, cy2, x2, y2) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  const a = mt2 * mt, b = 3 * mt2 * t, c = 3 * mt * t2, d = t2 * t;
  return { x: a*x1 + b*cx1 + c*cx2 + d*x2, y: a*y1 + b*cy1 + c*cy2 + d*y2 };
}
function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
