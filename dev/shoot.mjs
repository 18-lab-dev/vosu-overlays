#!/usr/bin/env node
// Copyright (c) 2026 18-LAB. MIT.
// Screenshots an overlay on the mock vosu stage across scenarios and measures its live cost.
//
//   node dev/shoot.mjs --port 24100 --id hit-error [--out /tmp/shots/hit-error]
//        [--cases "mode=osu&state=play&freeze=60000;state=offline"] [--perf mode=mania&state=play] [--dpr 1] [--settle 900]
//
// Requires a running `bun dev/mock-vosu.js --port <port>`. Playwright is resolved from
// $PLAYWRIGHT (path to playwright's index.mjs) or the `playwright` package.
// Default cases: every ruleset in menu, mid-play (frozen at 60 s) and results; offline; and
// osu!/mania with vosu extensions disabled. --perf runs a live attempt for 5 s starting 110 s
// into the map, so hit-error/key histories are already long (~2000 events) and keep growing.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const port = Number(arg('port', 24100));
const id = arg('id');
if (!id) throw new Error('--id <overlay> is required');
const out = arg('out', `/tmp/overlay-shots/${id}`);
const dpr = Number(arg('dpr', 1));
// Milliseconds to let the page run before each capture; raise it for live cases whose
// visuals accumulate (trails, scrolling bars).
const settle = Number(arg('settle', 900));
// --layout 1 forces the wireframe stage (previews), 0 hides it; default: backdrop if available.
const layout = arg('layout', '');
// --stage "<query>" adds stage parameters, e.g. "cell=474x1080&x=0&y=20&w=474&h=240" for a
// replay-renderer cell, "guide=1" for the focus ellipse, or "x=..&y=.." to override placement.
const stageQuery = arg('stage', '');
const base = `http://127.0.0.1:${port}`;
const defaults = [];
for (const mode of ['osu', 'taiko', 'fruits', 'mania']) {
  defaults.push(`mode=${mode}&state=menu&freeze=0`, `mode=${mode}&state=play&freeze=60000`, `mode=${mode}&state=results&freeze=0`);
}
defaults.push('mode=mania&state=play&keys=7&freeze=60000', 'mode=osu&state=play&ext=0&freeze=60000', 'mode=mania&state=play&ext=0&freeze=60000', 'mode=fruits&state=results&catchHits=legacy&freeze=0', 'mode=osu&state=offline', 'mode=osu&state=down');
const cases = (arg('cases') ? arg('cases').split(';') : defaults).filter(Boolean);
const perf = arg('perf', 'mode=mania&state=play&keys=7&start=110000');

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright').catch(() =>
  import(`${process.env.HOME}/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1984, height: 1144 } });
const page = await context.newPage();
// Keep runs offline and deterministic: avatars come from a.ppy.sh; overlays must show their fallback.
await context.route('https://a.ppy.sh/**', route => route.abort());
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
// A failed request (e.g. an optional /files/skin/skin.ini that returns 404) is network noise the
// overlay may handle on purpose, not a script error; list it separately.
const network = [];
page.on('console', message => {
  if (message.type() !== 'error') return;
  (message.text().startsWith('Failed to load resource') ? network : errors).push(message.text());
});
page.on('requestfailed', request => network.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));
page.on('response', response => { if (response.status() >= 400) network.push(`${response.status()} ${response.url()}`); });

const reset = async query => {
  // Baseline every unspecified dimension so cases do not inherit each other's toggles.
  const full = new URLSearchParams({ mode: 'osu', state: 'play', client: 'stable', keys: '4', ext: '1', freeze: '', speed: '1', start: '0', catchHits: 'vosu' });
  for (const [k, v] of new URLSearchParams(query)) full.set(k, v);
  await fetch(`${base}/__dev/scenario?${full}`);
};

async function stage() {
  await page.goto(`${base}/__dev/stage?id=${encodeURIComponent(id)}${layout ? `&layout=${encodeURIComponent(layout)}` : ''}${stageQuery ? `&${stageQuery}` : ''}`);
  const size = await page.evaluate(() => ({ width: document.body.offsetWidth, height: document.body.offsetHeight }));
  await page.setViewportSize(size);
  await page.waitForTimeout(settle);
  // Each overlay page's box and whether its centre lies inside the gameplay focus ellipse.
  return page.evaluate(() => JSON.parse(document.getElementById('placements')?.textContent || '[]'));
}

for (const query of cases) {
  await reset(query);
  const boxes = await stage();
  const name = query.replace(/freeze=\d*&?|&$/g, '').replace(/[=&]/g, '-').replace(/-+$/, '');
  const file = join(out, `${name}.png`);
  // Right after a viewport resize Chromium can refuse a capture until the compositor produces
  // a frame (seen under heavy parallel load); retry rather than abort the whole run.
  for (let attempt = 1; ; attempt++) {
    try { await page.screenshot({ path: file }); break; } catch (error) {
      if (attempt >= 5) throw error;
      await page.waitForTimeout(600);
    }
  }
  console.log(file, boxes.map(b => `${b.id} ${b.width}x${b.height}@${b.x},${b.y}${b.centreInFocus ? ' CENTRE-IN-FOCUS' : ''}`).join(' | '));
}

if (perf !== 'none') {
  await reset(perf);
  await stage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const frame = page.frames().find(f => f.url().includes(`/${id}/`));
  await frame.evaluate(() => { window.__frames = 0; const loop = () => { window.__frames++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  // Allocation sampling over the same window, counting objects already collected, so the rate
  // includes short-lived garbage. Built-ins (JSON.parse, Array.from) have no script URL; their
  // samples are charged to the nearest caller with one.
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const before = await metrics();
  const seconds = 5;
  await page.waitForTimeout(seconds * 1000);
  const after = await metrics();
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const frames = await frame.evaluate(() => window.__frames);
  const per = key => Math.round(((after[key] - before[key]) * 1000 / seconds) * 100) / 100;
  const alloc = { overlay: 0, client: 0, other: 0 };
  const sites = new Map();
  const walk = (node, owner) => {
    const { url, functionName, lineNumber } = node.callFrame;
    const here = url ? { url, at: `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}` } : owner;
    if (node.selfSize && here) {
      const bucket = !here.url.includes(`/${id}/`) ? 'other' : /\/(vosu-overlay|m3)\.js$/.test(here.url) ? 'client' : 'overlay';
      alloc[bucket] += node.selfSize;
      if (bucket !== 'other') sites.set(here.at, (sites.get(here.at) ?? 0) + node.selfSize);
    } else if (node.selfSize) alloc.other += node.selfSize;
    for (const child of node.children) walk(child, here);
  };
  walk(profile.head, null);
  const kbps = bytes => Math.round(bytes / 1024 / seconds * 10) / 10;
  console.log(JSON.stringify({
    perf: perf,
    msPerSecond: { script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration'), task: per('TaskDuration') },
    fps: Math.round(frames / seconds),
    layouts: after.LayoutCount - before.LayoutCount,
    allocKBps: { overlay: kbps(alloc.overlay), client: kbps(alloc.client), harness: kbps(alloc.other) },
    allocSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([at, bytes]) => `${kbps(bytes)} KB/s ${at}`),
    heapMB: Math.round(after.JSHeapUsedSize / 1048576 * 10) / 10,
    nodes: after.Nodes,
  }));
}
if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
if (network.length) console.log('NETWORK (not page errors):\n' + [...new Set(network.filter(line => !line.startsWith('Failed to load resource')))].join('\n'));
await browser.close();
