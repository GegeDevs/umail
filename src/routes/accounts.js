import { Hono } from 'hono';
import { logActivity } from '../services/logger.js';
import { checkAccountHealth } from '../services/account-health.js';
import { revokeGoogleToken } from '../services/gmail.js';
import { decryptToken } from '../services/token-crypto.js';
import { triggerSync, isSyncing, getSyncProgress } from '../services/gmail-sync.js';
import { buildAuthUrl, getRedirectUri, isOAuthConfigured } from '../services/google-oauth.js';
import { createOAuthState } from '../services/oauth-state.js';
import { normalizeCardColor } from '../services/account-colors.js';
import { requirePermission } from '../middleware/auth.js';

const accounts = new Hono();

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1) || '*'}***@${domain}`;
}

async function findAccount(db, id) {
  return db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(id).first();
}

accounts.get('/oauth-status', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'accounts:view', user);
  if (err) return err;
  const env = c.get('env') || {};
  return c.json({ configured: isOAuthConfigured(env), redirect_uri: getRedirectUri(c) });
});

accounts.get('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'accounts:view', user);
  if (err) return err;
  const db = c.get('db');
  const revealEmail = user.role === 'master' || user.permissions.includes('accounts:view_email');
  const { results } = await db.prepare(`
    SELECT a.id, a.email, a.display_name, a.avatar_url, a.is_default, a.card_color,
           a.status, a.last_synced_at, a.last_error, a.sync_enabled, a.signature,
           COALESCE((SELECT COUNT(*) FROM messages m
                     WHERE m.account_id = a.id AND m.is_unread = 1
                       AND m.label_ids LIKE '%"INBOX"%'
                       AND m.label_ids NOT LIKE '%"TRASH"%'
                       AND m.label_ids NOT LIKE '%"SPAM"%'), 0) AS unread
    FROM google_accounts a ORDER BY a.is_default DESC, a.id
  `).all();
  return c.json({
    results: results.map((account) => ({
      ...account,
      email: revealEmail ? account.email : maskEmail(account.email),
      syncing: isSyncing(account.id),
      sync_progress: getSyncProgress(account.id)
    }))
  });
});

accounts.patch('/:id', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const account = await findAccount(db, id);
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const wantsColor = body.card_color !== undefined;
  const wantsDefault = body.is_default !== undefined;
  const wantsSync = body.sync_enabled !== undefined;
  const wantsSignature = body.signature !== undefined;
  if (!wantsColor && !wantsDefault && !wantsSync && !wantsSignature) return c.json({ error: 'No supported fields' }, 400);

  if (wantsColor) {
    const err = requirePermission(c, 'accounts:color', user);
    if (err) return err;
    const color = normalizeCardColor(body.card_color);
    if (!color) return c.json({ error: 'Invalid color. Use #rrggbb.' }, 400);
    await db.prepare("UPDATE google_accounts SET card_color = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(color, id).run();
  }
  if (wantsDefault) {
    const err = requirePermission(c, 'accounts:set_default', user);
    if (err) return err;
    if (body.is_default !== true) return c.json({ error: 'Only setting a default is supported' }, 400);
    await db.prepare('UPDATE google_accounts SET is_default = 0').run();
    await db.prepare("UPDATE google_accounts SET is_default = 1, updated_at = datetime('now') WHERE id = ?")
      .bind(id).run();
  }
  if (wantsSync) {
    const err = requirePermission(c, 'accounts:refresh', user);
    if (err) return err;
    if (typeof body.sync_enabled !== 'boolean') return c.json({ error: 'sync_enabled must be boolean' }, 400);
    await db.prepare("UPDATE google_accounts SET sync_enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(body.sync_enabled ? 1 : 0, id).run();
  }
  if (wantsSignature) {
    const err = requirePermission(c, 'accounts:signature', user);
    if (err) return err;
    const signature = String(body.signature || '').slice(0, 2000);
    await db.prepare("UPDATE google_accounts SET signature = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(signature, id).run();
  }

  await logActivity(db, user.id, user.username, 'accounts.update', `Updated ${account.email}`, id);
  return c.json({ success: true });
});

accounts.delete('/:id', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'accounts:remove', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const account = await findAccount(db, id);
  if (!account) return c.json({ error: 'Account not found' }, 404);

  try {
    await revokeGoogleToken(decryptToken(account.refresh_token || account.access_token, c.get('env') || {}));
  } catch {
    // Revocation is best-effort; a missing key must not block removing the account.
  }
  await db.prepare('DELETE FROM google_accounts WHERE id = ?').bind(id).run();

  if (account.is_default) {
    const next = await db.prepare('SELECT id FROM google_accounts ORDER BY id LIMIT 1').first();
    if (next) await db.prepare('UPDATE google_accounts SET is_default = 1 WHERE id = ?').bind(next.id).run();
  }

  await logActivity(db, user.id, user.username, 'accounts.remove', `Removed ${account.email}`, id);
  return c.json({ success: true });
});

accounts.post('/:id/refresh', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'accounts:refresh', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const account = await findAccount(db, id);
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const env = c.get('env') || {};
  const result = await checkAccountHealth(db, env, account);
  if (result.ok) triggerSync(db, env, id, { force: true }).catch(() => {});
  await logActivity(
    db, user.id, user.username, 'accounts.refresh',
    `${account.email}: ${result.ok ? 'healthy' : result.status}`, id
  );
  return c.json({ ...result, syncing: result.ok });
});

accounts.post('/:id/reconnect', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'accounts:add', user);
  if (err) return err;
  const db = c.get('db');
  const env = c.get('env') || {};
  if (!isOAuthConfigured(env)) return c.json({ error: 'Google OAuth is not configured' }, 400);
  const account = await findAccount(db, Number(c.req.param('id')));
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const redirectUri = getRedirectUri(c);
  const state = await createOAuthState(db, user.id, redirectUri);
  return c.json({ url: buildAuthUrl({ env, redirectUri, state, loginHint: account.email }) });
});

export default accounts;
