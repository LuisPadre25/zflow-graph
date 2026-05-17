# 7 · Recipes

Concrete, paste-and-run examples for common scenarios.

---

## Recipe 1: A workflow tool with HTTP and Slack

```js
flow.registerKind({
  name: 'http-get',
  color: '#5b8def', badge: 'H', nin: 1, nout: 2,
  portIn: ['url'], portOut: ['body', 'error'],
  retry: { n: 3, delay: 500 },
  execute: async (ctx, ins) => {
    try {
      const r = await fetch(ins.url, { signal: ctx.signal });
      return { body: await r.text() };
    } catch (e) {
      return { error: e.message };
    }
  },
});

flow.registerKind({
  name: 'slack-send',
  color: '#5bd17a', badge: 'S', nin: 1, nout: 0,
  portIn: ['message'],
  execute: async (ctx, ins) => {
    await fetch('https://hooks.slack.com/your-webhook', {
      method: 'POST',
      body: JSON.stringify({ text: ins.message }),
      signal: ctx.signal,
    });
  },
});

flow.registerKind({
  name: 'filter-contains',
  color: '#e8b04b', badge: '∋', nin: 1, nout: 2,
  portIn: ['text'], portOut: ['matched', 'no'],
  execute: (ctx, ins) => {
    const needle = ctx.params.needle || '';
    return ins.text.includes(needle) ? { matched: ins.text } : { no: ins.text };
  },
});

const url    = flow.addNode({ kind: 'http-get',         x:    0, y: 0, title: 'fetch logs' });
const filter = flow.addNode({ kind: 'filter-contains', x:  240, y: 0, title: 'find errors' });
const send   = flow.addNode({ kind: 'slack-send',      x:  480, y: 0, title: 'notify team' });

flow.setNodeParams(filter, { needle: 'ERROR' });
flow.setNodeInput(url, { url: 'https://api/logs' });

flow.addEdge({ from: url, fp: 0, to: filter });        // body → filter
flow.addEdge({ from: filter, fp: 0, to: send });       // matched → slack

flow.startLoop(60_000);   // poll every minute
```

---

## Recipe 2: Live data dashboard

```js
flow.registerKind({
  name: 'poll',
  nin: 0, nout: 1,
  execute: async (ctx) => {
    const r = await fetch(ctx.params.url, { signal: ctx.signal });
    return r.json();
  },
});

flow.registerKind({
  name: 'metric-card',
  html: true,
  template: '<div style="padding:12px;color:#5be0d0;font-size:24px;font-weight:700;text-align:center;" class="value">—</div>',
  w: 200, h: 80, nin: 1, nout: 0,
  execute: (ctx, ins) => {
    const el = flow._htmlOverlays.get(ctx.nodeId);
    el.querySelector('.value').textContent = ins.in0 ?? ins[0];
  },
});

const poll = flow.addNode({ kind: 'poll',         x: -200, y: 0, title: '/api/users/count' });
const card = flow.addNode({ kind: 'metric-card',  x:  100, y: 0 });

flow.setNodeParams(poll, { url: '/api/users/count' });
flow.addEdge({ from: poll, to: card });

flow.startLoop(2000);   // refresh every 2s
```

---

## Recipe 3: Image-processing pipeline (ComfyUI vibe)

```js
flow.registerKind({
  name: 'load-image',
  nin: 0, nout: 1, portOut: ['image'],
  execute: async (ctx) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = ctx.params.url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return { image: c };
  },
});

flow.registerKind({
  name: 'grayscale',
  nin: 1, nout: 1, portIn: ['image'], portOut: ['image'],
  execute: (ctx, ins) => {
    const src = ins.image;
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const sctx = src.getContext('2d');
    const data = sctx.getImageData(0, 0, src.width, src.height);
    for (let i = 0; i < data.data.length; i += 4) {
      const g = data.data[i] * 0.3 + data.data[i+1] * 0.59 + data.data[i+2] * 0.11;
      data.data[i] = data.data[i+1] = data.data[i+2] = g;
    }
    out.getContext('2d').putImageData(data, 0, 0);
    return { image: out };
  },
});

flow.registerKind({
  name: 'show-image',
  html: true,
  template: '<img class="out" style="width:100%;height:100%;object-fit:contain;">',
  w: 240, h: 240, nin: 1, nout: 0, portIn: ['image'],
  execute: (ctx, ins) => {
    const el = flow._htmlOverlays.get(ctx.nodeId);
    const url = ins.image.toDataURL();
    el.querySelector('.out').src = url;
  },
});

const load = flow.addNode({ kind: 'load-image' });
const gray = flow.addNode({ kind: 'grayscale' });
const show = flow.addNode({ kind: 'show-image' });

flow.setNodeParams(load, { url: 'https://picsum.photos/400' });
flow.addEdge({ from: load, to: gray });
flow.addEdge({ from: gray, to: show });

await flow.run();
```

---

## Recipe 4: A sidebar with draggable nodes (palette)

