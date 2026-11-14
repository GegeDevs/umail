import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'umail_session';

export const PERMISSION_GROUPS = {
  mail: [
    'mail:view', 'mail:read', 'mail:send', 'mail:draft', 'mail:modify',
    'mail:archive', 'mail:delete', 'mail:spam', 'mail:labels',
    'mail:attachments', 'mail:search'
  ],
  accounts: [
    'accounts:view', 'accounts:view_email', 'accounts:add', 'accounts:remove',
    'accounts:refresh', 'accounts:color', 'accounts:set_default', 'accounts:signature'
  ],
  settings: ['settings:view', 'settings:edit', 'settings:database'],
  admin: [
    'admin:view_users', 'admin:manage_users', 'admin:edit_permissions',
    'admin:view_activity', 'admin:view_logs', 'admin:manage_api',
    'admin:view_api_docs'
  ]
};

export const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flat();
export const DEFAULT_SLAVE_PERMISSIONS = ['mail:view', 'mail:read', 'mail:search', 'mail:attachments'];

export function hasPageAccess(permissions, page) {
  const group = PERMISSION_GROUPS[page];
  return Boolean(group && group.some((permission) => permissions.includes(permission)));
}

function makeToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export async function authenticate(db, request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  const headerToken = request.headers.get('x-session-token');
  const token = cookieMatch?.[1] || headerToken;
  if (!token) return null;

  const session = await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!session || new Date(session.expires_at) <= new Date()) {
    if (session) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  const user = await db.prepare(
    'SELECT id, username, role, is_active, session_timeout_hours FROM users WHERE id = ?'
  ).bind(session.user_id).first();
  if (!user || !user.is_active) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  let permissions = ALL_PERMISSIONS;
  if (user.role !== 'master') {
    const { results } = await db.prepare('SELECT permission FROM user_permissions WHERE user_id = ?')
      .bind(user.id).all();
    permissions = results.map((row) => row.permission);
  }

  return { user: { ...user, permissions }, session };
}

export function requireAuth(c, user = c.get('user')) {
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  return null;
}

export function requireMaster(c, user = c.get('user')) {
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role !== 'master') return c.json({ error: 'Master access required' }, 403);
  return null;
}

export function requirePermission(c, permission, user = c.get('user')) {
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role === 'master' || user.permissions.includes(permission)) return null;
  return c.json({ error: `Permission denied: ${permission}` }, 403);
}

export function requirePage(c, page, user = c.get('user')) {
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role === 'master' || hasPageAccess(user.permissions, page)) return null;
  return c.json({ error: 'Page access denied' }, 403);
}

export async function createSession(db, userId) {
  const user = await db.prepare('SELECT session_timeout_hours FROM users WHERE id = ?').bind(userId).first();
  const hours = Math.max(1, Math.min(720, Number(user?.session_timeout_hours) || 24));
  const token = makeToken();
  const csrfToken = makeToken(24);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, csrfToken, expiresAt).run();
  return { token, csrfToken, expiresAt, maxAge: hours * 3600 };
}

export async function deleteSession(db, token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export function isSecureRequest(c) {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c, session) {
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    path: '/',
    maxAge: session.maxAge
  });
}

export function clearSessionCookie(c) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function getSessionToken(c) {
  return getCookie(c, SESSION_COOKIE) || c.req.header('x-session-token') || null;
}

export function getUser(db, id) {
  return db.prepare(
    'SELECT id, username, role, is_active, session_timeout_hours, created_at, updated_at FROM users WHERE id = ?'
  ).bind(id).first();
}

export async function getPermissions(db, userId) {
  const { results } = await db.prepare('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission')
    .bind(userId).all();
  return results.map((row) => row.permission);
}
