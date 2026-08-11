/**
 * HealthLog sync server — a Cloudflare Worker backed by KV.
 *
 * It is a dumb encrypted-blob store. It never sees readings in the clear:
 * the app encrypts with AES-GCM before upload, so this server (and Cloudflare)
 * only ever holds ciphertext.
 *
 *   GET  /room/:id   -> 200 {encrypted blob} + ETag, or 404 if the room is new
 *   PUT  /room/:id   -> 204 + new ETag; 409 if If-Match is stale
 *
 * The ETag is a version counter enabling compare-and-set. If two phones push at
 * the same moment, the loser gets a 409, re-pulls, re-merges and retries — so a
 * concurrent write can never silently drop the other person's readings.
 *
 * Setup: see README.md (about 5 minutes, free tier).
 */

const MAX_BYTES = 2_000_000;          // ~10 years of readings for a family
const ROOM_RE = /^\/room\/([A-Za-z0-9_-]{8,64})$/;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,If-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};
const reply = (status, body, extra = {}) =>
  new Response(body, { status, headers: { ...cors, ...extra } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return reply(204, null);

    const { pathname } = new URL(request.url);
    const match = pathname.match(ROOM_RE);
    if (!match) return reply(404, 'Not found');

    // Room ids are unguessable UUIDs, but they are not the security boundary —
    // encryption is. A leaked id yields ciphertext and nothing more.
    const key = 'room:' + match[1];

    if (request.method === 'GET') {
      const { value, metadata } = await env.HEALTHLOG.getWithMetadata(key);
      if (value === null) return reply(404, 'No such room yet');
      return reply(200, value, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ETag: String(metadata?.version ?? 0),
      });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return reply(413, 'Payload too large');
      try { JSON.parse(body); } catch { return reply(400, 'Body must be JSON'); }

      const { metadata } = await env.HEALTHLOG.getWithMetadata(key);
      const current = metadata?.version ?? 0;

      const ifMatch = request.headers.get('If-Match');
      if (ifMatch !== null && Number(ifMatch) !== current) {
        return reply(409, 'Version conflict', { ETag: String(current) });
      }

      const version = current + 1;
      await env.HEALTHLOG.put(key, body, { metadata: { version } });
      return reply(204, null, { ETag: String(version) });
    }

    return reply(405, 'Method not allowed');
  },
};
