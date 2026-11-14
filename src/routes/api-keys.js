import { Hono } from 'hono';
import { requirePage, requirePermission } from '../middleware/auth.js';
import { API_PERMISSIONS, createApiKey, listApiKeys, revokeApiKey } from '../services/api-keys.js';

const apiKeys = new Hono();

function guard(c) {
  const user = c.get('user');
  let err = requirePage(c, 'admin', user);
  if (err) return err;
  return requirePermission(c, 'admin:manage_api', user);
}

apiKeys.get('/', async (c) => {
  const err = guard(c);
  if (err) return err;
  return c.json({
    results: await listApiKeys(c.get('db')),
    permissions: API_PERMISSIONS
  });
});

apiKeys.post('/', async (c) => {
  const err = guard(c);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  if (!String(body.name || '').trim()) return c.json({ error: 'Name is required' }, 400);
  const created = await createApiKey(c.get('db'), {
    name: body.name,
    userId: c.get('user').id,
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
    rateLimit: body.rateLimit,
    expiresDays: body.expiresDays
  });
  return c.json(created, 201);
});

apiKeys.delete('/:id', async (c) => {
  const err = guard(c);
  if (err) return err;
  const removed = await revokeApiKey(c.get('db'), c.req.param('id'));
  if (!removed) return c.json({ error: 'API key not found' }, 404);
  return c.json({ ok: true });
});

export default apiKeys;
