// Copyright (c) 2026 18-LAB. MIT.
// node --test shared/  — the shared client's pure logic, with vosu's skin file route stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maniaSkin, osuLayout } from './vosu-overlay.js';

let served = '';
globalThis.fetch = async () => ({ ok: served !== null, text: async () => served });
// Each call uses a fresh cache key: the client caches skin.ini per skin name.
let skin = 0;
const read = async (ini, keys) => { served = ini; return maniaSkin(keys, `skin-${skin++}`); };

test('a key count without its own [Mania] section gets stable defaults, not a zero-width stage', async () => {
  const stage = await read('[Mania]\nKeys: 4\nColumnWidth: 65,65,65,65\nColumnStart: 286.67\n', 7);
  assert.deepEqual(stage.columnWidth, Array(7).fill(30));
  assert.equal(stage.columnStart, 136);
  assert.deepEqual(stage.columnSpacing, Array(6).fill(0));
  assert.equal(osuLayout('mania', { keys: 7, ...stage }).busy.w, Math.round(7 * 30 * 2.25));
});

test('a section that omits ColumnWidth keeps the 30-unit default width', async () => {
  const stage = await read('[Mania]\nKeys: 4\nColumnStart: 200\n', 4);
  assert.deepEqual(stage.columnWidth, [30, 30, 30, 30]);
  assert.equal(stage.columnStart, 200);
});

test('blank and missing list entries take the default per position; widths below 1 are invalid', async () => {
  const stage = await read('[Mania]\nKeys: 4\nColumnWidth: 50,,0\nColumnSpacing: 4\n', 4);
  assert.deepEqual(stage.columnWidth, [50, 30, 30, 30]);
  assert.deepEqual(stage.columnSpacing, [4, 0, 0]);
});

test('the matching section wins and its geometry places the stage like the skin renders it', async () => {
  const ini = '[General]\nName: x\n[Mania]\nKeys: 4\nColumnWidth: 65,65,65,65\nColumnSpacing: 4,4,4\nColumnStart: 286.67\n[Mania]\nKeys: 7\nColumnWidth: 55,55,55,55,55,55,55\nColumnStart: 216.67\n';
  const stage = await read(ini, 4);
  const layout = osuLayout('mania', { keys: 4, ...stage });
  // 286.67 × 2.25 ≈ 645 and (4·65 + 3·4) × 2.25 = 612, matching the 4K render (x 645–1256).
  assert.equal(layout.busy.x, 645);
  assert.equal(layout.busy.w, 612);
  assert.equal(layout.columns[1].x, Math.round(645 + 69 * 2.25));
});

test('no skin.ini (lazer built-in, tosu, file access off) resolves to null', async () => {
  assert.equal(await read(null, 4), null);
});
