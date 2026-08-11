# HealthLog — Requirements & Design

A self-contained, offline-first web app for logging vital signs, shareable across a
family's phones without accounts or a server.

Built initially for post-knee-replacement recovery tracking; generalised so any
family can use it.

---

## 1. Decisions (locked)

| Area | Decision |
|---|---|
| Distribution | Single self-contained `index.html` (HTML/CSS/JS inline, no build step, no dependencies). Hosting is the user's own; `Dockerfile` + `docker-compose.yml` serve it via nginx, with an optional Caddy profile for automatic HTTPS. |
| Storage | Offline-first. Local device is the **source of truth**; sync is opportunistic and best-effort. |
| Sync backend | Cloudflare Worker + KV (`worker.js`), free tier, deployed once by the log's owner. Zero signup for everyone else. Accessed behind a swappable adapter. See §7 for why the anonymous-store option was dropped. |
| Privacy | End-to-end: AES-GCM with a key derived from a shared passphrase (PBKDF2, WebCrypto). The store only ever holds ciphertext. |
| People | Multiple people from v1, with a switcher. Each has their own schedule, targets and averages. The UI says "person"; the data model keeps `patientId` and the CSV export keeps a `patient` column, since those are clinical artefacts, not user-facing copy. |
| Metrics | Glucose (FF/PP), Blood Pressure, SpO₂, Pulse, Temperature. Defined as **data**, not code. |
| Out of scope v1 | Push reminders, accounts/auth, charts, medication/pain/physio tracking. |

---

## 2. Core architecture: sync as a merge, not an overwrite

The single most important design constraint. If the app pushes "current state" as a
blob, two people logging while offline will clobber each other and lose real
readings — silently.

Instead, the log is an **append-only set of immutable readings**, each with a UUID.
Merge is a union by ID:

- **New reading** → new UUID → no conflict possible.
- **Edit** → same UUID, later `updatedAt` wins.
- **Delete** → tombstone (`deleted: true`), same last-write-wins rule.
- **Sync** = `pull remote → union with local → push merged`.

This is order-independent and idempotent, so sync can run at any time, in any order,
from any device. Consequence: the backend only needs `get blob` / `put blob`, which
makes it swappable without touching app logic.

Clock skew between devices is tolerated; ties on `updatedAt` break on `deviceId`.

### Sync triggers
On app open, after each save, and on pull-to-refresh. No websockets, no realtime,
no polling loop.

---

## 3. Data model

```js
Patient {
  id, name, glucoseUnit: 'mg/dL' | 'mmol/L',
  metrics: [MetricConfig],       // schedule + targets, per patient
  createdAt, updatedAt, deleted
}

MetricConfig {
  id,                            // 'glucose' | 'bp' | 'spo2' | 'pulse' | 'temp'
  label, fields: [{key, label, unit, min, max, step}],
  slots: [{id, label, defaultTag}],
  targets: { warnLow, warnHigh, alertLow, alertHigh }   // per field
}

Reading {
  id,                            // UUID — the merge key
  patientId, metricId,
  slotId,                        // optional; null for ad-hoc readings
  tag,                           // 'FF' | 'PP' for glucose
  values,                        // {mgdl:118} | {sys:132,dia:84} | {pct:97} | {bpm:78} | {c:98.4}
  takenAt,                       // ISO + UTC offset — when the reading happened
  note,
  recordedBy,                    // device/person name, for attribution
  createdAt, updatedAt,          // when the record was written/last edited
  deleted                        // tombstone flag
}
```

**`takenAt` is deliberately separate from `createdAt`.** Readings are frequently
entered late ("she measured at 7am, I'm logging it at 9"). Averages and the daily
checklist use `takenAt`; merge conflict resolution uses `updatedAt`.

---

## 4. Schedule model — "N times a day" as named slots

A bare count produces a worse app than named slots. Example:

```js
glucose: { slots: [
  {id:'s1', label:'Fasting (morning)', defaultTag:'FF'},
  {id:'s2', label:'After breakfast',   defaultTag:'PP'},
  {id:'s3', label:'After dinner',      defaultTag:'PP'}]}
```

Slots give us, for free:
- A **daily checklist** — "2 of 3 sugar readings done" on the home screen.
- Consistent grouping for averages.
- One-tap entry with the tag pre-filled.

Slots are a *guide, not a constraint*: ad-hoc extra readings with `slotId: null` are
always allowed, because a doctor will eventually ask for an extra check.

Adding a new metric (e.g. weight) is a config change, not a code change.

---

## 5. Averages & derived stats

Window selector: **7 / 14 / 30 days / all**. Every figure shows its sample count `n`.

- **Glucose: FF and PP averaged separately.** Mixing them is meaningless.
- **Blood pressure: systolic and diastolic averaged separately**, displayed `128/82`.
  Never averaged together.
- **Time-in-range %** for glucose — more useful than the mean, and free once targets
  are configured.
