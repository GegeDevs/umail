import { Hono } from 'hono';
import { lookup } from 'node:dns/promises';
import { requirePermission } from '../middleware/auth.js';

const MAX_BYTES = 5 * 1024 * 1024;
const imageProxy = new Hono();

function blockedIp(ip) {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return blockedIp(lower.slice(7));
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

// ponytail: DNS is resolved once here and again by fetch (rebinding window). Upgrade to
// a pinned-IP socket if this proxy is ever exposed to untrusted users.
imageProxy.get('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:read', user);
  if (err) return err;

  let target;
  try {
    target = new URL(String(c.req.query('url') || ''));
  } catch {
    return c.json({ error: 'Invalid image URL' }, 400);
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return c.json({ error: 'Unsupported image URL' }, 400);
  }
  if (target.port && !['80', '443'].includes(target.port)) {
    return c.json({ error: 'Unsupported image port' }, 400);
  }

  const addresses = await lookup(target.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((entry) => blockedIp(entry.address))) {
    return c.json({ error: 'Blocked image host' }, 403);
  }

  const res = await fetch(target, {
    redirect: 'manual',
    headers: { accept: 'image/*', 'user-agent': 'UMail image proxy' },
    signal: AbortSignal.timeout(10_000)
  }).catch(() => null);
  if (!res || !res.ok) return c.json({ error: 'Image unavailable' }, 502);

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return c.json({ error: 'Not an image' }, 415);
  if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) {
    return c.json({ error: 'Image too large' }, 413);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) return c.json({ error: 'Image too large' }, 413);

  return c.body(buffer, 200, {
    'Content-Type': type,
    'Content-Length': String(buffer.byteLength),
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'"
  });
});

export default imageProxy;
