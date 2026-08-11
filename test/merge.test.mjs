// Tests for HealthLog's core logic.
//
// The core lives inside index.html so the app stays a single self-contained
// file with no build step. This extracts the marked block verbatim and loads
// it as a CommonJS module — so what is tested is exactly what ships.
//
//   node test/merge.test.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = html.match(/\/\/ ==== CORE START ====([\s\S]*?)\/\/ ==== CORE END ====/);
if (!block) { console.error('Could not find CORE block in index.html'); process.exit(1); }

const tmp = join(tmpdir(), `healthlog-core-${process.pid}.cjs`);
writeFileSync(tmp, block[1]);
const core = createRequire(import.meta.url)(tmp);

const {
  newer, mergeById, mergeStore, live, toLocalIso, dayKey, todayKey, daysAgoKey,
  DEFAULT_METRICS, evaluate, evaluateReading, computeStats, dayProgress, toCSV, seriesFor,
} = core;

/* ------------------------------- runner ------------------------------- */
let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(['ok', name]); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
const ids = xs => xs.map(x => x.id).sort();
const byId = xs => Object.fromEntries(xs.map(x => [x.id, x]));

/* ------------------------------- helpers ------------------------------ */
let seq = 0;
function rec(id, updatedAt, extra = {}) {
  return { id, updatedAt, deviceId: extra.deviceId ?? 'dev-a', ...extra };
}
function reading(o = {}) {
  const n = ++seq;
  return {
    id: o.id ?? 'r' + n,
    patientId: o.patientId ?? 'p1',
    metricId: o.metricId ?? 'glucose',
    slotId: o.slotId ?? null,
    tag: o.tag ?? null,
    values: o.values ?? { mgdl: 110 },
    takenAt: o.takenAt ?? toLocalIso(new Date()),
    note: o.note ?? '',
    recordedBy: o.recordedBy ?? 'tester',
    createdAt: o.createdAt ?? '2026-01-01T00:00:00+00:00',
    updatedAt: o.updatedAt ?? '2026-01-01T00:00:00+00:00',
    deviceId: o.deviceId ?? 'dev-a',
    deleted: o.deleted ?? false,
  };
}
const patient = () => ({ id: 'p1', name: 'Test', metrics: DEFAULT_METRICS(), deleted: false });
// Build a takenAt N days back at a given local time, so tests are timezone-independent.
function daysBack(n, hh = 8, now = new Date()) {
  const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(hh, 0, 0, 0);
  return toLocalIso(d);
}

/* =========================== merge: the core =========================== */

test('concurrent adds on two devices both survive', () => {
  const a = [reading({ id: 'a1', deviceId: 'phone-a' })];
  const b = [reading({ id: 'b1', deviceId: 'phone-b' })];
  assert.deepEqual(ids(mergeById(a, b)), ['a1', 'b1']);
});

test('merge is commutative', () => {
  const a = [rec('x', '2026-01-02T00:00:00+00:00', { deviceId: 'a' }), rec('y', '2026-01-01T00:00:00+00:00')];
  const b = [rec('x', '2026-01-03T00:00:00+00:00', { deviceId: 'b' }), rec('z', '2026-01-01T00:00:00+00:00')];
  assert.deepEqual(byId(mergeById(a, b)), byId(mergeById(b, a)));
});

test('merge is commutative even when updatedAt ties (deviceId breaks it)', () => {
  const t = '2026-01-02T00:00:00+00:00';
  const a = [rec('x', t, { deviceId: 'aaa', v: 1 })];
  const b = [rec('x', t, { deviceId: 'zzz', v: 2 })];
  assert.deepEqual(mergeById(a, b), mergeById(b, a));
  assert.equal(mergeById(a, b)[0].v, 2, 'higher deviceId wins deterministically');
});

test('merge is idempotent', () => {
  const a = [rec('x', '2026-01-02T00:00:00+00:00'), rec('y', '2026-01-01T00:00:00+00:00')];
  const b = [rec('x', '2026-01-03T00:00:00+00:00', { deviceId: 'b' })];
  const once = mergeById(a, b);
  assert.deepEqual(byId(mergeById(once, once)), byId(once));
  assert.deepEqual(byId(mergeById(once, b)), byId(once));
});

