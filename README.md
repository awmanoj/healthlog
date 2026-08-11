# HealthLog

A daily record of blood sugar, blood pressure, SpO₂, pulse and temperature, built
for a family looking after someone at home. Works offline on any phone, and
several people can share one log that stays in sync.

- **One self-contained file.** `index.html` has no dependencies and no build step.
- **Offline first.** The phone is the source of truth; sync is opportunistic.
- **Shared safely.** Readings are encrypted in the browser before upload — the
  server only ever stores ciphertext.
- **Configurable.** Measurement times, target ranges, units and who is tracked are all
  editable, so it is not tied to one person's condition.

---

## Quick start

Open `index.html` and start recording. That is the whole setup — everything is
stored on the device, and sharing can wait until later.

To put it on a phone properly, host the folder anywhere that serves static files
over HTTPS, then open the URL and use **Add to Home Screen**. It then behaves like
a normal app, launches offline, and has its own icon.

```
index.html              the app
manifest.webmanifest    home-screen metadata
icon.svg                app icon
sw.js                   offline shell (optional — the app works without it)
```

HTTPS matters: without it iOS will not install the app or run the service worker.

---

## Deploying with Docker

```bash
docker compose up -d --build          # serves on http://127.0.0.1:8080
```

With a domain pointed at the host, add automatic HTTPS:

```bash
HEALTHLOG_DOMAIN=healthlog.example.com docker compose --profile tls up -d --build
```

Or without compose:

```bash
docker build -t healthlog .
docker run -d -p 8080:8080 --name healthlog healthlog
```

**The container serves the app over plain HTTP on purpose** — put TLS in front of
it. The `tls` profile runs Caddy and obtains a Let's Encrypt certificate
automatically; any reverse proxy or Cloudflare Tunnel works equally well. Without
HTTPS, iOS will not install the app to the home screen and the service worker
never registers, so the offline behaviour quietly disappears.

The app container publishes to `127.0.0.1` only, so nothing is exposed to the
internet until you deliberately front it.

### What the image does

- **The tests gate the build.** Stage one runs both suites and the build fails if
  either does — a merge bug loses real readings, so it must not be shippable. The
  runtime stage copies `index.html` *out of* the test stage so the tests cannot be
  pruned as an unused branch.
- **Runs unprivileged** on port 8080 (`nginxinc/nginx-unprivileged`), with a
  `/healthz` endpoint wired to a container `HEALTHCHECK`.
- **`index.html` and `sw.js` are served `no-cache`.** Both are unhashed, and a
  cached service worker pins an old version of the app indefinitely. ETags make
  revalidation a cheap `304`. `icon.svg` is cached for a day.
- `.webmanifest` gets an explicit MIME type, which nginx's default `mime.types`
  usually lacks — served as `octet-stream`, the install prompt never appears.

The sync server is **not** in this image. `worker.js` targets the Cloudflare
Workers runtime and deploys separately (see below); the container only serves the
app.

---

## Sharing a log with the family

Sync needs somewhere to keep the encrypted blob. That is `worker.js` — a
Cloudflare Worker on the free tier. **You** set this up once; nobody else needs an
account, an app store, or a login.

### One-time server setup (~5 minutes)

```bash
npm install -g wrangler          # or use `npx wrangler` below
wrangler login                   # opens a browser, free account is fine

wrangler kv namespace create HEALTHLOG
#   older wrangler: wrangler kv:namespace create HEALTHLOG
#   copy the id it prints into wrangler.toml

wrangler deploy
#   prints e.g. https://healthlog.your-name.workers.dev
```

### Creating the room

1. Open the app → **Settings** → **Sharing & sync**.
2. Paste the Worker URL and choose a passphrase.
3. **Create room** → **Share invite**.

### Joining, on everyone else's phone

They open the invite link and type in the passphrase. That is all.

**Send the passphrase separately from the link.** It is deliberately not included
in the URL, so a forwarded WhatsApp message on its own gives nobody access to the
readings. Sending both in the same message throws that protection away.

---

## How sync works, and why it will not lose readings

Every reading is an immutable record with its own UUID. Syncing is a union of two
sets, not an overwrite:

- **New reading** → new UUID → cannot collide with anyone else's.
- **Edit** → same UUID, the later `updatedAt` wins.
- **Delete** → a tombstone, resolved by the same rule.
- **Sync** → pull, merge, push.

So two people can record readings at the same time, both offline, and both
readings survive. The merge is commutative, idempotent and associative — order and
repetition do not change the result. `test/merge.test.mjs` asserts exactly that,
including the scenario where a device that has not pulled for days finally syncs.

If two phones push simultaneously, the Worker rejects the second with a `409` and
the app re-pulls, re-merges and retries, so a race cannot drop anyone's data.

### Privacy

The passphrase is stretched with PBKDF2 (200,000 rounds, SHA-256) into an AES-GCM
key, and the payload is encrypted in the browser. Cloudflare, and anyone who
obtains the room URL, sees only ciphertext. The room id is not the security
boundary — the passphrase is.

The trade-off is real: **if everyone forgets the passphrase, the data on the server
cannot be recovered.** Local copies on each phone are unaffected, and
**Settings → Backup to file** is worth doing occasionally regardless.

---

## What it records

| Measurement | Default schedule | Notes |
|---|---|---|
| Blood sugar | 3× daily | tagged FF (fasting) or PP (after food) |
| Blood pressure | 2× daily | systolic and diastolic |
| SpO₂ | 2× daily | |
| Pulse | 2× daily | |
| Temperature | 2× daily | fever is an early sign of post-operative infection |

Every schedule is editable per person — add or remove times, rename them, or
change the targets. Units switch between mg/dL ↔ mmol/L and °C ↔ °F, and existing
readings are converted rather than left to silently change meaning.

Extra unscheduled readings are always allowed; they do not disturb the checklist.

### Averages

- Fasting and post-food sugar are averaged **separately** — a combined figure means
  nothing.
- Blood pressure averages systolic and diastolic **separately**, shown as `128/82`.
- Each figure carries its sample count, a percentage within target, and a trend
  against the preceding period.
- **Print / PDF** produces a clean table plus averages for the doctor;
  **Export CSV** opens in Excel.

---

## Tests

```bash
node test/merge.test.mjs    # merge, alert ranges, averages, dates, CSV
node test/app.smoke.mjs     # boots the real UI code: entry, all four tabs, crypto
```

The core logic lives inside `index.html` between the `CORE START` / `CORE END`
markers, and the tests extract and run that block directly — so what is tested is
exactly what ships, with no build step in between.

---

## A note on the numbers

HealthLog records what you enter. It does not diagnose, and it is not a substitute
for medical advice.

The default target ranges are generic starting points. Post-operative targets are
routinely different — often deliberately looser — so **confirm every range with the
treating doctor** and adjust them in Settings. When a reading is flagged red, the
app says to contact the doctor rather than offering an interpretation, and that is
the intended use.
# healthlog
