import { batchModify } from './gmail.js';
import { applyLabelDelta } from './mail-actions.js';
import { recomputeThreads } from './mail-store.js';
import { logSystem } from './logger.js';

const CHUNK = 500;

async function setSnooze(db, accountId, rows, until) {
  const statements = [];
  const threadIds = new Set();
  for (const row of rows) {
    const labelIds = applyLabelDelta(JSON.parse(row.label_ids || '[]'), { remove: ['INBOX'] });
    threadIds.add(row.gmail_thread_id);
    statements.push({
      sql: 'UPDATE messages SET label_ids = ?, is_unread = ?, snoozed_until = ? WHERE id = ?',
      args: [JSON.stringify(labelIds), labelIds.includes('UNREAD') ? 1 : 0, until, row.id]
    });
  }
  if (statements.length) await db.batch(statements);
  await recomputeThreads(db, accountId, [...threadIds]);
}

export async function snoozeMessages(db, env, accountId, messageIds, until) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length) return { updated: 0 };
  const now = Date.now();
  if (!Number.isFinite(until) || until < now + 60000 || until > now + 366 * 86400000) {
    const error = new Error('Invalid snooze time');
    error.status = 400;
    throw error;
  }
  const placeholders = ids.map(() => '?').join(',');
  const { results: rows } = await db.prepare(`
    SELECT id, gmail_message_id, gmail_thread_id, label_ids FROM messages
    WHERE account_id = ? AND gmail_message_id IN (${placeholders})
  `).bind(accountId, ...ids).all();
  if (!rows.length) return { updated: 0 };
  for (let index = 0; index < rows.length; index += CHUNK) {
    await batchModify(db, env, accountId, rows.slice(index, index + CHUNK).map((row) => row.gmail_message_id), [], ['INBOX']);
  }
  await setSnooze(db, accountId, rows, until);
  return { updated: rows.length, until };
}

export async function processSnoozed(db, env) {
  const { results: rows } = await db.prepare(`
    SELECT id, account_id, gmail_message_id, gmail_thread_id, label_ids
    FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
    ORDER BY snoozed_until LIMIT 100
  `).bind(Date.now()).all();
  let restored = 0;
  const byAccount = new Map();
  for (const row of rows) {
    if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, []);
    byAccount.get(row.account_id).push(row);
  }
  for (const [accountId, list] of byAccount) {
    try {
      for (let index = 0; index < list.length; index += CHUNK) {
        await batchModify(db, env, accountId, list.slice(index, index + CHUNK).map((row) => row.gmail_message_id), ['INBOX'], []);
      }
      const statements = [];
      const threadIds = new Set();
      for (const row of list) {
        const labelIds = applyLabelDelta(JSON.parse(row.label_ids || '[]'), { add: ['INBOX'] });
        threadIds.add(row.gmail_thread_id);
        statements.push({
          sql: 'UPDATE messages SET label_ids = ?, snoozed_until = NULL WHERE id = ?',
          args: [JSON.stringify(labelIds), row.id]
        });
      }
      if (statements.length) await db.batch(statements);
      await recomputeThreads(db, accountId, [...threadIds]);
      restored += list.length;
    } catch (error) {
      await logSystem(db, 'error', `Snooze restore failed for account ${accountId}`, String(error.message || error).slice(0, 500));
    }
  }
  return restored;
}

export function startSnoozeWorker(db, env, intervalMs = 60000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await processSnoozed(db, env);
    } catch (error) {
      await logSystem(db, 'error', 'Snooze worker failed', String(error.message || error).slice(0, 500));
    }
  };
  const initial = setTimeout(tick, 5000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
  };
}
