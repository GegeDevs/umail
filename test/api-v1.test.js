import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { initDB } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createApiKey } from '../src/services/api-keys.js';

async function setup() {
  const db = wrapDatabase(new Database(':memory:'));
  await initDB(db);
  await db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('master', 'x', 'master')").run();
  await db.prepare(`
    INSERT INTO sessions (token, user_id, csrf_token, expires_at)
    VALUES ('tok', 1, 'csrf', ?)
  `).bind(new Date(Date.now() + 3600000).toISOString()).run();
  await db.prepare(`
    INSERT INTO google_accounts (email, display_name, access_token, refresh_token, token_expiry, card_color)
    VALUES ('ada@example.com', 'Ada', 'token', 'refresh', ?, '#2563eb')
  `).bind(Date.now() + 3600000).run();
  await db.prepare(`
    INSERT INTO messages
      (account_id, gmail_message_id, gmail_thread_id, internal_date, from_name, from_email,
       to_json, subject, snippet, label_ids, is_unread, is_starred, raw_headers_json)
    VALUES (1, 'm1', 't1', 2000, 'Bob', 'bob@example.com', '[]', 'Hello', 'snippet',
            '["INBOX","UNREAD"]', 1, 0, '{}')
  `).run();
  return { db, app: createApp(db, {}) };
}

function sessionHeaders(extra = {}) {
  return { cookie: 'umail_session=tok', ...extra };
}

test('API key creation, bearer auth, permissions, rate limit, revoke', async () => {
  const { db, app } = await setup();

  const created = await app.request('/api/api-keys', {
    method: 'POST',
    headers: sessionHeaders({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
    body: JSON.stringify({ name: 'Automation', permissions: ['api:mail:read'], rateLimit: 60 })
  });
  expect(created.status).toBe(201);
  const { key } = await created.json();
  expect(key.startsWith('umail_')).toBe(true);

  const messages = await app.request('/api/v1/messages?box=inbox', {
    headers: { authorization: `Bearer ${key}` }
  });
  expect(messages.status).toBe(200);
  const data = await messages.json();
  expect(data.results[0].gmail_message_id).toBe('m1');
  expect(messages.headers.get('x-ratelimit-limit')).toBe('60');

  const denied = await app.request('/api/v1/accounts', {
    headers: { authorization: `Bearer ${key}` }
  });
  expect(denied.status).toBe(403);

  const missing = await app.request('/api/v1/messages');
  expect(missing.status).toBe(401);

  const invalid = await app.request('/api/v1/messages', {
    headers: { authorization: 'Bearer umail_nope' }
  });
  expect(invalid.status).toBe(401);

  const limited = await createApiKey(db, {
    name: 'Tiny', permissions: ['api:mail:read'], rateLimit: 1
  });
  const first = await app.request('/api/v1/messages', {
    headers: { authorization: `Bearer ${limited.key}` }
  });
  expect(first.status).toBe(200);
  const second = await app.request('/api/v1/messages', {
    headers: { authorization: `Bearer ${limited.key}` }
  });
  expect(second.status).toBe(429);

  const revoke = await app.request(`/api/api-keys/${limited.id}`, {
    method: 'DELETE',
    headers: sessionHeaders({ 'x-csrf-token': 'csrf' })
  });
  expect(revoke.status).toBe(200);
  const afterRevoke = await app.request('/api/v1/messages', {
    headers: { authorization: `Bearer ${limited.key}` }
  });
  expect(afterRevoke.status).toBe(401);
});

test('API modify action uses Gmail batchModify and updates cache', async () => {
  const { db, app } = await setup();
  const { key } = await createApiKey(db, {
    name: 'Modifier', permissions: ['api:mail:modify'], rateLimit: 60
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/messages/batchModify')) return new Response(null, { status: 204 });
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };

  try {
    const response = await app.request('/api/v1/messages/actions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 1, messageIds: ['m1'], action: 'read' })
    });
    expect(response.status).toBe(200);
    const row = await db.prepare("SELECT is_unread, label_ids FROM messages WHERE gmail_message_id = 'm1'").first();
    expect(row.is_unread).toBe(0);
    expect(row.label_ids).not.toContain('UNREAD');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
