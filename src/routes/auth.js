import { Hono } from 'hono';
import { buildAuthUrl, exchangeCode, fetchUserInfo, getRedirectUri, isOAuthConfigured } from '../services/google-oauth.js';
import { fetchGmailProfile } from '../services/gmail.js';
import { createOAuthState, consumeOAuthState } from '../services/oauth-state.js';
import { pickAccountColor } from '../services/account-colors.js';
import { logActivity, logSystem } from '../services/logger.js';
import { triggerSync } from '../services/gmail-sync.js';
import { encryptToken } from '../services/token-crypto.js';

const auth = new Hono();

function cleanLoginHint(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export async function startOAuth(c, loginHint = '') {
  const db = c.get('db');
  const user = c.get('user');
  const env = c.get('env') || {};
  if (!user) return c.redirect('/#/login');
  if (user.role !== 'master' && !user.permissions.includes('accounts:add')) {
    return c.redirect('/#/accounts?oauth_error=permission');
  }
  if (!isOAuthConfigured(env)) return c.redirect('/#/accounts?oauth_error=not_configured');

  const redirectUri = getRedirectUri(c);
  const state = await createOAuthState(db, user.id, redirectUri);
  return c.redirect(buildAuthUrl({ env, redirectUri, state, loginHint: cleanLoginHint(loginHint) }));
}

auth.get('/google', async (c) => {
  return startOAuth(c, c.req.query('email') || c.req.query('login_hint'));
});

auth.get('/callback', async (c) => {
  const db = c.get('db');
  const env = c.get('env') || {};
  const user = c.get('user');
  if (!user) return c.redirect('/#/login');

  const fail = (code) => c.redirect(`/#/accounts?oauth_error=${encodeURIComponent(code)}`);
  const googleError = c.req.query('error');
  if (googleError) return fail(googleError === 'access_denied' ? 'denied' : 'google_error');

  const code = c.req.query('code');
  const state = c.req.query('state');
  const row = await consumeOAuthState(db, state, user.id);
  if (!row || !code) return fail('state');

  let tokens;
  let info;
  let profile;
  try {
    tokens = await exchangeCode(env, { code, redirectUri: row.redirect_uri });
    [info, profile] = await Promise.all([
      fetchUserInfo(tokens.access_token),
      fetchGmailProfile(tokens.access_token)
    ]);
  } catch (error) {
    await logSystem(db, 'error', 'Google OAuth failed', String(error.message || error).slice(0, 500));
    if (error.code === 'invalid_grant') return fail('denied');
    return fail(error.code === 'gmail_profile_failed' ? 'gmail_failed' : 'exchange_failed');
  }

  const email = String(info.email || '').trim().toLowerCase();
  const refreshToken = tokens.refresh_token || null;
  try {
    const existing = await db.prepare('SELECT * FROM google_accounts WHERE email = ?').bind(email).first();
    if (!refreshToken && !existing?.refresh_token) {
      await logSystem(db, 'error', 'Google OAuth returned no refresh token', email);
      return fail('no_refresh_token');
    }

    const expiry = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
    const encryptedAccess = encryptToken(tokens.access_token, env);
    const encryptedRefresh = refreshToken ? encryptToken(refreshToken, env) : null;
    let accountId;
    if (existing) {
      accountId = existing.id;
      await db.prepare(`
        UPDATE google_accounts
        SET display_name = ?, avatar_url = ?, access_token = ?,
            refresh_token = COALESCE(?, refresh_token), token_expiry = ?,
            scopes = COALESCE(?, scopes), history_id = COALESCE(?, history_id),
            status = 'healthy', last_error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        info.name || existing.display_name, info.picture || existing.avatar_url,
        encryptedAccess, encryptedRefresh, expiry, tokens.scope || null,
        profile.historyId || null, accountId
      ).run();
    } else {
      const { results } = await db.prepare('SELECT card_color FROM google_accounts').all();
      const color = pickAccountColor(results.map((row) => row.card_color));
      const count = await db.prepare('SELECT COUNT(*) AS count FROM google_accounts').first();
      const result = await db.prepare(`
        INSERT INTO google_accounts
          (email, display_name, avatar_url, access_token, refresh_token, token_expiry,
           scopes, history_id, is_default, card_color, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy')
      `).bind(
        email, info.name || null, info.picture || null, encryptedAccess, encryptedRefresh,
        expiry, tokens.scope || null, profile.historyId || null,
        Number(count.count) === 0 ? 1 : 0, color
      ).run();
      accountId = result.meta.last_row_id;
    }

    await db.prepare(
      'INSERT OR IGNORE INTO sync_state (account_id, history_id) VALUES (?, NULL)'
    ).bind(accountId).run();

    await logActivity(
      db, user.id, user.username,
      existing ? 'accounts.reconnect' : 'accounts.connect',
      email, accountId
    );
    triggerSync(db, env, accountId, { force: true }).catch(() => {});
  } catch (error) {
    await logSystem(db, 'error', 'Google account save failed', String(error.message || error).slice(0, 500));
    return fail('store_failed');
  }

  return c.redirect('/#/accounts?connected=1');
});

export default auth;
