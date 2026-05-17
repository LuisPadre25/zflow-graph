// jsdom doesn't ship a Canvas2D implementation. Stub it with no-ops so the
// renderer code can call methods without crashing in tests. We don't verify
// pixel output — only behavior, state, and computations.

import { vi } from 'vitest';

function makeCanvasCtx() {
  const ctx = {};
  const methods = [
    'fillRect', 'clearRect', 'strokeRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'arcTo', 'bezierCurveTo', 'quadraticCurveTo',
    'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'rotate',
    'setTransform', 'resetTransform', 'clip', 'measureText', 'fillText',
    'strokeText', 'drawImage', 'createLinearGradient', 'createRadialGradient',
    'createPattern', 'setLineDash', 'getLineDash', 'putImageData', 'getImageData',
    'rect', 'ellipse',
  ];
  for (const m of methods) ctx[m] = vi.fn(() => ({}));
  ctx.measureText = vi.fn((s) => ({ width: (s?.length || 0) * 6 }));
  ctx.createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  ctx.canvas = null;
  return new Proxy(ctx, {
    set(target, prop, value) { target[prop] = value; return true; },
    get(target, prop) { return prop in target ? target[prop] : undefined; },
  });
}

// Patch HTMLCanvasElement.prototype.getContext (jsdom returns null by default).
if (typeof window !== 'undefined') {
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type) {
    if (type === '2d') {
      const ctx = makeCanvasCtx();
      ctx.canvas = this;
      return ctx;
    }
    if (type === 'webgl' || type === 'webgl2') return null; // tests don't need GL
    return null;
  };
  // toBlob for exportPNG tests.
  proto.toBlob = function (cb) { cb(new Blob([new Uint8Array([0])], { type: 'image/png' })); };

  // ResizeObserver polyfill (jsdom missing).
  if (!window.ResizeObserver) {
    window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
  }

  // requestAnimationFrame: jsdom has it but tied to setTimeout(16ms). Stub
  // to a cheap setTimeout(0) so test loops don't dawdle.
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}
