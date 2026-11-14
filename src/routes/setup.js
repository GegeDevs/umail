import { Hono } from 'hono';
import { hashPassword } from '../services/password.js';
import { logActivity } from '../services/logger.js';
import { createSession, setSessionCookie } from '../middleware/auth.js';

const setup = new Hono();

setup.get('/status', async (c) => {
  const db = c.get('db');
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  return c.json({ initialized: Number(row.count) > 0 });
});

setup.post('/', async (c) => {
  const db = c.get('db');
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  if (Number(row.count) > 0) return c.json({ error: 'Setup already completed' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return c.json({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' }, 400);
  }
  if (password.length < 8 || password.length > 256) return c.json({ error: 'Password must be 8-256 characters' }, 400);

  const hash = await hashPassword(password);
  const recheck = await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  if (Number(recheck.count) > 0) return c.json({ error: 'Setup already completed' }, 409);
  const result = await db.prepare(
    "INSERT INTO users (username, password_hash, role, session_timeout_hours) VALUES (?, ?, 'master', 24)"
  ).bind(username, hash).run();
  const userId = result.meta.last_row_id;

  const session = await createSession(db, userId);
  setSessionCookie(c, session);
  await logActivity(db, userId, username, 'setup.complete', 'Master account created');

  return c.json({
    user: { id: userId, username, role: 'master', permissions: [] },
    csrf: session.csrfToken
  }, 201);
});

export default setup;
