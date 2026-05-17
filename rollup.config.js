// Rollup config — produces ESM + UMD bundles, each in plain and minified
// variants. WASM stays as a separate file (consumers fetch it or inline via
// the `wasmBytes` option). No deps to bundle, no transforms — just pass-
// through with optional terser.

import terser from '@rollup/plugin-terser';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} | (c) ${new Date().getFullYear()} */`;

// Sourcemaps: only attached to the non-minified dev builds. The .min.js files
// ship without maps so consumers don't accidentally publish the readable
// source to a CDN. Set ZFLOW_MAPS=1 in env if you really want maps on min.
const wantMin = (file) => /\.min\.js$/.test(file);
const out = (file, fmt, name) => ({
  file, format: fmt, name, banner, inlineDynamicImports: true,
  sourcemap: !wantMin(file) || process.env.ZFLOW_MAPS === '1',
});

export default [
  // Main library.
  {
    input: 'src/zflow.js',
    output: [
      out('dist/zflow.esm.js',     'esm'),
      out('dist/zflow.umd.js',     'umd', 'ZFlow'),
    ],
  },
  {
    input: 'src/zflow.js',
    plugins: [terser({ format: { comments: /^!/ } })],
    output: [
      out('dist/zflow.esm.min.js', 'esm'),
      out('dist/zflow.umd.min.js', 'umd', 'ZFlow'),
    ],
  },
  // Optional WebGL renderer (consumers import it on demand).
  {
    input: 'src/webgl-renderer.js',
    output: [
      out('dist/webgl-renderer.esm.js', 'esm'),
      out('dist/webgl-renderer.umd.js', 'umd', 'ZFlowWebGL'),
    ],
  },
  {
    input: 'src/webgl-renderer.js',
    plugins: [terser({ format: { comments: /^!/ } })],
    output: [out('dist/webgl-renderer.esm.min.js', 'esm')],
  },
  // Yjs adapter (consumers also bring their own yjs).
  {
    input: 'src/adapters/yjs.js',
    output: [
      out('dist/adapters/yjs.esm.js', 'esm'),
      out('dist/adapters/yjs.umd.js', 'umd', 'ZFlowYjs'),
    ],
  },
  {
    input: 'src/adapters/yjs.js',
    plugins: [terser({ format: { comments: /^!/ } })],
    output: [out('dist/adapters/yjs.esm.min.js', 'esm')],
  },
];
