import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { initDB } from '../src/db/index.js';
import { triggerSync } from '../src/services/gmail-sync.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

function gmail(id, overrides = {}) {
  return {
    id,
    threadId: 't1',
    internalDate: '1000',
    snippet: `snippet ${id}`,
    sizeEstimate: 10,
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'Subject', value: `Subject ${id}` }
      ]
    },
    ...overrides
  };
}

test('full sync then incremental add, delete, and expired history', async () => {
  const sqlite = new Database(':memory:');
  const db = wrapDatabase(sqlite);
  await initDB(db);
  await db.prepare(`
    INSERT INTO google_accounts
      (email, display_name, access_token, refresh_token, token_expiry, status, sync_enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).bind('ada@example.com', 'Ada', 'access-token', 'refresh-token', Date.now() + 3600000).run();

  const messages = { m1: gmail('m1'), m2: gmail('m2', { internalDate: '2000' }) };
  let history = { historyId: '100' };
  let historyStatus = 200;
  let profileHistoryId = '100';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/profile')) {
      return json({ emailAddress: 'ada@example.com', historyId: profileHistoryId, messagesTotal: 2 });
    }
    if (path.endsWith('/labels')) {
      return json({
        labels: [{ id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 2, messagesUnread: 1 }]
      });
    }
    if (path.endsWith('/messages')) {
      return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    }
    const messageMatch = path.match(/\/messages\/([^/]+)$/);
    if (messageMatch) return json(messages[messageMatch[1]]);
    if (path.endsWith('/history')) {
      if (historyStatus === 404) return json({ error: { message: 'history expired' } }, 404);
      return json(history);
    }
    throw new Error(`Unexpected Gmail URL: ${url}`);
  };

  try {
    const full = await triggerSync(db, {}, 1, { force: true });
    expect(full.ok).toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n).toBe(2);
    let thread = await db.prepare('SELECT * FROM threads').first();
    expect(thread.message_count).toBe(2);
    expect(thread.last_message_at).toBe(2000);
    let state = await db.prepare('SELECT * FROM sync_state WHERE account_id = 1').first();
    expect(state.history_id).toBe('100');
    expect(state.last_full_sync_at).not.toBe(null);

    messages.m3 = gmail('m3', { internalDate: '3000' });
    history = { historyId: '105', history: [{ messagesAdded: [{ message: { id: 'm3' } }] }] };
    const incremental = await triggerSync(db, {}, 1);
    expect(incremental.ok).toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n).toBe(3);
    state = await db.prepare('SELECT * FROM sync_state WHERE account_id = 1').first();
    expect(state.history_id).toBe('105');
    expect(state.last_incremental_sync_at).not.toBe(null);

    history = { historyId: '106', history: [{ messagesDeleted: [{ message: { id: 'm2' } }] }] };
    await triggerSync(db, {}, 1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n).toBe(2);
    thread = await db.prepare('SELECT * FROM threads').first();
    expect(thread.message_count).toBe(2);
    expect(thread.last_message_at).toBe(3000);

    historyStatus = 404;
    profileHistoryId = '200';
    const recovered = await triggerSync(db, {}, 1);
    expect(recovered.ok).toBe(true);
    state = await db.prepare('SELECT * FROM sync_state WHERE account_id = 1').first();
    expect(state.history_id).toBe('200');
    expect(state.last_full_sync_at).not.toBe(null);
    const account = await db.prepare('SELECT * FROM google_accounts WHERE id = 1').first();
    expect(account.status).toBe('healthy');
    expect(account.last_synced_at).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});