import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { initDB } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

async function setup(env = {}) {
  const db = wrapDatabase(new Database(':memory:'));
  await initDB(db);
  await db.prepare(`
    INSERT INTO users (username, password_hash, role) VALUES ('master', 'x', 'master')
  `).run();
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
            '["INBOX","UNREAD"]', 1, 0, '{"messageId":"<m1@x>"}')
  `).run();
  return { db, app: createApp(db, env) };
}

function headers(extra = {}) {
  return { cookie: 'umail_session=tok', ...extra };
}

test('mail list, thread body, read action, send, draft, and attachment', async () => {
  const { db, app } = await setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/messages/m1')) {
      return Response.json({
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/html', body: { data: b64('<p>Hi there</p>') } },
            {
              partId: '2', mimeType: 'application/pdf', filename: 'a.pdf',
              body: { attachmentId: 'att1', size: 10 }
            }
          ]
        }
      });
    }
    if (path.endsWith('/messages/batchModify')) return new Response(null, { status: 204 });
    if (path.endsWith('/messages/send')) {
      return Response.json({ id: 'sent1', threadId: 't1', labelIds: ['SENT'] });
    }
    if (path.endsWith('/drafts')) return Response.json({ id: 'draft1', message: { id: 'dm1' } });
    if (path.includes('/drafts/draft1')) return new Response(null, { status: 204 });
    if (path.includes('/attachments/att1')) return Response.json({ data: b64('file-bytes'), size: 10 });
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };

  try {
    const list = await app.request('/api/mail?box=inbox', { headers: headers() });
    expect(list.status).toBe(200);
    const listData = await list.json();
    expect(listData.total).toBe(1);
    expect(listData.results[0].gmail_message_id).toBe('m1');
    expect(listData.accounts[0].id).toBe(1);

    const thread = await app.request('/api/mail/threads/1/t1', { headers: headers() });
    expect(thread.status).toBe(200);
    const threadData = await thread.json();
    expect(threadData.thread.messages[0].body_html).toContain('Hi there');
    const attachmentUrl = threadData.thread.messages[0].attachments[0].url;
    expect(attachmentUrl).toContain('/api/attachments/1/m1/att1');
    expect(attachmentUrl).toContain('token=');
    expect(threadData.mark_read_on_open).toBe(true);

    const action = await app.request('/api/mail/actions', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ accountId: 1, messageIds: ['m1'], action: 'read' })
    });
    expect(action.status).toBe(200);
    let row = await db.prepare("SELECT * FROM messages WHERE gmail_message_id = 'm1'").first();
    expect(row.is_unread).toBe(0);
    expect(row.label_ids).not.toContain('UNREAD');

    const sent = await app.request('/api/mail/send', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ accountId: 1, to: 'bob@example.com', subject: 'Re', body: 'Hello' })
    });
    expect(sent.status).toBe(200);
    expect((await sent.json()).messageId).toBe('sent1');
    row = await db.prepare("SELECT * FROM messages WHERE gmail_message_id = 'sent1'").first();
    expect(row.label_ids).toContain('SENT');

    const draft = await app.request('/api/mail/drafts', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ accountId: 1, to: 'bob@example.com', subject: 'Draft', body: 'x' })
    });
    expect(draft.status).toBe(200);
    const draftData = await draft.json();
    expect(draftData.draft.gmail_draft_id).toBe('draft1');

    const attachment = await app.request(attachmentUrl, { headers: headers() });
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe('file-bytes');
    expect(attachment.headers.get('content-disposition')).toContain('a.pdf');

    const discard = await app.request(`/api/mail/drafts/${draftData.draft.id}`, {
      method: 'DELETE',
      headers: headers({ 'x-csrf-token': 'csrf' })
    });
    expect(discard.status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM drafts').first()).toEqual({ n: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search fan-out, label filter, apply and remove label', async () => {
  const { db, app } = await setup();
  await db.prepare("INSERT INTO labels (account_id, gmail_label_id, name, type) VALUES (1, 'Label_9', 'Work', 'user')").run();
  await db.prepare("UPDATE messages SET label_ids = ? WHERE gmail_message_id = 'm1'")
    .bind(JSON.stringify(['INBOX', 'Label_9'])).run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/messages/m2')) {
      return Response.json({
        id: 'm2', threadId: 't2', internalDate: '3000', labelIds: ['INBOX'],
        snippet: 'Quarterly report',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Eve <eve@example.com>' },
            { name: 'Subject', value: 'Report' }
          ]
        }
      });
    }
    if (path.endsWith('/users/me/messages')) {
      return Response.json({ messages: [{ id: 'm2', threadId: 't2' }], resultSizeEstimate: 1 });
    }
    if (path.endsWith('/messages/batchModify')) return new Response(null, { status: 204 });
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };

  try {
    const search = await app.request('/api/mail/search?q=report', { headers: headers() });
    expect(search.status).toBe(200);
    const data = await search.json();
    expect(data.total).toBe(1);
    expect(data.results[0].gmail_message_id).toBe('m2');
    expect(data.accounts[0].count).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE gmail_message_id = 'm2'").first())
      .toEqual({ n: 1 });

    const filtered = await app.request('/api/mail?label=Work', { headers: headers() });
    const filteredData = await filtered.json();
    expect(filteredData.label).toBe('Work');
    expect(filteredData.results.map((row) => row.gmail_message_id)).toEqual(['m1']);

    const applyHeaders = headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' });
    const apply = await app.request('/api/mail/actions', {
      method: 'POST', headers: applyHeaders,
      body: JSON.stringify({ accountId: 1, messageIds: ['m1'], action: 'apply_label', labelId: 'Label_9' })
    });
    expect(apply.status).toBe(200);
    let row = await db.prepare("SELECT label_ids FROM messages WHERE gmail_message_id = 'm1'").first();
    expect(row.label_ids).toContain('Label_9');

    await app.request('/api/mail/actions', {
      method: 'POST', headers: applyHeaders,
      body: JSON.stringify({ accountId: 1, messageIds: ['m1'], action: 'remove_label', labelId: 'Label_9' })
    });
    row = await db.prepare("SELECT label_ids FROM messages WHERE gmail_message_id = 'm1'").first();
    expect(row.label_ids).not.toContain('Label_9');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('clears all spam into Trash through Gmail batchModify and updates cache', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO messages
      (account_id, gmail_message_id, gmail_thread_id, internal_date, from_name, from_email,
       to_json, subject, snippet, label_ids, is_unread, is_starred, raw_headers_json)
    VALUES (1, 'spam1', 'st1', 3000, 'Spammer', 'spam@example.com', '[]', 'Buy now', '',
            '["SPAM"]', 1, 0, '{}')
  `).run();
  const originalFetch = globalThis.fetch;
  const modifyBodies = [];
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/messages/batchModify')) {
      modifyBodies.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/messages')) {
      const query = new URL(String(input)).searchParams;
      expect(query.get('q')).toBe('in:spam');
      return Response.json({ messages: [{ id: 'spam1', threadId: 'st1' }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/spam/clear', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ accountId: 1 })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1, failed: 0, errors: [] });
    expect(modifyBodies).toEqual([{
      ids: ['spam1'],
      addLabelIds: ['TRASH'],
      removeLabelIds: ['SPAM', 'INBOX']
    }]);
    const row = await db.prepare("SELECT label_ids FROM messages WHERE gmail_message_id = 'spam1'").first();
    expect(row.label_ids).toContain('TRASH');
    expect(row.label_ids).not.toContain('SPAM');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('schedules a send, lists it, and cancels it back into the composer payload', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO drafts (account_id, to_json, subject, body)
    VALUES (1, '["ada@example.com"]', 'Later', 'Hello later')
  `).run();
  const draft = await db.prepare('SELECT id FROM drafts').first();
  const post = headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' });

  const res = await app.request('/api/mail/send', {
    method: 'POST',
    headers: post,
    body: JSON.stringify({
      accountId: 1,
      to: 'ada@example.com',
      subject: 'Later',
      body: 'Hello later',
      draftId: draft.id,
      undo: true
    })
  });
  expect(res.status).toBe(200);
  const scheduled = await res.json();
  expect(scheduled.scheduled).toBe(true);
  expect(scheduled.outboxId).toBeGreaterThan(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM drafts').first()).toEqual({ n: 0 });

  const outboxRow = await db.prepare('SELECT status, payload_json, next_attempt_at FROM outbox WHERE id = ?')
    .bind(scheduled.outboxId).first();
  expect(outboxRow.status).toBe('queued');
  expect(JSON.parse(outboxRow.payload_json).subject).toBe('Later');
  expect(new Date(`${outboxRow.next_attempt_at.replace(' ', 'T')}Z`).getTime()).toBeGreaterThan(Date.now());

  const list = await app.request('/api/mail/outbox', { headers: post });
  expect((await list.json()).results).toEqual([
    expect.objectContaining({ id: scheduled.outboxId, account_id: 1, subject: 'Later' })
  ]);

  const cancel = await app.request(`/api/mail/outbox/${scheduled.outboxId}/cancel`, {
    method: 'POST', headers: post
  });
  expect(cancel.status).toBe(200);
  expect((await cancel.json()).payload.subject).toBe('Later');
  expect(await db.prepare('SELECT COUNT(*) AS n FROM outbox').first()).toEqual({ n: 0 });
});

test('rejects scheduled times outside the allowed window', async () => {
  const { app } = await setup();
  const post = headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' });
  const res = await app.request('/api/mail/send', {
    method: 'POST',
    headers: post,
    body: JSON.stringify({ accountId: 1, to: 'ada@example.com', sendAt: Date.now() - 1000 })
  });
  expect(res.status).toBe(400);
});

test('summarizes a thread with the configured OpenAI-compatible endpoint', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  let aiRequest = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequest = { path: url.pathname, auth: options.headers.Authorization, body: JSON.parse(options.body) };
      return Response.json({ choices: [{ message: { content: '- Deploy on Friday\n- Bob owns the report' } }] });
    }
    if (url.pathname.endsWith('/messages/m1')) {
      return Response.json({
        id: 'm1',
        threadId: 't1',
        payload: { mimeType: 'text/plain', body: { data: b64('Hello team, deploy on Friday.') } }
      });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/threads/1/t1/summary', {
      method: 'POST', headers: headers({ 'x-csrf-token': 'csrf' })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toContain('Deploy on Friday');
    expect(aiRequest.path).toBe('/v1/chat/completions');
    expect(aiRequest.auth).toBe('Bearer test-key');
    expect(aiRequest.body.model).toBe('test-model');
    expect(aiRequest.body.messages[1].content).toContain('Hello team, deploy on Friday.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI summary reports missing configuration', async () => {
  const { app } = await setup();
  const res = await app.request('/api/mail/threads/1/t1/summary', {
    method: 'POST', headers: headers({ 'x-csrf-token': 'csrf' })
  });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toContain('Settings');
});

test('compose assist sends the draft and mode to the AI provider', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  let aiRequest = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequest = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'Short version.' } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/compose', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ text: 'A very long email body.', mode: 'shorten' })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Short version.' });
    expect(aiRequest.messages[1].content).toContain('Shorten this email');
    expect(aiRequest.messages[1].content).toContain('A very long email body.');

    const empty = await app.request('/api/mail/ai/compose', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ text: '   ', mode: 'rewrite' })
    });
    expect(empty.status).toBe(400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI chat runs a read-only search tool and returns sources', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequests.push(JSON.parse(options.body));
      const content = aiRequests.length === 1
        ? '{"tool":"search_mail","args":{"query":"Hello","accountId":0}}'
        : '{"answer":"Ada punya email dari Bob dengan subjek Hello."}';
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Ada email dari Bob?' }] })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answer).toContain('Bob');
    expect(data.sources).toEqual([{ accountId: 1, threadId: 't1', subject: 'Hello', from: 'Bob' }]);
    expect(aiRequests).toHaveLength(2);
    const toolResult = aiRequests[1].messages.at(-1).content;
    expect(toolResult).toContain('TOOL RESULT search_mail');
    expect(toolResult).toContain('"subject":"Hello"');
    expect(toolResult).toContain('"threadId":"t1"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI chat rejects a history without a user message', async () => {
  const { app } = await setup();
  const res = await app.request('/api/mail/ai/chat', {
    method: 'POST',
    headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
    body: JSON.stringify({ messages: [{ role: 'assistant', content: 'hi' }] })
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('user message');
});

test('AI chat retries a false "tools unavailable" answer and searches multi-word queries', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO messages
      (account_id, gmail_message_id, gmail_thread_id, internal_date, from_name, from_email,
       to_json, subject, snippet, label_ids, is_unread, is_starred, raw_headers_json)
    VALUES (1, 'm2', 't2', 3000, 'Bank Lampung', 'noreply@banklampung.co.id', '[]',
            'L online - QRIS', 'Transaksi QRIS berhasil', '["INBOX"]', 0, 0, '{}')
  `).run();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequests.push(JSON.parse(options.body));
      const content = aiRequests.length === 1
        ? '{"answer":"Maaf, tool pencarian tidak aktif di sesi ini."}'
        : aiRequests.length === 2
          ? '{"tool":"search_mail","args":{"query":"daftar email bank lampung","accountId":0}}'
          : '{"answer":"Ada email QRIS dari Bank Lampung."}';
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'daftar email bank lampung' }] })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answer).toContain('Bank Lampung');
    expect(aiRequests).toHaveLength(3);
    expect(aiRequests[2].messages.at(-1).content).toContain('"subject":"L online - QRIS"');
    expect(aiRequests[2].messages.at(-1).content).toContain('"queryTerms":["bank","lampung"]');
    expect(data.sources).toContainEqual({ accountId: 1, threadId: 't2', subject: 'L online - QRIS', from: 'Bank Lampung' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI chat can list the newest mail with an empty search query', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO messages
      (account_id, gmail_message_id, gmail_thread_id, internal_date, from_name, from_email,
       to_json, subject, snippet, label_ids, is_unread, is_starred, raw_headers_json)
    VALUES (1, 'm2', 't2', 3000, 'Newest', 'newest@example.com', '[]',
            'Fresh mail', 'today', '["INBOX"]', 1, 0, '{}')
  `).run();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).hostname === 'ai.test') {
      aiRequests.push(JSON.parse(options.body));
      const content = aiRequests.length === 1
        ? '{"tool":"search_mail","args":{"query":"","accountId":0}}'
        : '{"answer":"Email terbaru: Fresh mail."}';
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Ada email hari ini?' }] })
    });
    expect(res.status).toBe(200);
    const toolResult = aiRequests[1].messages.at(-1).content;
    expect(toolResult).toContain('"queryTerms":[]');
    expect(toolResult.indexOf('"threadId":"t2"')).toBeLessThan(toolResult.indexOf('"threadId":"t1"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('AI chat searches Gmail live and stores the results', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequests.push(JSON.parse(options.body));
      const content = aiRequests.length === 1
        ? '{"tool":"search_mail","args":{"query":"","accountId":0}}'
        : '{"answer":"Email live terbaru: Live subject."}';
      return Response.json({ choices: [{ message: { content } }] });
    }
    if (url.hostname === 'gmail.googleapis.com') {
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'live1' }] });
      return Response.json({
        id: 'live1',
        threadId: 'lt1',
        internalDate: String(Date.now()),
        snippet: 'from Gmail',
        labelIds: ['INBOX'],
        payload: { headers: [
          { name: 'From', value: 'Live Sender <live@example.com>' },
          { name: 'Subject', value: 'Live subject' }
        ] }
      });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Ada email hari ini?' }] })
    });
    expect(res.status).toBe(200);
    const toolResult = aiRequests[1].messages.at(-1).content;
    expect(toolResult).toContain('"live":true');
    expect(toolResult).toContain('"subject":"Live subject"');
    const stored = await db.prepare("SELECT subject FROM messages WHERE gmail_message_id = 'live1'").first();
    expect(stored.subject).toBe('Live subject');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('AI chat returns an error when the provider keeps refusing to use tools', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      calls += 1;
      return Response.json({ choices: [{ message: { content: '{"answer":"No. search_mail tidak ada di daftar tool sesi ini."}' } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Ada email BNSP?' }] })
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('refused to use its mail tools');
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI chat carries earlier source ids into follow-up requests', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model')
  `).run();
  const originalFetch = globalThis.fetch;
  const aiRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'ai.test') {
      aiRequests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: '{"answer":"Isi email: Hi there."}' } }] });
    }
    if (url.pathname.endsWith('/messages/m1')) {
      return Response.json({ payload: { mimeType: 'text/plain', body: { data: b64('Hi there') } } });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'daftar email BNSP' },
          {
            role: 'assistant',
            content: 'Ada 1 email.',
            sources: [{ accountId: 1, threadId: 't1', subject: 'Hello', from: 'Bob' }]
          },
          { role: 'user', content: 'Apa isi email nomor 1?' }
        ]
      })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).answer).toContain('Hi there');
    const messages = aiRequests[0].messages;
    expect(aiRequests).toHaveLength(1);
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].content).toContain('1. accountId=1 threadId=t1 subject="Hello"');
    expect(messages.at(-1).content).toContain('TOOL RESULT read_thread');
    expect(messages.at(-1).content).toContain('Hi there');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('AI chat tells the model today\'s date in the configured timezone', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES
      ('ai_base_url', 'https://ai.test/v1'),
      ('ai_api_key', 'test-key'),
      ('ai_model', 'test-model'),
      ('timezone', 'Asia/Jakarta')
  `).run();
  const originalFetch = globalThis.fetch;
  let system = '';
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).hostname === 'ai.test') {
      system = JSON.parse(options.body).messages[0].content;
      return Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  try {
    const res = await app.request('/api/mail/ai/chat', {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Ada email hari ini?' }] })
    });
    expect(res.status).toBe(200);
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    expect(system).toContain(`Today is`);
    expect(system).toContain(`${expected} (Asia/Jakarta)`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('AI chat sessions append encrypted messages, dedupe, isolate users, and tombstone deletes', async () => {
  const { db, app } = await setup({ TOKEN_ENCRYPTION_KEY: 'chat-test-key' });
  const append = (id, body) => app.request(`/api/mail/ai/chat/sessions/${id}/messages`, {
    method: 'POST',
    headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  });

  const saved = await append('session-test-1', {
    title: 'Hello',
    messages: [
      { clientId: 'user-msg-0001', role: 'user', content: 'Ada email?', createdAt: 1000 },
      { clientId: 'sys-msg-0001', role: 'system', content: 'ignored', createdAt: 1001 },
      { clientId: 'assistant-msg-0001', role: 'assistant', content: 'Ada 1 email.', sources: [{ accountId: 1, threadId: 't1', subject: 'Hello', from: 'Bob' }], createdAt: 1002 }
    ]
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).appended).toBe(2);

  const stored = await db.prepare('SELECT payload FROM ai_chat_messages ORDER BY seq').all();
  expect(stored.results).toHaveLength(2);
  expect(stored.results[0].payload.startsWith('enc:v1:')).toBe(true);
  expect(stored.results[0].payload).not.toContain('Ada email?');

  const listed = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers() })).json();
  expect(listed.sessions).toHaveLength(1);
  expect(listed.sessions[0].title).toBe('Hello');
  expect(listed.sessions[0].messages).toHaveLength(2);
  expect(listed.sessions[0].messages[1].content).toBe('Ada 1 email.');
  expect(listed.sessions[0].messages[1].sources[0].subject).toBe('Hello');
  expect(listed.sessions[0].messages[0].clientId).toBe('user-msg-0001');

  const duplicate = await append('session-test-1', {
    messages: [{ clientId: 'user-msg-0001', role: 'user', content: 'Ada email?', createdAt: 1000 }]
  });
  expect((await duplicate.json()).appended).toBe(0);
  const stillTwo = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers() })).json();
  expect(stillTwo.sessions[0].messages).toHaveLength(2);

  const invalid = await append('session-test-1', {
    messages: [{ clientId: 'sys-msg-0002', role: 'system', content: 'ignored' }]
  });
  expect(invalid.status).toBe(400);

  await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('other', 'x', 'master')`).run();
  await db.prepare(`INSERT INTO sessions (token, user_id, csrf_token, expires_at) VALUES ('tok2', 2, 'csrf', ?)`)
    .bind(new Date(Date.now() + 3600000).toISOString()).run();
  const other = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers({ cookie: 'umail_session=tok2' }) })).json();
  expect(other.sessions).toHaveLength(0);

  const removed = await app.request('/api/mail/ai/chat/sessions/session-test-1', {
    method: 'DELETE',
    headers: headers({ 'x-csrf-token': 'csrf' })
  });
  expect(removed.status).toBe(200);
  const empty = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers() })).json();
  expect(empty.sessions).toHaveLength(0);

  const resurrect = await append('session-test-1', {
    messages: [{ clientId: 'user-msg-0002', role: 'user', content: 'Halo lagi' }]
  });
  expect(resurrect.status).toBe(410);
});

