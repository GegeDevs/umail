import { Hono } from 'hono';
import { requirePermission } from '../middleware/auth.js';

const logs = new Hono();

logs.get('/', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'admin:view_logs', user);
  if (err) return err;
  const db = c.get('db');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 100));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const level = c.req.query('level') || '';
  let sql = 'SELECT * FROM system_log WHERE 1=1';
  const params = [];
  if (level) { sql += ' AND level = ?'; params.push(level); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await db.prepare(sql).bind(...params).all();
  const total = await db.prepare('SELECT COUNT(*) AS count FROM system_log').first();
  return c.json({ results, total: total.count });
});

logs.delete('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role !== 'master') return c.json({ error: 'Master access required' }, 403);
  const db = c.get('db');
  await db.prepare('DELETE FROM system_log').run();
  return c.json({ success: true });
});

export default logs;
