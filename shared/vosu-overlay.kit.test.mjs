// Copyright (c) 2026 18-LAB. MIT.
// node --test shared/  — the kit helpers: number conventions, unknown values, KPS, map time, beat clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASH, UNKNOWN, known, isKnown, formatNumber, numberFormatter, NUMBER_FORMATS,
  createKps, KPS_WINDOW_MS, createMapClock, createBeatClock, motionLevel, applyKitSettings,
  mapChroma, YOU_HUE, keyLabels, ellipsize, splitTitle, fitFields, ELLIPSIS, NAME_KEEP,
} from './vosu-overlay.js';

test('number conventions: comma grouping, fixed decimals per quantity, real minus, signed deltas', () => {
  assert.equal(formatNumber(1395), '1,395');
  assert.equal(formatNumber(3683232), '3,683,232');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(1000005), '1,000,005');
  assert.equal(formatNumber(10007), '10,007');
  assert.equal(formatNumber(0.05, 'stars'), '0.05');
  assert.equal(formatNumber(100, 'accuracy'), '100.00');
  assert.equal(formatNumber(1.25, 'rate'), '1.25');
  assert.equal(formatNumber(1.05, 'rate'), '1.05');
  assert.equal(formatNumber(1075.34, 'pp'), '1,075');
  assert.equal(formatNumber(7.006, 'stars'), '7.01');
  assert.equal(formatNumber(99.6, 'accuracy'), '99.60');
  assert.equal(formatNumber(87.44, 'ur'), '87.4');
  assert.equal(formatNumber(-1.44, 'ms'), '\u22121.4');
  assert.equal(formatNumber(3.2, 'ms'), '+3.2');
  assert.equal(formatNumber(0.04, 'ms'), '\u00b10.0');
  assert.equal(formatNumber(-0.04, 'ms'), '\u00b10.0');
  assert.equal(formatNumber(-88938, 'delta'), '\u221288,938');
  assert.equal(formatNumber(12, 'delta'), '+12');
  assert.equal(formatNumber(-3, 'count'), '\u22123');
  assert.equal(formatNumber(9, 'stat'), '9');
  assert.equal(formatNumber(10.333, 'stat'), '10.3');
  assert.equal(formatNumber(1.5, 'rate'), '1.5');
  assert.equal(formatNumber(0.75, 'rate'), '0.75');
  assert.equal(formatNumber(1, 'rate'), '1');
  assert.equal(formatNumber(12.34, 'ratio'), '12.3');
  assert.equal(formatNumber(Infinity, 'ratio'), '\u221e');
  assert.equal(formatNumber(0.7, 'px'), '0.7');
  assert.throws(() => formatNumber(1, 'nope'), TypeError);
  for (const kind of Object.keys(NUMBER_FORMATS)) assert.equal(typeof formatNumber(1234.5, kind), 'string');
});

test('unknown is never 0: absent, null, non-finite and "zero means not computed" render as a dash', () => {
  for (const value of [undefined, null, NaN, Infinity, '12']) assert.equal(formatNumber(value), DASH);
  assert.ok(Number.isNaN(UNKNOWN));
  assert.equal(known(0), 0);
  assert.ok(Number.isNaN(known(0, true))); // e.g. the replay renderer's pp fc / maxAchievable
  assert.ok(Number.isNaN(known(null)));
  assert.ok(Number.isNaN(known(undefined)));
  assert.equal(known(412.5, true), 412.5);
  assert.equal(isKnown(0), true);
  assert.equal(isKnown(UNKNOWN), false);
  assert.equal(formatNumber(known(0, true), 'pp'), DASH);
});

test('numberFormatter returns the same string until the shown value changes', () => {
  const format = numberFormatter('accuracy');
  const a = format(99.601);
  assert.equal(a, '99.60');
  assert.equal(format(99.6049), a);
  assert.ok(format(99.6049) === a, 'unchanged value keeps the same string object');
  assert.equal(format(99.61), '99.61');
  assert.equal(format(undefined), DASH);
  const counts = numberFormatter('count');
  assert.equal(counts(1395), '1,395');
  assert.ok(counts(1395) === counts(1395.2));
});