test('merge is associative', () => {
  const a = [rec('x', '2026-01-01T00:00:00+00:00', { deviceId: 'a' })];
  const b = [rec('x', '2026-01-02T00:00:00+00:00', { deviceId: 'b' }), rec('y', '2026-01-01T00:00:00+00:00')];
  const c = [rec('x', '2026-01-03T00:00:00+00:00', { deviceId: 'c' }), rec('z', '2026-01-01T00:00:00+00:00')];
  assert.deepEqual(byId(mergeById(mergeById(a, b), c)), byId(mergeById(a, mergeById(b, c))));
});

test('later edit wins over earlier version', () => {
  const old = reading({ id: 'r', values: { mgdl: 100 }, updatedAt: '2026-01-01T10:00:00+00:00' });
  const neu = reading({ id: 'r', values: { mgdl: 145 }, updatedAt: '2026-01-01T11:00:00+00:00', deviceId: 'dev-b' });
  assert.equal(mergeById([old], [neu])[0].values.mgdl, 145);
  assert.equal(mergeById([neu], [old])[0].values.mgdl, 145);
});

test('tombstone propagates when it is the later write', () => {
  const alive = reading({ id: 'r', updatedAt: '2026-01-01T10:00:00+00:00' });
  const dead = { ...alive, deleted: true, updatedAt: '2026-01-01T12:00:00+00:00', deviceId: 'dev-b' };
  assert.equal(mergeById([alive], [dead])[0].deleted, true);
  assert.equal(live(mergeById([alive], [dead])).length, 0);
});

test('an edit after a delete resurrects the reading', () => {
  const dead = reading({ id: 'r', deleted: true, updatedAt: '2026-01-01T10:00:00+00:00' });
  const edited = { ...dead, deleted: false, values: { mgdl: 99 }, updatedAt: '2026-01-01T14:00:00+00:00', deviceId: 'dev-b' };
  assert.equal(live(mergeById([dead], [edited])).length, 1);
});

test('mergeStore tolerates missing/empty sides', () => {
  const local = { patients: [rec('p', '2026-01-01T00:00:00+00:00')], readings: [reading({ id: 'r' })] };
  assert.deepEqual(byId(mergeStore(local, {}).readings), byId(local.readings));
  assert.deepEqual(byId(mergeStore(local, { patients: [], readings: [] }).patients), byId(local.patients));
  assert.deepEqual(byId(mergeStore({}, local).readings), byId(local.readings));
});

test('survives a JSON round-trip (what sync actually transmits)', () => {
  const a = [reading({ id: 'a1' })];
  const b = JSON.parse(JSON.stringify([reading({ id: 'b1', deviceId: 'dev-b' })]));
  assert.deepEqual(ids(mergeById(a, b)), ['a1', 'b1']);
});

test('full offline scenario: two people log, then both sync', () => {
  // Both start from a shared base.
  const base = { patients: [rec('p1', '2026-01-01T00:00:00+00:00')], readings: [reading({ id: 'shared' })] };
  // Both go offline and log independently.
  let phoneA = { ...base, readings: [...base.readings, reading({ id: 'fromA', deviceId: 'A' })] };
  let phoneB = { ...base, readings: [...base.readings, reading({ id: 'fromB', deviceId: 'B' })] };
  // A syncs first: pulls base, pushes A's version.
  let server = mergeStore(base, phoneA);
  // B syncs: pulls server, merges, pushes.
  phoneB = mergeStore(phoneB, server);
  server = mergeStore(server, phoneB);
  // A syncs again and picks up B's reading.
  phoneA = mergeStore(phoneA, server);
  assert.deepEqual(ids(live(phoneA.readings)), ['fromA', 'fromB', 'shared']);
  assert.deepEqual(ids(live(phoneB.readings)), ['fromA', 'fromB', 'shared']);
  assert.deepEqual(ids(live(server.readings)), ['fromA', 'fromB', 'shared']);
});

test('a device that never pulls cannot delete another device\'s reading', () => {
  // The bug a whole-document last-write-wins design would have.
  const server = { patients: [], readings: [reading({ id: 'theirs', deviceId: 'B' })] };
  const staleDevice = { patients: [], readings: [reading({ id: 'mine', deviceId: 'A' })] };
  assert.deepEqual(ids(mergeStore(staleDevice, server).readings), ['mine', 'theirs']);
});

test('newer() is a strict total order', () => {
  const x = rec('i', '2026-01-01T00:00:00+00:00', { deviceId: 'a' });
  const y = rec('i', '2026-01-01T00:00:00+00:00', { deviceId: 'b' });
  assert.equal(newer(x, x), false, 'irreflexive');
  assert.equal(newer(x, y) !== newer(y, x), true, 'antisymmetric for distinct devices');
});

