import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { initDB } from '../src/db/index.js';
import { createApp } from '../src/app.js';

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
            '["INBOX","Label_new"]', 1, 0, '{}')
  `).run();
  return { db, app: createApp(db, {}) };
}

function headers() {
  return {
    cookie: 'umail_session=tok',
    'x-csrf-token': 'csrf',
    'content-type': 'application/json'
  };
}

function mockGmail(record) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    record.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/labels') && method === 'GET') {
      return Response.json({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_new', name: 'Groceries', type: 'user' }
        ]
      });
    }
    if (url.pathname.endsWith('/labels') && method === 'POST') {
      return Response.json({ id: 'Label_new', name: 'Groceries', type: 'user' }, { status: 200 });
    }
    if (url.pathname.includes('/labels/') && method === 'PATCH') {
      return Response.json({ id: 'Label_new', name: 'Errands', type: 'user' });
    }
    if (url.pathname.includes('/labels/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
}

test('label CRUD talks to Gmail and reconciles local cache', async () => {
  const { db, app } = await setup();
  const calls = [];
  const originalFetch = globalThis.fetch;
  mockGmail(calls);

  try {
    const created = await app.request('/api/mail/labels', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Groceries' })
    });
    expect(created.status).toBe(201);
    expect(calls.some((call) => call === 'POST /gmail/v1/users/me/labels')).toBe(true);
    const labelRow = await db.prepare(
      "SELECT name FROM labels WHERE account_id = 1 AND gmail_label_id = 'Label_new'"
    ).first();
    expect(labelRow.name).toBe('Groceries');

    const renamed = await app.request('/api/mail/labels', {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        name: 'Errands',
        accounts: [{ account_id: 1, gmail_label_id: 'Label_new' }]
      })
    });
    expect(renamed.status).toBe(200);
    expect(calls.some((call) => call === 'PATCH /gmail/v1/users/me/labels/Label_new')).toBe(true);

    const deleted = await app.request('/api/mail/labels', {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ accounts: [{ account_id: 1, gmail_label_id: 'Label_new' }] })
    });
    expect(deleted.status).toBe(200);
    const gone = await db.prepare(
      "SELECT COUNT(*) AS n FROM labels WHERE account_id = 1 AND gmail_label_id = 'Label_new'"
    ).first();
    expect(gone.n).toBe(0);
    const message = await db.prepare("SELECT label_ids FROM messages WHERE gmail_message_id = 'm1'").first();
    expect(message.label_ids).not.toContain('Label_new');
    expect(message.label_ids).toContain('INBOX');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('label CRUD validates input', async () => {
  const { app } = await setup();
  const empty = await app.request('/api/mail/labels', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name: '  ' })
  });
  expect(empty.status).toBe(400);

  const noTargets = await app.request('/api/mail/labels', {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify({ accounts: [] })
  });
  expect(noTargets.status).toBe(400);
});
