# Security model

## What zflow-graph is

A **client-side** ES module + WASM that renders and executes node graphs. It runs entirely in the browser (or any embedded WebView). It has no server component, no network calls of its own, and no privileged APIs.

## What zflow-graph is **not**

- Not a sandbox for untrusted code. Functions passed to `kind.execute` run with **the same privileges as your page**.
- Not a secret store. Anything you put in `flow.toJSON()`, including `setNodeParams`, is visible in the browser.
- Not obfuscated. Minified JS is readable in 2026 by any LLM in seconds. We do not pretend otherwise.

## Threat model

| Threat                                                | Mitigated by zflow? | Notes |
| ----------------------------------------------------- | :-----------------: | ----- |
| XSS via user-controlled node titles / descriptions    |         ✅          | All user strings rendered inside DOM overlays (preview popover, expression editor, context menu, autocomplete) are escaped with an internal `escapeHtml`. Canvas2D rendering is inherently text-safe (it's pixels). |
| Code IP theft (someone reads your bundle)             |         ❌          | **Impossible to fully prevent on the web.** Use license (MIT/GPL/proprietary) for legal recourse. Move sensitive logic to a server you control. |
| Supply-chain attack via `npm install zflow-graph`     |         ✅          | This package has **zero runtime dependencies**. Yjs is opt-in and only loaded if you import the adapter explicitly. Pin versions and audit with `npm audit`. |
| Untrusted plugin via `flow.use(plugin)`               |         ❌          | Plugins run with full access to the flow and the host page. **Only install plugins you trust.** Treat them like NPM packages. |
| Untrusted `kind.execute` body                         |         ❌          | Same as above — anything in `execute` runs with page privileges. Don't load executors from user input. |
| Untrusted Mermaid / DOT / JSON imports                |         ✅          | The parsers are string-based — no `eval` or `new Function`. Worst case is malformed graph data. |
| Untrusted `evalExpression` input                      |         ⚠️          | `evalExpression` uses `new Function` internally. **Do not pass expressions from untrusted users.** Use it for editor templates, not for user-submitted expressions. |
| CSP (Content Security Policy) compatibility           |         ⚠️          | `evalExpression` requires `unsafe-eval` because of `new Function`. If your CSP forbids it, disable expression evaluation or fork to use a safe expression parser. |
| WASM integrity                                        |         ✅          | The WASM is loaded by URL or pre-fetched bytes. If you want SRI-style integrity, hash the file at build time and verify before `WebAssembly.instantiate`. |

## Recommended host-side hardening

If you embed zflow-graph in an app, **the surrounding security work is your responsibility**:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';   # WASM needs wasm-unsafe-eval
  worker-src 'self' blob:;
  connect-src 'self' wss://your-yjs-relay.example;
  img-src 'self' data: https:;            # if you setNodeImage with external URLs
```

Notes:
- `wasm-unsafe-eval` is required to load `zflow.wasm`.
- `unsafe-eval` is required if you call `evalExpression()`. If you don't, leave it out.
- For Subresource Integrity of the WASM:
  ```js
  const buf = await fetch('zflow.wasm').then(r => r.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', buf);
  if (toHex(hash) !== EXPECTED_HASH) throw new Error('WASM tampered');
  const flow = await ZFlow.create({ container, wasmBytes: new Uint8Array(buf) });
  ```

## Sourcemaps

- Sourcemaps are **only emitted for the non-minified bundles** (`*.esm.js`, `*.umd.js`).
- The minified bundles (`*.min.js`) ship **without sourcemaps** so accidentally deploying `dist/` to a CDN does not expose the full original source.
- To opt in to maps on minified builds for your own debugging, run `ZFLOW_MAPS=1 npm run build:js`.

## Reporting a vulnerability

Email **luis.padre21@gmail.com** with `[zflow-graph security]` in the subject. Please do not open public issues for security reports.

We aim to acknowledge within 72 hours. Critical issues get a patch within 7 days.

## What we will *not* do

- Add code obfuscation. It is performance overhead with no real security benefit. If you need IP protection, keep that code on a server.
- Add a "license check" that calls home. zflow-graph is MIT — once you have it, you have it.
- Promise that your secrets stay secret if you ship them in `flow.toJSON()`. They won't. Use a server.
