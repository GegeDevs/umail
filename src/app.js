import { Hono } from 'hono';
import { authenticate } from './middleware/auth.js';
import setupRoutes from './routes/setup.js';
import userRoutes from './routes/users.js';
import accountRoutes from './routes/accounts.js';
import authRoutes from './routes/auth.js';
import mailRoutes from './routes/mail.js';
import imageProxyRoutes from './routes/image-proxy.js';
import attachmentRoutes from './routes/attachments.js';
import settingsRoutes from './routes/settings.js';
import activityRoutes from './routes/activity.js';
import logsRoutes from './routes/logs.js';
import apiKeyRoutes from './routes/api-keys.js';
import apiV1Routes from './routes/api-v1.js';
import backupRoutes from './routes/backup.js';

const PUBLIC_WRITES = new Set(['/api/setup', '/api/users/login']);

export function createApp(db, envVars = {}) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('env', envVars);
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const auth = await authenticate(db, c.req.raw);
    if (auth) {
      c.set('user', auth.user);
      c.set('session', auth.session);
    }

    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const mutate = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (mutate && !PUBLIC_WRITES.has(path) && !path.startsWith('/api/v1/')) {
      if (!auth) return c.json({ error: 'Authentication required' }, 401);
      const csrf = c.req.header('x-csrf-token');
      if (!csrf || csrf !== auth.session.csrf_token) {
        return c.json({ error: 'Invalid CSRF token' }, 403);
      }
    }
    await next();
  });

  app.use('/auth/*', async (c, next) => {
    const auth = await authenticate(db, c.req.raw);
    if (auth) {
      c.set('user', auth.user);
      c.set('session', auth.session);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, name: 'UMail' }));
  app.route('/api/setup', setupRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/accounts', accountRoutes);
  app.route('/auth', authRoutes);
  app.route('/api/mail/image', imageProxyRoutes);
  app.route('/api/mail', mailRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/settings', settingsRoutes);
  app.route('/api/activity', activityRoutes);
  app.route('/api/logs', logsRoutes);
  app.route('/api/api-keys', apiKeyRoutes);
  app.route('/api/backup', backupRoutes);
  app.route('/api/v1', apiV1Routes);

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.text('Not found', 404);
  });

  app.onError((err, c) => {
    console.error('[umail]', err?.stack || err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
