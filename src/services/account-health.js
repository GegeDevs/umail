import { getProfile } from './gmail.js';
import { logSystem } from './logger.js';

export async function checkAccountHealth(db, env, account) {
  try {
    const profile = await getProfile(db, env, account.id);
    await db.prepare(`
      UPDATE google_accounts
      SET status = 'healthy', last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).bind(account.id).run();
    return { ok: true, profile };
  } catch (error) {
    const reauth = Boolean(error.reauth) || error.status === 401 || error.code === 'invalid_grant';
    const status = reauth ? 'reauth_required' : 'error';
    const message = String(error.message || 'Account health check failed').slice(0, 500);
    await db.prepare(`
      UPDATE google_accounts
      SET status = ?, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(status, message, account.id).run();
    await logSystem(db, 'error', `Account check failed: ${account.email}`, message);
    return { ok: false, status, error: message };
  }
}
