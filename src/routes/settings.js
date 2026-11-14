import { Hono } from 'hono';
import { logActivity } from '../services/logger.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { triggerSync } from '../services/gmail-sync.js';
import { encryptToken } from '../services/token-crypto.js';

const settings = new Hono();

const ALLOWED = new Set([
  'theme', 'timezone', 'time_format', 'sync_interval', 'sync_window_days',
  'mark_read_on_open', 'block_remote_images', 'default_reply_all', 'activity_enabled', 'logs_enabled',
  'ai_base_url', 'ai_model'
]);

async function exposedSettings(db) {
  const { results } = await db.prepare(
    "SELECT key, value FROM settings WHERE key NOT IN ('signing_secret', 'ai_api_key')"
  ).all();
  const values = Object.fromEntries(results.map((row) => [row.key, row.value]));
  const key = await db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").first();
  values.ai_api_key_set = key?.value ? '1' : '0';
  return values;
}

settings.get('/', async (c) => {
  const user = c.get('user');
  const err = requireAuth(c, user);
  if (err) return err;
  const viewErr = requirePermission(c, 'settings:view', user);
  if (viewErr) return viewErr;
  return c.json(await exposedSettings(c.get('db')));
});

settings.put('/', async (c) => {
  const user = c.get('user');
  let err = requireAuth(c, user);
  if (err) return err;
  err = requirePermission(c, 'settings:edit', user);
  if (err) return err;

  const db = c.get('db');
  const env = c.get('env') || {};
  const body = await c.req.json().catch(() => ({}));
  const baseUrl = String(body.ai_base_url ?? '').trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return c.json({ error: 'AI base URL must start with http:// or https://' }, 400);
  }
  const entries = Object.entries(body).filter(([key]) => ALLOWED.has(key));
  const previousWindow = (await db.prepare("SELECT value FROM settings WHERE key = 'sync_window_days'").first())?.value;
  for (const [key, value] of entries) {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, String(value)).run();
  }

  const apiKey = String(body.ai_api_key || '').trim();
  if (apiKey) {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('ai_api_key', encryptToken(apiKey, env)).run();
  }

  const windowChanged = entries.some(([key, value]) => key === 'sync_window_days' && String(value) !== String(previousWindow ?? ''));
  if (windowChanged) {
    const { results: accounts } = await db.prepare(
      "SELECT id FROM google_accounts WHERE status != 'reauth_required'"
    ).all();
    for (const account of accounts) {
      await db.prepare('DELETE FROM sync_state WHERE account_id = ?').bind(account.id).run();
      triggerSync(db, env, account.id, { force: true }).catch(() => {});
    }
  }

  const changed = entries.map(([key]) => key).concat(apiKey ? ['ai_api_key'] : []);
  await logActivity(db, user.id, user.username, 'settings.update', changed.join(', '));
  return c.json(await exposedSettings(db));
});

export default settings;