test('AI chat sessions keep only the latest 15 per user', async () => {
  const { app } = await setup();
  for (let index = 0; index < 16; index += 1) {
    const res = await app.request(`/api/mail/ai/chat/sessions/session-${String(index).padStart(4, '0')}/messages`, {
      method: 'POST',
      headers: headers({ 'x-csrf-token': 'csrf', 'content-type': 'application/json' }),
      body: JSON.stringify({
        title: `Chat ${index}`,
        messages: [{ clientId: `msg-${String(index).padStart(4, '0')}`, role: 'user', content: `Question ${index}`, createdAt: Date.now() + index }]
      })
    });
    expect(res.status).toBe(200);
    await Bun.sleep(2);
  }
  const listed = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers() })).json();
  expect(listed.sessions).toHaveLength(15);
  expect(listed.sessions[0].title).toBe('Chat 15');
  expect(listed.sessions.some((session) => session.title === 'Chat 0')).toBe(false);
});

test('legacy messages_json chat sessions are migrated to messages', async () => {
  const { db, app } = await setup();
  await db.prepare(`
    INSERT INTO ai_chat_sessions (id, user_id, title, messages_json, updated_at)
    VALUES ('legacy-session-1', 1, 'Legacy', ?, ?)
  `).bind(JSON.stringify([
    { role: 'user', content: 'Pertanyaan lama' },
    { role: 'assistant', content: 'Jawaban lama', sources: [] }
  ]), Date.now()).run();
  await initDB(db);
  const listed = await (await app.request('/api/mail/ai/chat/sessions', { headers: headers() })).json();
  expect(listed.sessions).toHaveLength(1);
  expect(listed.sessions[0].messages.map((message) => message.content)).toEqual(['Pertanyaan lama', 'Jawaban lama']);
});

test('old chat schema gains the tombstone column and migrates legacy messages', async () => {
  const db = wrapDatabase(new Database(':memory:'));
  await db.exec(`CREATE TABLE ai_chat_sessions (
    id TEXT NOT NULL, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
    messages_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, user_id)
  )`);
  await db.exec(`INSERT INTO ai_chat_sessions (id, user_id, title, messages_json, updated_at)
    VALUES ('legacy-session-2', 1, 'Old', '[{"role":"user","content":"Halo lama"}]', 123)`);
  await initDB(db);
  const columns = (await db.prepare('PRAGMA table_info(ai_chat_sessions)').all()).results;
  expect(columns.some((column) => column.name === 'deleted')).toBe(true);
  const stored = await db.prepare('SELECT session_id, client_id FROM ai_chat_messages').all();
  expect(stored.results).toEqual([{ session_id: 'legacy-session-2', client_id: 'legacy-0' }]);
});