/** keys.all as vosu sends it: one entry per key with count and the latest press time (map ms). */
function keys(...entries) {
  return entries.map(([count, pressedAt]) => ({ name: 'B', isPressed: false, count, pressedAt, releasedAt: pressedAt + 30 }));
}

test('KPS counts presses in the last real second of gameplay time, then decays as they age out', () => {
  const kps = createKps();
  const state = [[0, null], [0, null]];
  kps.ingest(keys(...state), 0, 1); // baseline
  let t = 1000;
  for (let i = 0; i < 10; i++) {
    t += 100; // ten presses 100 ms apart, alternating keys
    state[i % 2] = [state[i % 2][0] + 1, t];
    kps.ingest(keys(...state), t, 1);
  }
  assert.equal(kps.at(t), 10);
  assert.equal(kps.peak, 10);
  assert.equal(kps.total, 10);
  assert.equal(kps.expiresAt, 1100 + KPS_WINDOW_MS);
  assert.equal(kps.at(t + 450), 6); // window (1450, 2450]: presses at 1100…1400 left it
  assert.equal(kps.at(t + 2000), 0);
  assert.equal(kps.peak, 10, 'peak holds');
});
test('KPS window is one second of real time: under DT it spans 1.5 s of map time', () => {
  const kps = createKps();
  kps.ingest(keys([0, null]), 0, 1.5);
  for (let i = 1; i <= 15; i++) kps.ingest(keys([i, i * 100]), i * 100, 1.5);
  assert.equal(kps.at(1500), 15);
  assert.equal(kps.at(1600), 14);
});

test('KPS: attaching mid-attempt, bursts of missed data and retries never invent a peak', () => {
  const kps = createKps();
  kps.ingest(keys([400, 60000]), 60000, 1); // attached late: baseline only
  assert.equal(kps.at(60000), 0);
  kps.ingest(keys([430, 60016]), 60016, 1); // +30 in one sample: missed data
  assert.equal(kps.at(60016), 0);
  assert.equal(kps.total, 430);
  kps.ingest(keys([431, 60100]), 60100, 1);
  assert.equal(kps.at(60100), 1);
  kps.ingest(keys([0, null]), 0, 1); // retry: counts fell
  assert.equal(kps.peak, 0);
  assert.equal(kps.at(0), 0);
  kps.ingest(keys([1, 500]), 500, 1);
  assert.equal(kps.at(500), 1);
});

test('KPS without keys.all (tosu) is unknown, not zero', () => {
  const kps = createKps();
  kps.ingest(undefined, 1000, 1);
  assert.ok(Number.isNaN(kps.at(1000)));
  assert.equal(formatNumber(kps.at(1000), 'kps'), DASH);
});

test('map time: first to last object in real time, lead-in at zero, rate-aware, extrapolated between samples', () => {
  const clock = createMapClock();
  clock.sample(500, 1.5, 1500, 151500, 160000, 0);
  assert.equal(clock.total(), 100000);
  assert.equal(clock.elapsed(500), 0); // lead-in
  assert.equal(clock.elapsed(31500), 20000);
  assert.equal(clock.progress(76500), 0.5);
  assert.equal(clock.elapsed(999999), 100000);
  assert.equal(clock.now(50), 500, 'first sample: not known to be moving');
  clock.sample(530, 1.5, 1500, 151500, 160000, 20);
  assert.equal(clock.now(60), 530 + 40 * 1.5);
  assert.equal(clock.now(10000), 530 + 120 * 1.5, 'extrapolation is capped');
  clock.sample(530, 1.5, 1500, 151500, 160000, 40);
  assert.equal(clock.now(100), 530, 'a clock that stopped is not extrapolated');
});

test('map time without objects falls back to the audio length, and without either is unknown', () => {
  const clock = createMapClock();
  clock.sample(30000, null, 0, 0, 120000, 0);
  assert.equal(clock.total(), 120000);
  assert.equal(clock.progress(30000), 0.25);
  clock.sample(30000, 1, 0, 0, 0, 0);
  assert.ok(Number.isNaN(clock.total()));
  assert.ok(Number.isNaN(clock.elapsed(30000)));
});