/* ============================ alert ranges ============================ */

test('glucose thresholds differ by FF/PP tag', () => {
  const g = DEFAULT_METRICS().find(m => m.id === 'glucose');
  assert.equal(evaluate(g, 'mgdl', 150, 'FF'), 'warn', '150 fasting is above target');
  assert.equal(evaluate(g, 'mgdl', 150, 'PP'), 'ok', '150 after food is fine');
  assert.equal(evaluate(g, 'mgdl', 300, 'FF'), 'alert');
  assert.equal(evaluate(g, 'mgdl', 60, 'PP'), 'alert', 'hypo is an alert regardless of tag');
  assert.equal(evaluate(g, 'mgdl', 110, 'FF'), 'ok');
});

test('spo2 and pulse thresholds', () => {
  const [spo2, pulse] = [['spo2'], ['pulse']].map(([id]) => DEFAULT_METRICS().find(m => m.id === id));
  assert.equal(evaluate(spo2, 'pct', 97), 'ok');
  assert.equal(evaluate(spo2, 'pct', 94), 'warn');
  assert.equal(evaluate(spo2, 'pct', 90), 'alert');
  assert.equal(evaluate(spo2, 'pct', 100), 'ok', 'a high SpO2 must never alert');
  assert.equal(evaluate(pulse, 'bpm', 72), 'ok');
  assert.equal(evaluate(pulse, 'bpm', 130), 'alert');
});

test('a reading takes the worst status across its fields', () => {
  const bp = DEFAULT_METRICS().find(m => m.id === 'bp');
  assert.equal(evaluateReading(bp, { values: { sys: 120, dia: 80 } }), 'ok');
  assert.equal(evaluateReading(bp, { values: { sys: 120, dia: 95 } }), 'warn');
  assert.equal(evaluateReading(bp, { values: { sys: 190, dia: 80 } }), 'alert');
});

test('missing values never raise a false alert', () => {
  const bp = DEFAULT_METRICS().find(m => m.id === 'bp');
  assert.equal(evaluateReading(bp, { values: { sys: 120, dia: null } }), 'ok');
  assert.equal(evaluate(bp, 'sys', undefined), 'ok');
  assert.equal(evaluate(bp, 'sys', NaN), 'ok');
});

/* =============================== stats ================================ */

test('FF and PP glucose are averaged as separate series', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'glucose', tag: 'FF', values: { mgdl: 100 }, takenAt: daysBack(1) }),
    reading({ metricId: 'glucose', tag: 'FF', values: { mgdl: 110 }, takenAt: daysBack(2) }),
    reading({ metricId: 'glucose', tag: 'PP', values: { mgdl: 200 }, takenAt: daysBack(1) }),
    reading({ metricId: 'glucose', tag: 'PP', values: { mgdl: 220 }, takenAt: daysBack(2) }),
  ];
  const st = computeStats(rs, p, 7);
  const ff = st.find(s => s.key === 'glucose:FF'), pp = st.find(s => s.key === 'glucose:PP');
  assert.equal(ff.fields[0].avg, 105);
  assert.equal(pp.fields[0].avg, 210);
  assert.equal(ff.n, 2);
});

test('blood pressure averages systolic and diastolic separately', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'bp', values: { sys: 120, dia: 80 }, takenAt: daysBack(1) }),
    reading({ metricId: 'bp', values: { sys: 140, dia: 90 }, takenAt: daysBack(2) }),
  ];
  const bp = computeStats(rs, p, 7).find(s => s.key === 'bp');
  assert.equal(bp.fields[0].avg, 130);
  assert.equal(bp.fields[1].avg, 85);
});

test('the window excludes older readings', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'pulse', values: { bpm: 70 }, takenAt: daysBack(1) }),
    reading({ metricId: 'pulse', values: { bpm: 200 }, takenAt: daysBack(40) }),
  ];
  assert.equal(computeStats(rs, p, 7).find(s => s.key === 'pulse').n, 1);
  assert.equal(computeStats(rs, p, 0).find(s => s.key === 'pulse').n, 2, 'window 0 means all time');
});

test('deleted readings are excluded from stats', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'pulse', values: { bpm: 70 }, takenAt: daysBack(1) }),
    reading({ metricId: 'pulse', values: { bpm: 999 }, takenAt: daysBack(1), deleted: true }),
  ];
  const s = computeStats(rs, p, 7).find(x => x.key === 'pulse');
  assert.equal(s.n, 1);
  assert.equal(s.fields[0].avg, 70);
});

