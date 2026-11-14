import { createHash, randomBytes } from 'node:crypto';

export const API_PERMISSIONS = [
  'api:mail:read',
  'api:mail:send',
  'api:mail:modify',
  'api:accounts:read'
];

export function hashApiKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export async function createApiKey(db, {
  name, userId = null, permissions = [], rateLimit = 60, expiresDays = 0
} = {}) {
  const key = `umail_${randomBytes(24).toString('base64url')}`;
  const allowed = permissions.filter((permission) => API_PERMISSIONS.includes(permission));
  const expiresAt = Number(expiresDays) > 0
    ? new Date(Date.now() + Number(expiresDays) * 86400000).toISOString()
    : null;
  const result = await db.prepare(`
    INSERT INTO api_keys (name, key_hash, key_prefix, user_id, permissions, rate_limit, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    String(name || 'API key').slice(0, 80),
    hashApiKey(key),
    key.slice(0, 12),
    userId || null,
    JSON.stringify(allowed),
    Math.max(1, Math.min(600, Number(rateLimit) || 60)),
    expiresAt
  ).run();
  return { key, id: result.meta.last_row_id, expiresAt, permissions: allowed };
}

export async function listApiKeys(db) {
  const { results } = await db.prepare(`
    SELECT id, name, key_prefix, permissions, rate_limit, expires_at, last_used_at, created_at
    FROM api_keys ORDER BY id DESC
  `).all();
  return results.map((row) => ({ ...row, permissions: JSON.parse(row.permissions || '[]') }));
}

export async function revokeApiKey(db, id) {
  const result = await db.prepare('DELETE FROM api_keys WHERE id = ?').bind(Number(id)).run();
  return result.meta.changes > 0;
}

export async function authenticateApiKey(db, rawKey) {
  if (!rawKey) return null;
  const hash = hashApiKey(rawKey);
  const row = await db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(hash).first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return { ...row, hash, permissions: JSON.parse(row.permissions || '[]') };
}

export async function checkRateLimit(db, keyHash, limit) {
  const windowStart = Math.floor(Date.now() / 60000);
  await db.prepare(`
    INSERT INTO api_rate_limits (key_hash, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(key_hash, window_start) DO UPDATE SET request_count = request_count + 1
  `).bind(keyHash, windowStart).run();
  const row = await db.prepare(
    'SELECT request_count FROM api_rate_limits WHERE key_hash = ? AND window_start = ?'
  ).bind(keyHash, windowStart).first();
  if (windowStart % 60 === 0) {
    await db.prepare('DELETE FROM api_rate_limits WHERE window_start < ?').bind(windowStart - 5).run();
  }
  const used = Number(row?.request_count) || 0;
  return { allowed: used <= limit, remaining: Math.max(0, limit - used), limit };
}
