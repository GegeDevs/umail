import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '../services/password.js';
import { logActivity } from '../services/logger.js';
import {
  ALL_PERMISSIONS, DEFAULT_SLAVE_PERMISSIONS, PERMISSION_GROUPS,
  clearSessionCookie, createSession, deleteSession, getPermissions, getSessionToken,
  getUser, requireAuth, requireMaster, requirePermission, setSessionCookie
} from '../middleware/auth.js';

const users = new Hono();
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function clientKey(c) {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
}

function blocked(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry) return false;
  entry.hits = entry.hits.filter((ts) => now - ts < WINDOW_MS);
  if (!entry.hits.length) { attempts.delete(key); return false; }
  return entry.hits.length >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = attempts.get(key) || { hits: [] };
  entry.hits.push(Date.now());
  attempts.set(key, entry);
}

function userPayload(user, permissions, csrf = null) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    is_active: Boolean(user.is_active),
    session_timeout_hours: user.session_timeout_hours,
    permissions,
    ...(csrf ? { csrf } : {})
  };
}

users.get('/check', async (c) => {
  const db = c.get('db');
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  return c.json({ initialized: Number(row.count) > 0 });
});

users.post('/login', async (c) => {
  const db = c.get('db');
  const key = clientKey(c);
  if (blocked(key)) return c.json({ error: 'Too many login attempts. Try again later.' }, 429);

  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!password || password.length > 256) return c.json({ error: 'Invalid credentials' }, 401);
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordFailure(key);
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  if (!user.is_active) return c.json({ error: 'Account is disabled' }, 403);

  attempts.delete(key);
  const session = await createSession(db, user.id);
  const permissions = user.role === 'master' ? ALL_PERMISSIONS : await getPermissions(db, user.id);
  await logActivity(db, user.id, user.username, 'auth.login', null);
  setSessionCookie(c, session);
  return c.json(userPayload(user, permissions, session.csrfToken));
});

users.post('/logout', async (c) => {
  const user = c.get('user');
  const err = requireAuth(c, user);
  if (err) return err;
  const db = c.get('db');
  await deleteSession(db, getSessionToken(c));
  clearSessionCookie(c);
  await logActivity(db, user.id, user.username, 'auth.logout', null);
  return c.json({ success: true });
});

users.get('/me', async (c) => {
  const user = c.get('user');
  const err = requireAuth(c, user);
  if (err) return err;
  const csrf = c.get('session')?.csrf_token || null;
  return c.json(userPayload(user, user.permissions, csrf));
});

users.get('/permission-groups', async (c) => {
  const user = c.get('user');
  const err = requireAuth(c, user);
  if (err) return err;
  return c.json({ groups: PERMISSION_GROUPS, all: ALL_PERMISSIONS, defaults: DEFAULT_SLAVE_PERMISSIONS });
});

users.get('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:view_users', user);
  if (err) return err;
  const db = c.get('db');
  const { results } = await db.prepare(
    'SELECT id, username, role, is_active, session_timeout_hours, created_at, updated_at FROM users ORDER BY id'
  ).all();
  const rows = [];
  for (const row of results) {
    rows.push({ ...row, permissions: row.role === 'master' ? ALL_PERMISSIONS : await getPermissions(db, row.id) });
  }
  return c.json({ results: rows });
});

users.post('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:manage_users', user);
  if (err) return err;
  const db = c.get('db');
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const role = body.role === 'master' ? 'master' : 'slave';
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return c.json({ error: 'Invalid username' }, 400);
  if (password.length < 8 || password.length > 256) return c.json({ error: 'Password must be 8-256 characters' }, 400);
  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return c.json({ error: 'Username already exists' }, 409);

  const hash = await hashPassword(password);
  const result = await db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .bind(username, hash, role).run();
  const id = result.meta.last_row_id;
  const permissions = Array.isArray(body.permissions) ? body.permissions.filter((p) => ALL_PERMISSIONS.includes(p)) : DEFAULT_SLAVE_PERMISSIONS;
  if (role === 'slave') {
    for (const permission of permissions) {
      await db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)').bind(id, permission).run();
    }
  }
  await logActivity(db, user.id, user.username, 'users.create', `Created ${username} (${role})`);
  const created = await getUser(db, id);
  return c.json({ user: { ...created, permissions: role === 'master' ? ALL_PERMISSIONS : permissions } }, 201);
});

users.patch('/:id', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:manage_users', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const target = await getUser(db, id);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (body.role && id === user.id) return c.json({ error: 'Cannot change your own role' }, 400);
  if (body.is_active === false && id === user.id) return c.json({ error: 'Cannot disable yourself' }, 400);

  if (body.role && ['master', 'slave'].includes(body.role)) {
    await db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(body.role, id).run();
  }
  if (typeof body.is_active === 'boolean') {
    await db.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?").bind(body.is_active ? 1 : 0, id).run();
  }
  if (body.session_timeout_hours !== undefined) {
    const hours = Math.max(1, Math.min(720, Number(body.session_timeout_hours) || 24));
    await db.prepare("UPDATE users SET session_timeout_hours = ?, updated_at = datetime('now') WHERE id = ?").bind(hours, id).run();
  }
  await logActivity(db, user.id, user.username, 'users.update', `Updated ${target.username}`);
  return c.json({ user: await getUser(db, id) });
});

users.delete('/:id', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:manage_users', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  if (id === user.id) return c.json({ error: 'Cannot delete yourself' }, 400);
  const target = await getUser(db, id);
  if (!target) return c.json({ error: 'User not found' }, 404);
  if (target.role === 'master') {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'master'").first();
    if (Number(row.count) <= 1) return c.json({ error: 'Cannot delete the last master' }, 400);
  }
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  await logActivity(db, user.id, user.username, 'users.delete', `Deleted ${target.username}`);
  return c.json({ success: true });
});

users.get('/:id/permissions', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:edit_permissions', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const target = await getUser(db, id);
  if (!target) return c.json({ error: 'User not found' }, 404);
  return c.json({ permissions: target.role === 'master' ? ALL_PERMISSIONS : await getPermissions(db, id) });
});

users.put('/:id/permissions', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:edit_permissions', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const target = await getUser(db, id);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const permissions = Array.isArray(body.permissions)
    ? [...new Set(body.permissions.filter((p) => ALL_PERMISSIONS.includes(p)))]
    : [];
  await db.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(id).run();
  for (const permission of permissions) {
    await db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)').bind(id, permission).run();
  }
  await logActivity(db, user.id, user.username, 'users.permissions', `Updated permissions for ${target.username}`);
  return c.json({ permissions });
});

users.post('/:id/password', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:manage_users', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const target = await getUser(db, id);
  if (!target) return c.json({ error: 'User not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password || '');
  if (password.length < 8 || password.length > 256) return c.json({ error: 'Password must be 8-256 characters' }, 400);
  const hash = await hashPassword(password);
  await db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(hash, id).run();
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  await logActivity(db, user.id, user.username, 'users.password', `Reset password for ${target.username}`);
  return c.json({ success: true });
});

export default users;
