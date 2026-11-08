#!/usr/bin/env node
// Copyright (c) 2026 18-LAB. MIT.
// Screenshots an overlay on the mock vosu stage across scenarios and measures its live cost.
//
//   node dev/shoot.mjs --port 24100 --id hit-error [--out /tmp/shots/hit-error]
//        [--cases "mode=osu&state=play&freeze=60000;state=offline"] [--perf mode=mania&state=play] [--dpr 1]
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
const base = `http://127.0.0.1:${port}`;
const defaults = [];
for (const mode of ['osu', 'taiko', 'fruits', 'mania']) {
  defaults.push(`mode=${mode}&state=menu&freeze=0`, `mode=${mode}&state=play&freeze=60000`, `mode=${mode}&state=results&freeze=0`);
}
defaults.push('mode=mania&state=play&keys=7&freeze=60000', 'mode=osu&state=play&ext=0&freeze=60000', 'mode=mania&state=play&ext=0&freeze=60000', 'mode=osu&state=offline');
const cases = (arg('cases') ? arg('cases').split(';') : defaults).filter(Boolean);
const perf = arg('perf', 'mode=mania&state=play&keys=7&start=110000');

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright').catch(() =>
  import(`${process.env.HOME}/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1984, height: 1144 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const reset = async query => {
  // Baseline every unspecified dimension so cases do not inherit each other's toggles.
  const full = new URLSearchParams({ mode: 'osu', state: 'play', client: 'stable', keys: '4', ext: '1', freeze: '', speed: '1', start: '0' });
  for (const [k, v] of new URLSearchParams(query)) full.set(k, v);
  await fetch(`${base}/__dev/scenario?${full}`);
};

async function stage() {
  await page.goto(`${base}/__dev/stage?id=${encodeURIComponent(id)}`);
  const size = await page.evaluate(() => ({ width: document.body.offsetWidth, height: document.body.offsetHeight }));
  await page.setViewportSize(size);
  await page.waitForTimeout(900);
}

for (const query of cases) {
  await reset(query);
  await stage();
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
  console.log(file);
}

if (perf !== 'none') {
  await reset(perf);
  await stage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const frame = page.frames().find(f => f.url().includes(`/${id}/`));
  await frame.evaluate(() => { window.__frames = 0; const loop = () => { window.__frames++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
  const before = await metrics();
  const seconds = 5;
  await page.waitForTimeout(seconds * 1000);
  const after = await metrics();
  const frames = await frame.evaluate(() => window.__frames);
  const per = key => Math.round(((after[key] - before[key]) * 1000 / seconds) * 100) / 100;
  console.log(JSON.stringify({
    perf: perf,
    msPerSecond: { script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration'), task: per('TaskDuration') },
    fps: Math.round(frames / seconds),
    layouts: after.LayoutCount - before.LayoutCount,
    heapMB: Math.round(after.JSHeapUsedSize / 1048576 * 10) / 10,
    nodes: after.Nodes,
  }));
}
if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
await browser.close();