```html
<div id="palette" style="position:fixed;top:14px;left:14px;display:flex;flex-direction:column;gap:6px;">
  <div class="pal" data-kind="http-get">HTTP GET</div>
  <div class="pal" data-kind="slack-send">Slack</div>
  <div class="pal" data-kind="filter-contains">Filter</div>
</div>
<style>
  .pal { padding: 8px 12px; background: rgba(91,141,239,0.15); color: #5b8def;
         border-radius: 5px; cursor: grab; font: 600 12px sans-serif; user-select: none; }
</style>
<script type="module">
  // ... create flow ...

  document.querySelectorAll('.pal').forEach((el) => {
    flow.makeDraggable(el, {
      kind: el.dataset.kind,
      title: el.textContent,
    });
  });
</script>
```

Drag a chip from the palette into the canvas — a node of that kind is created at the drop position.

---

## Recipe 5: Read-only mode for sharing

```js
const url = new URL(location.href);
if (url.searchParams.has('view')) {
  flow.setReadOnly(true);
  // Hide the toolbar / palette
  document.getElementById('toolbar').style.display = 'none';
}
```

In read-only mode:
- `addNode`, `addEdge`, `deleteSelection` are no-ops (return -1)
- Dragging and resizing are disabled
- Selection and pan/zoom still work — users can explore but not mutate

---

## Recipe 6: Snapshot diff between versions

```js
function diff(beforeJSON, afterJSON) {
  const before = new Map(beforeJSON.nodes.map((n, i) => [i, n]));
  const after  = new Map(afterJSON.nodes.map((n, i) => [i, n]));
  const added = [], removed = [], moved = [];
  for (const [i, n] of after) {
    if (!before.has(i)) added.push(n);
    else if (before.get(i).x !== n.x || before.get(i).y !== n.y) moved.push(n);
  }
  for (const [i, n] of before) if (!after.has(i)) removed.push(n);
  return { added, removed, moved };
}

const snapA = flow.toJSON();
// ... user makes changes ...
const snapB = flow.toJSON();
const delta = diff(snapA, snapB);
console.log(`+${delta.added.length} -${delta.removed.length} ~${delta.moved.length}`);
```

---

## Recipe 7: Custom right-click menu

```js
flow.canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const wp = flow._s2w(e.clientX, e.clientY);
  const nid = flow.w.hitTestNode(wp.x, wp.y);
  if (nid !== -1) {
    flow._showMenu(e.clientX, e.clientY, [
      { label: 'Rename',    run: () => flow.editNodeExpression(nid, 'title') },
      { label: 'Duplicate', run: () => { flow.setSelected(nid, true); flow.duplicateSelection(); } },
      { label: 'Pin',       run: () => flow.lockNode(nid, true) },
      { label: 'Run from',  run: () => flow.runFrom(nid) },
      { label: 'Delete',    run: () => { flow.setSelected(nid, true); flow.deleteSelection(); } },
    ]);
  }
}, true);   // capture phase to override the default menu
```

---

## Recipe 8: Build a chat with kinds (LLM-driven flow)

```js
flow.registerKind({
  name: 'llm-prompt',
  html: true,
  template: '<textarea class="prompt" style="width:100%;height:80%;background:#0b0f17;color:white;border:0;padding:8px;font-family:inherit;font-size:13px;resize:none;"></textarea><button class="run" style="position:absolute;bottom:8px;right:8px;background:#5b8def;color:white;border:0;padding:5px 10px;border-radius:4px;">Run</button>',
  w: 320, h: 180, nin: 0, nout: 1, portOut: ['response'],
  execute: async (ctx) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': YOUR_KEY },
      signal: ctx.signal,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: ctx.params.prompt }],
      }),
    });
    const data = await r.json();
    return { response: data.content[0].text };
  },
});

const llm = flow.addNode({ kind: 'llm-prompt' });
requestAnimationFrame(() => {
  const el = flow._htmlOverlays.get(llm);
  el.querySelector('.run').onclick = () => {
    const prompt = el.querySelector('.prompt').value;
    flow.setNodeParams(llm, { prompt });
    flow.runFrom(llm);
  };
});
```

(In production, route through your backend so the API key isn't in the browser.)

---

## Recipe 9: Export as image

```js
async function exportAsImage(format = 'png') {
  if (format === 'svg') {
    const svg = flow.exportSVG();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    return URL.createObjectURL(blob);
  }
  const blob = await flow.exportPNG();
  return URL.createObjectURL(blob);
}

document.getElementById('export').onclick = async () => {
  const url = await exportAsImage('png');
  const a = document.createElement('a');
  a.href = url;
  a.download = 'graph.png';
  a.click();
};
```

---

## Recipe 10: Save to a backend, load on mount

```js
async function load() {
  const r = await fetch('/api/graphs/current');
  if (!r.ok) return;
  flow.loadJSON(await r.json());
}

let saveTimer = null;
flow.on('change', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch('/api/graphs/current', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(flow.toJSON()),
    });
  }, 800);   // debounce: only save 800ms after the last edit
});

await load();
```

---

## Next

→ [API Reference](./08-api.md) — every method, every event
