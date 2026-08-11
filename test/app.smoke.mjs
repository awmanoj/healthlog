// Smoke test for the app layer of index.html.
//
// Boots both script blocks against a minimal DOM stub and drives the real
// functions: onboarding, saving readings, rendering all four tabs, building the
// printable report, and the encryption round-trip. This catches the class of
// bug the pure-logic tests cannot — undefined references, broken template
// literals, views that throw on empty or unusual data.
//
//   node test/app.smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.equal(blocks.length, 2, 'expected exactly two inline script blocks');

/* ----------------------------- DOM stub ------------------------------ */
function el(id = '') {
  return {
    id, innerHTML: '', textContent: '', value: '', className: '', style: {},
    dataset: {}, files: [], checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, click() {}, focus() {}, remove() {},
  };
}
const nodes = new Map();
// The app reaches elements by both querySelector('#x') and getElementById('x');
// normalise so both land on the same stub.
const node = sel => {
  const k = String(sel).replace(/^#/, '');
  if (!nodes.has(k)) nodes.set(k, el(k));
  return nodes.get(k);
};

const navButtons = ['today', 'history', 'stats', 'settings'].map(t => {
  const b = el(); b.dataset.tab = t; return b;
});

const document = {
  querySelector: node,
  querySelectorAll: sel => (sel === 'nav button' ? navButtons : []),
  getElementById: node,
  createElement: () => el(),
  addEventListener() {},
  body: { appendChild() {} },
  hidden: false,
};

const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const sandbox = {
  console, document, localStorage,
  crypto: webcrypto,
  navigator: { onLine: true, share: undefined, clipboard: undefined },
  location: { href: 'https://example.com/index.html', hash: '', protocol: 'https:' },
  history: { replaceState() {} },
  window: null,
  setTimeout: fn => { if (typeof fn === 'function') fn(); return 0; },   // run deferred work inline
  clearTimeout: () => {},
  setInterval: () => 0,                                                  // never hold the process open
  Blob: class {}, URL: globalThis.URL, FileReader: class {},
  TextEncoder, TextDecoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  fetch: async () => { throw new Error('network disabled in smoke test'); },
  confirm: () => true, prompt: () => null, alert: () => {},
  addEventListener() {}, removeEventListener() {}, scrollTo() {},
  module: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// `let`/`const` at the top of a script are lexical bindings, not properties of
// the global object, so app state must be reached by evaluating in the context.
const ctx = expr => vm.runInContext(expr, sandbox);
const S = sandbox;                    // function declarations *are* properties
const view = () => node('#view').innerHTML;
const set = (id, v) => { node(id).value = v; };
// The stub does not parse rendered HTML back into element values, so opening a
// patient sheet must be told what the browser would have painted into the name
// field. Anything else leaves a stale value from an earlier test.
const openPatient = name => {
  const p = ctx('live(data.patients)').find(x => x.name === name);
  assert.ok(p, `no patient named ${name}`);
  S.editPatient(p.id);
  set('#pdName', name);
  return p;
};

/* ------------------------------- runner ------------------------------ */
let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push(['ok', name]); }
  catch (e) { fail++; results.push(['FAIL', name, (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')]); }
}
function report() {
  for (const [status, name, msg] of results) {
    if (status === 'ok') console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    else console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${msg}`);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
}

/* -------------------------------- boot ------------------------------- */
await test('both script blocks evaluate without throwing', () => {
  vm.runInContext(blocks[0], sandbox, { filename: 'core.js' });
  vm.runInContext(blocks[1], sandbox, { filename: 'app.js' });
});
if (fail) { report(); process.exit(1); }

const TODAY = ctx('todayKey()');

await test('first run shows onboarding, not a crash', () => {
  assert.match(view(), /Welcome to HealthLog/);
  assert.match(view(), /obPatient/);
});

await test('onboarding creates a patient with the default schedule', () => {
  set('#obPatient', 'Amma');
  set('#obRecorder', 'Manoj');
  S.doOnboard();
  const patients = ctx('data.patients');
  assert.equal(patients.length, 1);
  assert.equal(patients[0].name, 'Amma');
  assert.equal(patients[0].metrics.length, 5, 'sugar, BP, SpO2, pulse, temperature');
  assert.equal(ctx('settings.recorderName'), 'Manoj');
});

await test('today view renders the checklist with nothing recorded', () => {
  assert.match(view(), /Blood Sugar/);
  assert.match(view(), /Fasting \(morning\)/);
  assert.match(view(), /0\/3/, 'sugar shows none of three done');
  assert.match(view(), /Not recorded/);
});

await test('saving a reading through the entry sheet works end to end', () => {
  const g = S.activePatient().metrics.find(m => m.id === 'glucose');
  S.openEntry('glucose', null, g.slots[0].id);
  assert.match(node('#sheetInner').innerHTML, /Before or after food/, 'glucose offers the FF/PP choice');
  set('#v_mgdl', '118'); set('#e_date', TODAY); set('#e_time', '07:10'); set('#e_note', 'before physio');
  S.saveEntry();

  const rs = ctx('data.readings');
  assert.equal(rs.length, 1);
  assert.equal(rs[0].values.mgdl, 118);
  assert.equal(rs[0].tag, 'FF', 'the fasting slot pre-selects FF');
  assert.equal(rs[0].recordedBy, 'Manoj');
  assert.equal(rs[0].note, 'before physio');
  assert.equal(rs[0].takenAt.slice(11, 16), '07:10');
  assert.ok(rs[0].deviceId && rs[0].updatedAt, 'stamped for merge');
});

await test('the saved reading appears on Today with its value and time', () => {
  assert.match(view(), /1\/3/);
  assert.match(view(), /118/);
  assert.match(view(), /07:10/);
});

await test('an out-of-range reading is flagged, not silently accepted', () => {
  const o = S.activePatient().metrics.find(m => m.id === 'spo2');
  S.openEntry('spo2', null, o.slots[0].id);
  set('#v_pct', '88'); set('#e_date', TODAY); set('#e_time', '08:00'); set('#e_note', '');
  S.saveEntry();
  assert.match(view(), /outside the safe range/, 'today view raises an alert banner');
  assert.match(view(), /val alert/, 'the value itself is marked');
});

await test('a nonsensical value is rejected rather than stored', () => {
  const before = ctx('data.readings.length');
  const b = S.activePatient().metrics.find(m => m.id === 'bp');
  S.openEntry('bp', null, b.slots[0].id);
  set('#v_sys', '900'); set('#v_dia', '80'); set('#e_date', TODAY); set('#e_time', '09:00'); set('#e_note', '');
  S.saveEntry();
  assert.equal(ctx('data.readings.length'), before, 'out-of-bounds systolic not saved');
});

await test('blood pressure requires both numbers', () => {
  const before = ctx('data.readings.length');
  set('#v_sys', '130'); set('#v_dia', '');
  S.saveEntry();
  assert.equal(ctx('data.readings.length'), before, 'missing diastolic rejected');
  set('#v_dia', '84');
  S.saveEntry();
  assert.equal(ctx('data.readings.length'), before + 1);
});

await test('history view renders saved readings', () => {
  ctx("tab='history'"); S.render();
  assert.match(view(), /Today/);
  assert.match(view(), /Blood Sugar/);
  assert.match(view(), /130\/84/, 'BP shown as systolic/diastolic');
});

await test('stats view renders averages and separates FF from PP', () => {
  ctx("tab='stats'"); S.render();
  assert.match(view(), /Blood Sugar \(FF\)/);
  assert.match(view(), /Blood Sugar \(PP\)/);
  assert.match(view(), /within target/);
  assert.match(view(), /118/);
});

await test('every stats window renders without throwing', () => {
  for (const w of [7, 14, 30, 0]) { S.setWindow(w); assert.ok(view().length > 100, 'window ' + w); }
  S.setWindow(7);
});

await test('settings view renders, offering sync setup', () => {
  ctx("tab='settings'"); S.render();
  assert.match(view(), /Sharing/);
  assert.match(view(), /rmServer/);
  assert.match(view(), /Backup to file/);
  assert.match(view(), /does not diagnose/, 'the disclaimer is present');
});

await test('the printable report builds with readings and averages', () => {
  ctx("tab='stats'"); S.render();
  const rep = node('#report').innerHTML;
  assert.match(rep, /Amma — Health Log/);
  assert.match(rep, /<table>/);
  assert.match(rep, /Averages/);
  assert.match(rep, /118/);
});

await test('a second patient can be added and switched to', () => {
  S.editPatient(null);
  set('#pdName', 'Appa');
  S.savePatient();
  assert.equal(ctx('live(data.patients).length'), 2);
  assert.equal(S.activePatient().name, 'Appa');
  ctx("tab='today'"); S.render();
  assert.match(view(), /0\/3/, 'the new patient starts with an empty log');
  assert.doesNotMatch(view(), /118/, "the first patient's readings do not leak across");
});

await test("switching back preserves the first patient's readings", () => {
  const amma = ctx('live(data.patients)').find(p => p.name === 'Amma');
  S.pickPatient(amma.id);
  ctx("tab='today'"); S.render();
  assert.match(view(), /118/);
});

await test('deleting a reading tombstones it instead of dropping it', () => {
  const r = ctx('data.readings').find(x => x.values.mgdl === 118);
  S.openEntry('glucose', r.id, null);
  S.deleteEntry();
  const after = ctx('data.readings').find(x => x.id === r.id);
  assert.equal(after.deleted, true, 'kept as a tombstone so the delete syncs');
  assert.equal(ctx('live(data.readings)').some(x => x.id === r.id), false);
});

await test('schedule edits survive a trip through the metric editor', () => {
  openPatient('Amma');
  S.capturePatientName();
  S.editMetric('glucose');
  S.renameSlot('glucose', 0, 'Fasting — before tea');
  S.addSlot('glucose');
  S.showPatientSheet();
  assert.match(node('#sheetInner').innerHTML, /4× daily/, 'the added slot is still in the draft');
  S.savePatient();
  const g = ctx('live(data.patients)').find(p => p.name === 'Amma').metrics.find(m => m.id === 'glucose');
  assert.equal(g.slots.length, 4, 'the added slot was persisted, not discarded');
  assert.equal(g.slots[0].label, 'Fasting — before tea');
});

await test('abandoning a unit change leaves readings untouched', () => {
  const g = S.activePatient().metrics.find(m => m.id === 'glucose');
  S.openEntry('glucose', null, g.slots[1].id);
  set('#v_mgdl', '180'); set('#e_date', TODAY); set('#e_time', '12:00'); set('#e_note', '');
  S.saveEntry();
  const id = ctx('data.readings').find(r => r.values.mgdl === 180).id;

  openPatient('Amma'); S.editMetric('glucose'); S.setUnit('glucose', 'mmol/L');
  S.closeSheet();
  assert.equal(ctx('data.readings').find(r => r.id === id).values.mgdl, 180,
    'readings must not be converted unless the change is saved');
  assert.equal(
    ctx('live(data.patients)').find(p => p.name === 'Amma').metrics.find(m => m.id === 'glucose').fields[0].unit,
    'mg/dL', 'and the unit must not have changed either');
});

await test('a saved unit change converts readings and targets together', () => {
  const id = ctx('data.readings').find(r => r.values.mgdl === 180).id;
  openPatient('Amma'); S.editMetric('glucose'); S.setUnit('glucose', 'mmol/L'); S.savePatient();

  assert.equal(ctx('data.readings').find(r => r.id === id).values.mgdl, 10, '180 mg/dL is 10.0 mmol/L');
  const g = ctx('live(data.patients)').find(p => p.name === 'Amma').metrics.find(m => m.id === 'glucose');
  assert.equal(g.fields[0].unit, 'mmol/L');
  assert.equal(g.targetsByTag.FF.mgdl.warnHigh, 7.2, 'the 130 mg/dL target converted with it');
  assert.equal(g.fields[0].max, 33, 'input bounds follow the unit');
});

await test('editing a reading keeps the original recorder', () => {
  const r = ctx('data.readings').find(x => x.values.mgdl === 10);
  ctx("settings.recorderName='Someone Else'");
  S.openEntry('glucose', r.id, null);
  set('#v_mgdl', '11');
  S.saveEntry();
  const after = ctx('data.readings').find(x => x.id === r.id);
  assert.equal(after.values.mgdl, 11, 'the edit was applied');
  assert.equal(after.recordedBy, 'Manoj', 'attribution stays with whoever took the reading');
  ctx("settings.recorderName='Manoj'");
});

await test('state survives a reload from localStorage', () => {
  const n = ctx('data.readings.length');
  ctx('data={patients:[],readings:[]}');
  S.loadLocal();
  assert.equal(ctx('data.readings.length'), n);
  assert.equal(ctx('live(data.patients).length'), 2);
  assert.equal(ctx('settings.recorderName'), 'Manoj');
});

await test('corrupt localStorage does not brick the app', () => {
  store.set('healthlog.v1.data', '{not json');
  ctx('data={patients:[],readings:[]}');
  S.loadLocal();
  assert.ok(Array.isArray(ctx('data.readings')), 'falls back to an empty log');
  S.render();
});

/* ------------------------------ crypto ------------------------------- */
const bytesOf = b64 => Buffer.from(b64, 'base64');
const contains = (buf, s) => buf.includes(Buffer.from(s, 'utf8'));

await test('payload encrypts and decrypts round-trip', async () => {
  const payload = { patients: [{ id: 'p1', name: 'Amma' }], readings: [{ id: 'r1', values: { mgdl: 118 } }] };
  const envelope = await S.encryptPayload(payload, 'room-abc', 'family passphrase');
  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, 'AES-GCM');
  assert.ok(envelope.ct && envelope.iv);
  const back = await S.decryptPayload(JSON.parse(JSON.stringify(envelope)), 'room-abc', 'family passphrase');
  assert.equal(JSON.stringify(back), JSON.stringify(payload));
});

await test('the ciphertext contains no plaintext readings', async () => {
  const payload = { patients: [{ id: 'p1', name: 'Amma' }], readings: [{ id: 'r1', values: { mgdl: 118 } }] };
  const envelope = await S.encryptPayload(payload, 'room-abc', 'family passphrase');
  const raw = bytesOf(envelope.ct);
  assert.equal(contains(raw, 'Amma'), false, 'patient name must not appear in the ciphertext');
  assert.equal(contains(raw, 'mgdl'), false, 'field names must not appear in the ciphertext');
  assert.equal(contains(raw, 'readings'), false);
});

await test('a wrong passphrase fails loudly rather than returning junk', async () => {
  const envelope = await S.encryptPayload({ readings: [] }, 'room-abc', 'right one');
  await assert.rejects(
    () => S.decryptPayload(envelope, 'room-abc', 'wrong one'),
    e => e.message === 'WRONG_PASSPHRASE');
});

await test('the same passphrase in a different room cannot decrypt', async () => {
  const envelope = await S.encryptPayload({ readings: [] }, 'room-one', 'shared pass');
  await assert.rejects(() => S.decryptPayload(envelope, 'room-two', 'shared pass'));
});

await test('each encryption uses a fresh IV', async () => {
  const a = await S.encryptPayload({ readings: [] }, 'r', 'p');
  const b = await S.encryptPayload({ readings: [] }, 'r', 'p');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

report();
process.exit(fail ? 1 : 0);
