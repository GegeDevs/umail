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
            '["INBOX","UNREAD"]', 1, 0, '{}')
  `).run();
  return { db, app: createApp(db, {}) };
}

function headers(extra = {}) {
  return {
    cookie: 'umail_session=tok',
    'x-csrf-token': 'csrf',
    'content-type': 'application/json',
    ...extra
  };
}

function uploadHeaders() {
  return { cookie: 'umail_session=tok', 'x-csrf-token': 'csrf' };
}

function mockGmail() {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/messages/m1')) {
      return Response.json({
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } },
            {
              partId: '2', mimeType: 'application/pdf', filename: 'a.pdf',
              body: { attachmentId: 'att1', size: 10 }
            }
          ]
        }
      });
    }
    if (url.pathname.includes('/attachments/att1')) {
      return Response.json({ data: Buffer.from('file-bytes').toString('base64url'), size: 10 });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
}

test('attachment links are signed and reject tampering', async () => {
  const { app } = await setup();
  const original = globalThis.fetch;
  mockGmail();
  try {
    const thread = await app.request('/api/mail/threads/1/t1', { headers: headers() });
    const data = await thread.json();
    const url = data.thread.messages[0].attachments[0].url;
    expect(url).toContain('token=');

    const ok = await app.request(url, { headers: headers() });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('file-bytes');

    const tampered = await app.request(url.replace(/token=[^&]+/, 'token=deadbeef'), { headers: headers() });
    expect(tampered.status).toBe(403);

    const expired = await app.request(url.replace(/exp=\d+/, 'exp=1000'), { headers: headers() });
    expect(expired.status).toBe(403);
  } finally {
    globalThis.fetch = original;
  }
});

test('database backup exports and restores rows', async () => {
  const { db, app } = await setup();
  const exported = await app.request('/api/backup/export', { headers: headers() });
  expect(exported.status).toBe(200);
  const bytes = new Uint8Array(await exported.arrayBuffer());
  expect(Buffer.from(bytes.subarray(0, 16)).toString('latin1')).toBe('SQLite format 3\u0000');

  await db.prepare("DELETE FROM messages WHERE gmail_message_id = 'm1'").run();
  await db.prepare("UPDATE google_accounts SET display_name = 'Changed' WHERE id = 1").run();

  const form = new FormData();
  form.append('file', new File([bytes], 'backup.db', { type: 'application/octet-stream' }));
  const restored = await app.request('/api/backup/import', {
    method: 'POST',
    headers: uploadHeaders(),
    body: form
  });
  expect(restored.status).toBe(200);
  expect((await restored.json()).ok).toBe(true);

  const message = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE gmail_message_id = 'm1'").first();
  expect(message.n).toBe(1);
  const account = await db.prepare('SELECT display_name FROM google_accounts WHERE id = 1').first();
  expect(account.display_name).toBe('Ada');
});

test('backup import rejects non-sqlite files', async () => {
  const { app } = await setup();
  const form = new FormData();
  form.append('file', new File(['not a database'], 'x.db'));
  const res = await app.request('/api/backup/import', {
    method: 'POST',
    headers: uploadHeaders(),
    body: form
  });
  expect(res.status).toBe(400);
});

test('image proxy blocks private hosts', async () => {
  const { app } = await setup();
  const res = await app.request(
    `/api/mail/image?url=${encodeURIComponent('http://127.0.0.1/secret.png')}`,
    { headers: headers() }
  );
  expect(res.status).toBe(403);
});

test('changing sync window resets sync state', async () => {
  const { db, app } = await setup();
  await db.prepare(
    "INSERT INTO sync_state (account_id, history_id, last_full_sync_at) VALUES (1, 'h1', datetime('now'))"
  ).run();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: 'offline' } }, { status: 500 });
  try {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ sync_window_days: '180' })
    });
    expect(res.status).toBe(200);
    const state = await db.prepare('SELECT COUNT(*) AS n FROM sync_state WHERE account_id = 1').first();
    expect(state.n).toBe(0);
    const saved = await db.prepare("SELECT value FROM settings WHERE key = 'sync_window_days'").first();
    expect(saved.value).toBe('180');
  } finally {
    globalThis.fetch = original;
  }
});

test('settings hide the signing secret and accept reply-all default', async () => {
  const { db, app } = await setup();
  const { verifyAttachment } = await import('../src/services/signing.js');
  expect(await verifyAttachment(db, 1, 'm1', 'att1', Date.now() + 1000, 'bad')).toBe(false);

  await db.prepare("UPDATE settings SET value = 'topsecret' WHERE key = 'signing_secret'").run();
  const settings = await app.request('/api/settings', { headers: headers() });
  expect(JSON.stringify(await settings.json())).not.toContain('topsecret');

  const saved = await app.request('/api/settings', {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ default_reply_all: '1' })
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).default_reply_all).toBe('1');
});

test('AI settings are stored from Settings, masked, and encrypted', async () => {
  const { db } = await setup();
  const app = createApp(db, { TOKEN_ENCRYPTION_KEY: 'secret-key' });
  const res = await app.request('/api/settings', {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      ai_base_url: 'https://ai.test/v1',
      ai_model: 'test-model',
      ai_api_key: 'sk-secret'
    })
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ai_base_url).toBe('https://ai.test/v1');
  expect(body.ai_model).toBe('test-model');
  expect(body.ai_api_key_set).toBe('1');
  expect(JSON.stringify(body)).not.toContain('sk-secret');

  const row = await db.prepare("SELECT value FROM settings WHERE key = 'ai_api_key'").first();
  expect(row.value.startsWith('enc:v1:')).toBe(true);
  expect(row.value).not.toContain('sk-secret');

  const listed = await app.request('/api/settings', { headers: headers() });
  const listedBody = await listed.json();
  expect(JSON.stringify(listedBody)).not.toContain('sk-secret');
  expect(listedBody.ai_api_key_set).toBe('1');
});
