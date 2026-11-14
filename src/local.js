import { serveStatic } from 'hono/bun';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { getDB, initDB } from './db/index.js';
import { getEnv } from './config.js';
import { startSyncScheduler } from './services/sync-scheduler.js';
import { startOutboxWorker } from './services/outbox.js';
import { encryptStoredTokens, encryptStoredChat, hasTokenEncryptionKey } from './services/token-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', 'dist');

const db = getDB();
await initDB(db);

const env = getEnv();
if (hasTokenEncryptionKey(env)) {
  const encrypted = await encryptStoredTokens(db, env);
  if (encrypted) console.log(`Encrypted tokens for ${encrypted} account(s).`);
  const chats = await encryptStoredChat(db, env);
  if (chats) console.log(`Encrypted ${chats} chat message(s).`);
} else {
  console.warn('TOKEN_ENCRYPTION_KEY is not set; OAuth tokens are stored in plaintext.');
}
const app = createApp(db, env);

if (existsSync(join(distPath, 'index.html'))) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', (c) => {
    if (new URL(c.req.url).pathname.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.html(readFileSync(join(distPath, 'index.html'), 'utf-8'));
  });
}

const port = Number(process.env.PORT) || 3000;
const server = Bun.serve({ port, fetch: app.fetch });
startSyncScheduler(db, env);
startOutboxWorker(db, env);
console.log(`UMail running on ${server.url}`);
