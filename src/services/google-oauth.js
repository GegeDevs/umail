export const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export class OAuthError extends Error {
  constructor(message, { code = 'oauth_error', status = 502, reauth = false } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
    this.reauth = reauth;
  }
}

const CLIENT_ID_RE = /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

export function isOAuthConfigured(env = {}) {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    CLIENT_ID_RE.test(env.GOOGLE_CLIENT_ID)
  );
}

export function getRedirectUri(c) {
  const env = c.get('env') || {};
  if (env.PUBLIC_URL) return `${String(env.PUBLIC_URL).replace(/\/+$/, '')}/auth/callback`;
  const proto = (c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')).split(',')[0].trim();
  const host = (c.req.header('x-forwarded-host') || c.req.header('host') || new URL(c.req.url).host).split(',')[0].trim();
  return `${proto}://${host}/auth/callback`;
}

export function buildAuthUrl({ env, redirectUri, state, loginHint }) {
  if (!isOAuthConfigured(env)) throw new OAuthError('Google OAuth is not configured', { code: 'oauth_not_configured', status: 500 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

export async function exchangeCode(env, { code, redirectUri }) {
  if (!isOAuthConfigured(env)) throw new OAuthError('Google OAuth is not configured', { code: 'oauth_not_configured', status: 500 });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await readJson(res);
  if (!res.ok || !data.access_token) {
    throw new OAuthError(data.error_description || data.error || 'Token exchange failed', {
      code: 'token_exchange_failed',
      status: 502,
      reauth: data.error === 'invalid_grant'
    });
  }
  return data;
}

export async function refreshAccessToken(env, refreshToken) {
  if (!isOAuthConfigured(env)) throw new OAuthError('Google OAuth is not configured', { code: 'oauth_not_configured', status: 500 });
  if (!refreshToken) throw new OAuthError('Reconnect required', { code: 'missing_refresh_token', status: 401, reauth: true });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await readJson(res);
  if (!res.ok || !data.access_token) {
    throw new OAuthError(data.error_description || data.error || 'Token refresh failed', {
      code: data.error || 'token_refresh_failed',
      status: 401,
      reauth: data.error === 'invalid_grant' || data.error === 'invalid_client'
    });
  }
  return data;
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000)
  });
  const data = await readJson(res);
  if (!res.ok || !data.email) {
    throw new OAuthError(data.error?.message || 'Could not read Google profile', { code: 'profile_failed', status: 502 });
  }
  return data;
}
