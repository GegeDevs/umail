import { refreshAccessToken } from './google-oauth.js';
import { decryptToken, encryptToken } from './token-crypto.js';

const locks = new Map();
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class TokenError extends Error {
  constructor(message, { reauth = true } = {}) {
    super(message);
    this.name = 'TokenError';
    this.reauth = reauth;
    this.status = 401;
  }
}

export async function getAccessToken(db, env, accountId) {
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) throw new TokenError('Google account not found', { reauth: false });
  const accessToken = decryptToken(account.access_token, env);
  if (accessToken && Number(account.token_expiry) > Date.now() + REFRESH_SKEW_MS) {
    return accessToken;
  }
  return refreshAccountToken(db, env, accountId);
}

export async function refreshAccountToken(db, env, accountId) {
  if (locks.has(accountId)) return locks.get(accountId);
  const promise = doRefresh(db, env, accountId).finally(() => locks.delete(accountId));
  locks.set(accountId, promise);
  return promise;
}

async function doRefresh(db, env, accountId) {
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) throw new TokenError('Google account not found', { reauth: false });

  try {
    const data = await refreshAccessToken(env, decryptToken(account.refresh_token, env));
    const expiry = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    await db.prepare(`
      UPDATE google_accounts
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
          token_expiry = ?, scopes = COALESCE(?, scopes),
          status = 'healthy', last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      encryptToken(data.access_token, env),
      data.refresh_token ? encryptToken(data.refresh_token, env) : null,
      expiry, data.scope || null, accountId
    ).run();
    return data.access_token;
  } catch (error) {
    if (error.reauth || error.code === 'invalid_grant' || error.code === 'missing_refresh_token') {
      await db.prepare(`
        UPDATE google_accounts
        SET status = 'reauth_required', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind('Reconnect this account to refresh access.', accountId).run();
      throw new TokenError('Reconnect required for this Google account', { reauth: true });
    }
    throw error;
  }
}
