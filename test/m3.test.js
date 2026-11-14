import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { parseAddressList, normalizeMessage } from '../src/services/gmail-parse.js';
import { storeMessages, deleteMessages, storeLabels } from '../src/services/mail-store.js';
import { collectHistoryChanges } from '../src/services/gmail-sync.js';

function memoryDB() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_message_id TEXT NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      internal_date INTEGER,
      from_name TEXT,
      from_email TEXT,
      to_json TEXT DEFAULT '[]',
      cc_json TEXT DEFAULT '[]',
      bcc_json TEXT DEFAULT '[]',
      reply_to TEXT,
      subject TEXT,
      snippet TEXT,
      label_ids TEXT DEFAULT '[]',
      size_estimate INTEGER DEFAULT 0,
      is_unread INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      is_important INTEGER DEFAULT 0,
      has_attachment INTEGER DEFAULT 0,
      raw_headers_json TEXT,
      UNIQUE(account_id, gmail_message_id)
    );
    CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      last_message_at INTEGER,
      message_count INTEGER DEFAULT 0,
      label_ids TEXT DEFAULT '[]',
      is_unread INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      is_important INTEGER DEFAULT 0,
      UNIQUE(account_id, gmail_thread_id)
    );
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_label_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'user',
      color TEXT,
      messages_total INTEGER DEFAULT 0,
      messages_unread INTEGER DEFAULT 0,
      threads_total INTEGER DEFAULT 0,
      threads_unread INTEGER DEFAULT 0,
      UNIQUE(account_id, gmail_label_id)
    );
  `);
  return wrapDatabase(sqlite);
}

function gmailMessage(id, overrides = {}) {
  return normalizeMessage(1, {
    id,
    threadId: 't1',
    internalDate: '1000',
    snippet: `snippet ${id}`,
    sizeEstimate: 10,
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Ada Lovelace <Ada@Example.com>' },
        { name: 'To', value: 'bob@example.com, "B, C" <c@d.co>' },
        { name: 'Subject', value: 'Hello' }
      ]
    },
    ...overrides
  });
}

test('address lists and message metadata normalize', () => {
  expect(parseAddressList('a@b.co, "B, C" <c@d.co>')).toEqual([
    { name: '', email: 'a@b.co' },
    { name: 'B, C', email: 'c@d.co' }
  ]);

  const message = normalizeMessage(1, {
    id: 'm1',
    threadId: 't1',
    internalDate: '1700000000000',
    snippet: 'hi',
    sizeEstimate: 42,
    labelIds: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'],
    payload: {
      headers: [
        { name: 'From', value: 'Ada Lovelace <Ada@Example.com>' },
        { name: 'To', value: 'bob@example.com' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Message-ID', value: '<x@y>' }
      ],
      parts: [{ filename: 'file.pdf' }]
    }
  });

  expect(message.from_name).toBe('Ada Lovelace');
  expect(message.from_email).toBe('ada@example.com');
  expect(JSON.parse(message.to_json)).toEqual([{ name: '', email: 'bob@example.com' }]);
  expect(message.is_unread).toBe(1);
  expect(message.is_starred).toBe(1);
  expect(message.is_important).toBe(1);
  expect(message.has_attachment).toBe(1);
  expect(JSON.parse(message.raw_headers_json).messageId).toBe('<x@y>');
});

test('messages upsert and thread summaries recompute', async () => {
  const db = memoryDB();
  await storeMessages(db, 1, [gmailMessage('m1')]);
  await storeMessages(db, 1, [gmailMessage('m2', {
    internalDate: '2000',
    snippet: 'second',
    labelIds: ['INBOX', 'STARRED']
  })]);

  expect((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n).toBe(2);
  let thread = await db.prepare('SELECT * FROM threads WHERE gmail_thread_id = ?').bind('t1').first();
  expect(thread.message_count).toBe(2);
  expect(thread.last_message_at).toBe(2000);
  expect(thread.snippet).toBe('second');
  expect(thread.is_unread).toBe(1);
  expect(thread.is_starred).toBe(1);

  await deleteMessages(db, 1, ['m2']);
  thread = await db.prepare('SELECT * FROM threads WHERE gmail_thread_id = ?').bind('t1').first();
  expect(thread.message_count).toBe(1);
  expect(thread.last_message_at).toBe(1000);
  expect(thread.is_unread).toBe(1);

  await deleteMessages(db, 1, ['m1']);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM threads').first()).toEqual({ n: 0 });
});

test('labels upsert counts and colors', async () => {
  const db = memoryDB();
  await storeLabels(db, 1, [
    { id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 5, messagesUnread: 2 },
    { id: 'Label_1', name: 'Work', type: 'user', color: { backgroundColor: '#ff0000' } }
  ]);
  await storeLabels(db, 1, [{ id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 6, messagesUnread: 3 }]);

  const inbox = await db.prepare('SELECT * FROM labels WHERE gmail_label_id = ?').bind('INBOX').first();
  expect(inbox.messages_total).toBe(6);
  expect(inbox.messages_unread).toBe(3);
  const work = await db.prepare('SELECT * FROM labels WHERE gmail_label_id = ?').bind('Label_1').first();
  expect(work.color).toBe('#ff0000');
  expect((await db.prepare('SELECT COUNT(*) AS n FROM labels').first()).n).toBe(2);
});

test('history changes collect adds, label changes, and deletes', () => {
  const changes = collectHistoryChanges({
    historyId: '99',
    history: [
      {
        messagesAdded: [{ message: { id: 'a' } }],
        messagesDeleted: [{ message: { id: 'b' } }],
        labelsAdded: [{ message: { id: 'c' } }],
        labelsRemoved: [{ message: { id: 'd' } }]
      },
      { messages: [{ id: 'e' }, { id: 'a' }] }
    ]
  });
  expect([...changes.added].sort()).toEqual(['a', 'c', 'd', 'e']);
  expect([...changes.deleted]).toEqual(['b']);
  expect(changes.historyId).toBe('99');
  expect(collectHistoryChanges({}).added.size).toBe(0);
});