test('beat clock: one /json/sc load per checksum, phase against map time, segments by red line', async () => {
  const loads = [];
  let changed = 0;
  const beat = createBeatClock({
    onChange: () => changed++,
    load: async checksum => { loads.push(checksum); return [{ startTime: 10000, beatLength: 250 }, { startTime: 1000, beatLength: 500 }, { startTime: 5, beatLength: -100 }]; },
  });
  assert.equal(beat.at(2000), false, 'no beat before the points arrive');
  beat.setMap('a');
  beat.setMap('a');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(loads, ['a']);
  assert.equal(changed, 1);
  assert.equal(beat.at(2250), true);
  assert.equal(beat.index, 2);
  assert.equal(beat.phase, 0.5);
  assert.equal(beat.at(10125), true);
  assert.equal(beat.index, 0);
  assert.equal(beat.phase, 0.5);
  assert.equal(beat.beatLength, 250);
  assert.equal(beat.at(1500), true, 'walks back to the earlier segment');
  assert.equal(beat.beatLength, 500);
  assert.equal(beat.at(750), true);
  assert.equal(beat.index, -1, 'before the first red line beats count backwards');
  beat.setMap('b');
  beat.setMap('a');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(loads, ['a', 'b'], 'cached per checksum');
  assert.equal(beat.at(2250), true);
});