test('another patient\'s readings never leak into these stats', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'pulse', values: { bpm: 70 }, takenAt: daysBack(1) }),
    reading({ metricId: 'pulse', values: { bpm: 150 }, takenAt: daysBack(1), patientId: 'someone-else' }),
  ];
  assert.equal(computeStats(rs, p, 7).find(s => s.key === 'pulse').fields[0].avg, 70);
});

test('time-in-range counts only readings inside target', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'spo2', values: { pct: 98 }, takenAt: daysBack(1) }),
    reading({ metricId: 'spo2', values: { pct: 97 }, takenAt: daysBack(1) }),
    reading({ metricId: 'spo2', values: { pct: 90 }, takenAt: daysBack(1) }),
  ];
  assert.equal(computeStats(rs, p, 7).find(s => s.key === 'spo2').tir, 67);
});

test('trend compares against the preceding window, not all history', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'pulse', values: { bpm: 80 }, takenAt: daysBack(1) }),   // current 7d
    reading({ metricId: 'pulse', values: { bpm: 70 }, takenAt: daysBack(9) }),   // previous 7d
    reading({ metricId: 'pulse', values: { bpm: 999 }, takenAt: daysBack(60) }), // ignored
  ];
  assert.equal(computeStats(rs, p, 7).find(s => s.key === 'pulse').trend, 10);
});

test('series with no readings report n=0 rather than throwing', () => {
  const st = computeStats([], patient(), 7);
  assert.ok(st.length > 0);
  assert.ok(st.every(s => s.n === 0));
});

test('every metric produces at least one series', () => {
  for (const m of DEFAULT_METRICS()) assert.ok(seriesFor(m).length >= 1, m.id);
});

/* ========================= schedule / checklist ======================== */

test('daily checklist counts filled slots', () => {
  const p = patient();
  const today = todayKey();
  const g = p.metrics.find(m => m.id === 'glucose');
  const rs = [
    reading({ metricId: 'glucose', slotId: g.slots[0].id, tag: 'FF', takenAt: daysBack(0, 7) }),
    reading({ metricId: 'glucose', slotId: g.slots[1].id, tag: 'PP', takenAt: daysBack(0, 10) }),
  ];
  const prog = dayProgress(rs, p, today).find(x => x.metric.id === 'glucose');
  assert.equal(prog.total, 3);
  assert.equal(prog.done, 2);
  assert.equal(prog.extras.length, 0);
});

test('a reading with no slot counts as an extra, not a slot', () => {
  const p = patient();
  const rs = [reading({ metricId: 'glucose', slotId: null, takenAt: daysBack(0, 9) })];
  const prog = dayProgress(rs, p, todayKey()).find(x => x.metric.id === 'glucose');
  assert.equal(prog.done, 0);
  assert.equal(prog.extras.length, 1);
});

/* ============================ dates / export =========================== */

test('local date survives an ISO round-trip', () => {
  const d = new Date(2026, 7, 11, 23, 45, 0); // 11 Aug, late evening local
  const iso = toLocalIso(d);
  assert.equal(dayKey(iso), '2026-08-11', 'late-evening readings must not roll into the next day');
  assert.equal(iso.slice(11, 16), '23:45');
  assert.equal(new Date(iso).getTime(), d.getTime(), 'offset makes the instant unambiguous');
});

test('daysAgoKey walks back real calendar days', () => {
  const now = new Date(2026, 2, 3);           // 3 Mar — crosses a month boundary
  assert.equal(daysAgoKey(0, now), '2026-03-03');
  assert.equal(daysAgoKey(4, now), '2026-02-27');
});

test('CSV escapes commas, quotes and newlines', () => {
  const p = patient();
  const rs = [reading({ metricId: 'glucose', tag: 'FF', values: { mgdl: 110 }, note: 'felt "dizzy", then rested' })];
  const csv = toCSV(rs, [p]);
  assert.ok(csv.includes('"felt ""dizzy"", then rested"'));
  assert.equal(csv.split('\n').length, 2, 'header plus one row');
});

test('CSV skips deleted readings and unknown patients', () => {
  const p = patient();
  const rs = [
    reading({ metricId: 'glucose', deleted: true }),
    reading({ metricId: 'glucose', patientId: 'ghost' }),
  ];
  assert.equal(toCSV(rs, [p]).split('\n').length, 1, 'header only');
});

/* ------------------------------- report ------------------------------- */
for (const [status, name, msg] of results) {
  if (status === 'ok') console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${msg}`);
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
