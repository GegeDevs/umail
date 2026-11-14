import { Hono } from 'hono';
import { requirePermission } from '../middleware/auth.js';

const activity = new Hono();

activity.get('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:view_activity', user);
  if (err) return err;
  const db = c.get('db');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 100));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const username = c.req.query('user') || '';
  const action = c.req.query('action') || '';
  let sql = 'SELECT * FROM activity_log WHERE 1=1';
  const params = [];
  if (username) { sql += ' AND username = ?'; params.push(username); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await db.prepare(sql).bind(...params).all();
  const total = await db.prepare('SELECT COUNT(*) AS count FROM activity_log').first();
  return c.json({ results, total: total.count });
});

activity.delete('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role !== 'master') return c.json({ error: 'Master access required' }, 403);
  const db = c.get('db');
  await db.prepare('DELETE FROM activity_log').run();
  return c.json({ success: true });
});

export default activity;