- **Trend** — current window vs the preceding one, with a direction arrow.
- **Doctor export** — printable weekly table + summary via a print stylesheet, plus
  CSV. The treating doctor will ask to see the log.

---

## 6. Alerts

Two tiers, both configurable per patient, per field:

- **Amber — outside target range.**
- **Red — needs attention now.**

Ships with conservative starting defaults, but the app states plainly that targets
must be confirmed with the treating doctor: post-operative and post-anaesthesia
targets are often deliberately looser than general population figures.

This is a **recording tool, not a diagnostic one.** A persistent one-line disclaimer
appears in the UI, and red alerts say "contact the doctor" rather than interpreting
the reading.

---

## 7. Sharing model

A **room** = one shared log, identified by `{ blobId, passphrase }`, shareable as a
single link with the passphrase in the URL fragment (`#` — never sent to the server).

- Anyone with the link joins the room and sees everyone tracked in it.
- Every reading carries `recordedBy`, so entries are attributed.
- No roles, no permissions in v1 — anyone in the room can read and write. Appropriate
  for a family; revisit only if it becomes a problem.

### Why not a zero-signup public store

The original plan was a free anonymous JSON store, so nobody at all would need an
account. That open item was tested against live services, and the category has
effectively evaporated:

| Service | Result (Aug 2026) |
|---|---|
| jsonblob | works, but blobs **expire 24h after creation**; neither GET nor PUT extends it |
| extendsclass | `404` — endpoint retired |
| jsonsilo | `307` — now requires auth |
| jsonbin | `401` — API key required |
| kvdb.io | `500` — *"email required when creating the bucket"* |

A store that deletes itself daily is disqualifying for a medical log.

**The requirement that actually mattered was that the *family* needs zero signup**,
not that nobody does. A Cloudflare Worker + KV satisfies that in full: the owner
deploys once (free, ~5 min), everyone else still joins with a link and a
passphrase. The sharing model, the app code and the merge logic are unchanged —
only the adapter differs, which is exactly what §2 was designed to allow.

### Privacy posture
The passphrase is stretched with PBKDF2 (200k rounds, SHA-256) into an AES-GCM key;
the payload is encrypted in the browser. The server stores ciphertext only, so
neither Cloudflare nor anyone holding the room URL can read the log. Patient names
are inside the encrypted payload. **The room id is not the security boundary — the
passphrase is.**

The passphrase is deliberately **not** in the invite link, so a forwarded message
alone grants no access. It must be sent separately.

Consequence to accept: if every family member forgets the passphrase, the server
copy is unrecoverable. Local copies are unaffected.

### Durability
1. **Local storage is always the complete source of truth** — losing the remote blob
   degrades to "sync is broken", never "data is gone".
2. One-tap JSON backup, and import merges rather than overwrites.
3. The adapter stays swappable, so moving to Supabase or anything else later is a
   new adapter, not a rewrite.

---

## 8. UX requirements

Users include elderly and non-technical family members. Therefore:

- Large touch targets, large type, high contrast. Numeric keypads on all number inputs.
- Time defaults to now, adjustable in one tap.
- Home screen shows **today** and what is still outstanding.
- Entry flow: pick metric → pick slot → type value → save. No more than three taps
  before the keyboard appears.
- Works fully offline; sync state shown honestly ("Synced 2 min ago" / "Offline —
  3 unsent").
- Installable to the home screen (Add to Home Screen) with a service worker for
  offline load. Requires HTTPS hosting.

---

## 9. Assumptions

- `FF` = fasting / before food; `PP` = post-prandial / after food.
- Glucose in **mg/dL** by default (unit is configurable per patient).
- All users are in the same timezone, but `takenAt` stores a UTC offset regardless.

---

## 10. Build status

All built, in `index.html` (single file, no dependencies, no build step).

1. ✅ Data model, local storage, merge function — `test/merge.test.mjs`, 32 tests
2. ✅ Entry UI, daily checklist, person switcher
3. ✅ Averages, time-in-range, trends, two-tier alerts
4. ✅ Encryption, swappable adapter, room create/join/share — `worker.js`
5. ✅ Print report, CSV export, service worker, home-screen install

Tests run the code that actually ships: both suites extract the live blocks out of
`index.html` rather than testing a copy.

```bash
node test/merge.test.mjs    # 32 — merge algebra, ranges, averages, dates, CSV
node test/app.smoke.mjs     # 28 — boots the real UI: entry, tabs, report, crypto
```

### Not verified
- The app has not been opened in a real mobile browser — the local browser harness
  needs an interactive permission click. Layout on a physical phone, the print
  stylesheet's page breaks, and Add-to-Home-Screen are unconfirmed.
- **The Docker image has never been built.** No daemon was available. COPY sources,
  `.dockerignore` interactions and the test-stage command were checked statically,
  but the nginx config has not been parsed by nginx and the image has not run.
  `docker compose up -d --build` is the check.