test('beat clock without /json/sc (tosu, replay renderer) reports kiai only', async () => {
  const beat = createBeatClock({ load: async () => null });
  beat.setMap('x');
  beat.setKiai(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(beat.hasBeat, false);
  assert.equal(beat.at(5000), false);
  assert.equal(beat.kiai, true);
});

test('beat clock asks /json/sc and rejects an answer for another map', async () => {
  const original = globalThis.fetch;
  try {
    let md5 = 'other';
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ md5, mapTimingPoints: [{ startTime: 0, beatLength: 400 }] }) });
    const beat = createBeatClock();
    beat.setMap('mine');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(beat.hasBeat, false, 'answer for another map is ignored');
    md5 = 'mine';
    await new Promise(resolve => setTimeout(resolve, 1100)); // one retry
    assert.equal(beat.hasBeat, true);
    globalThis.fetch = async () => ({ ok: false });
    const tosu = createBeatClock();
    tosu.setMap('t');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(tosu.hasBeat, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('motion and kit settings normalise to data attributes', () => {
  assert.equal(motionLevel('reduced'), 'reduced');
  assert.equal(motionLevel('off'), 'off');
  assert.equal(motionLevel(undefined), 'full');
  assert.equal(motionLevel('bogus'), 'full');
  const element = { dataset: {} };
  assert.equal(applyKitSettings(element, { motion: 'off', backing: 'panel', mapTint: false }), 'off');
  assert.deepEqual({ ...element.dataset }, { motion: 'off', backing: 'panel', mapTint: 'off' });
  applyKitSettings(element, {});
  assert.deepEqual({ ...element.dataset }, { motion: 'full', backing: 'scrim', mapTint: 'on' });
});

test('marks: a known value is written to data-marks, anything else leaves the default (neutral)', () => {
  const element = { dataset: {} };
  applyKitSettings(element, { marks: 'tl' });
  assert.equal(element.dataset.marks, 'tl');
  applyKitSettings(element, { marks: 'none' });
  assert.equal(element.dataset.marks, 'none');
  const fresh = { dataset: {} };
  applyKitSettings(fresh, { marks: 'bogus' });
  assert.equal(fresh.dataset.marks, undefined);
});

test('map tint: hues within 30° of amber lose their chroma, others keep it', async () => {
  assert.equal(mapChroma(YOU_HUE, 36), 8);
  assert.equal(mapChroma(YOU_HUE + 29, 36), 8);
  assert.equal(mapChroma(YOU_HUE - 29, 24), 8);
  assert.equal(mapChroma(YOU_HUE + 31, 36), 36);
  assert.equal(mapChroma(YOU_HUE + 180, 36), 36);
  assert.equal(mapChroma(YOU_HUE - 360, 16), 8, 'hue wraps around');
  const { Hct } = await import('./m3.js');
  assert.ok(Math.abs(Hct.fromInt(0xffff963f).hue - YOU_HUE) < 0.01, 'YOU_HUE is --you\'s HCT hue');
});

test('key labels: one scheme per ruleset, cached', () => {
  assert.deepEqual(keyLabels('osu', 2).short, ['K1', 'K2']);
  assert.deepEqual(keyLabels('osu', 3).short, ['K1', 'K2', 'SMOKE'], "the third osu! key is smoke, not a mouse button");
  assert.deepEqual(keyLabels('taiko', 4).short, ['L·KAT', 'L·DON', 'R·DON', 'R·KAT']);
  assert.deepEqual(keyLabels('fruits', 3).short, ['LEFT', 'RIGHT', 'DASH']);
  assert.deepEqual(keyLabels('fruits', 1).short, ['DASH']);
  assert.deepEqual(keyLabels('mania', 7).short, ['1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(keyLabels('mania', 4).long, ['Key 1', 'Key 2', 'Key 3', 'Key 4']);
  assert.equal(keyLabels('taiko', 4), keyLabels('taiko', 4));
  assert.ok(Object.isFrozen(keyLabels('osu', 2).short));
});

test('ellipsize: a real ellipsis, trailing punctuation and spaces trimmed before it', () => {
  assert.equal(ellipsize('Nanahira, moimoi', 10), `Nanahira${ELLIPSIS}`);
  assert.equal(ellipsize('FREEDOM DiVE', 20), 'FREEDOM DiVE');
  assert.equal(ellipsize('covered by (x', 13), 'covered by (x');
  assert.equal(ellipsize('covered by (xyz)', 13), `covered by${ELLIPSIS}`);
  assert.ok(!ellipsize('abc...def', 5).includes('...'));
});

test('splitTitle: a trailing bracketed suffix is its own part', () => {
  assert.deepEqual(splitTitle('FLYING OUT TO THE SKY (covered by Nanahira, moimoi)'), { main: 'FLYING OUT TO THE SKY', suffix: '(covered by Nanahira, moimoi)' });
  assert.deepEqual(splitTitle('Blue Zenith [TV Size]'), { main: 'Blue Zenith', suffix: '[TV Size]' });
  assert.deepEqual(splitTitle('FREEDOM DiVE'), { main: 'FREEDOM DiVE', suffix: '' });
});

test('fitFields: the field that gives way first shrinks, names under 16 characters never do', () => {
  const width = budget => texts => texts.filter(Boolean).join(' ').length <= budget;
  const fields = [
    { text: 'FLYING OUT TO THE SKY', order: 2, keep: 8 },
    { text: '(covered by Nanahira, moimoi)', order: 1, keep: 0 },
    { text: 'linedcolt', order: 3, keep: NAME_KEEP },
  ];
  const [title, suffix, mapper] = fitFields(fields, width(50));
  assert.equal(mapper, 'linedcolt');
  assert.equal(title, 'FLYING OUT TO THE SKY');
  assert.ok(suffix.endsWith(ELLIPSIS) && suffix.length < fields[1].text.length);
  const tight = fitFields(fields, width(31));
  assert.equal(tight[1], '', 'the suffix is dropped entirely before the title is cut');
  assert.equal(tight[0], 'FLYING OUT TO THE SKY');
  assert.equal(tight[2], 'linedcolt');
  const tighter = fitFields(fields, width(20));
  assert.equal(tighter[2], 'linedcolt', 'a short name is never cut');
  assert.ok(tighter[0].endsWith(ELLIPSIS));
});

test('fitFields: a droppable field goes whole instead of leaving a one- or two-letter stub', () => {
  const width = budget => texts => texts.filter(Boolean).join(' ').length <= budget;
  const fields = [
    { text: 'Peer Gynt', order: 2, keep: 8 },
    { text: '(Cut Ver.)', order: 0, keep: 0 },
  ];
  // "Peer Gynt" + " " leaves 3 code units: room for "(C…" but not for a three-letter stub.
  const [title, suffix] = fitFields(fields, width(13));
  assert.equal(title, 'Peer Gynt');
  assert.equal(suffix, '');
  const roomy = fitFields(fields, width(14));
  assert.equal(roomy[1], '(Cu' + ELLIPSIS, 'three characters before the ellipsis still show');
});
