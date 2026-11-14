import { batchModify } from './gmail.js';
import { recomputeThreads } from './mail-store.js';

export const ACTIONS = {
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
  archive: { remove: ['INBOX'] },
  inbox: { add: ['INBOX'] },
  trash: { add: ['TRASH'], remove: ['INBOX'] },
  untrash: { remove: ['TRASH'], add: ['INBOX'] },
  spam: { add: ['SPAM'], remove: ['INBOX'] },
  not_spam: { remove: ['SPAM'], add: ['INBOX'] },
  clear_spam: { add: ['TRASH'], remove: ['SPAM', 'INBOX'] }
};

const CHUNK = 500;

export function applyLabelDelta(labelIds, { add = [], remove = [] }) {
  const set = new Set(labelIds);
  for (const id of add) set.add(id);
  for (const id of remove) set.delete(id);
  return [...set];
}

export async function applyAction(db, env, accountId, messageIds, action, labelId = '') {
  let delta = ACTIONS[action];
  if (action === 'apply_label' || action === 'remove_label') {
    if (!labelId) {
      const error = new Error('labelId is required');
      error.status = 400;
      throw error;
    }
    delta = action === 'apply_label' ? { add: [labelId] } : { remove: [labelId] };
  }
  if (!delta) {
    const error = new Error('Unsupported action');
    error.status = 400;
    throw error;
  }
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length) return { updated: 0 };

  for (let index = 0; index < ids.length; index += CHUNK) {
    await batchModify(db, env, accountId, ids.slice(index, index + CHUNK), delta.add || [], delta.remove || []);
  }

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`
    SELECT id, gmail_message_id, gmail_thread_id, label_ids
    FROM messages WHERE account_id = ? AND gmail_message_id IN (${placeholders})
  `).bind(accountId, ...ids).all();

  const statements = [];
  const threadIds = new Set();
  for (const row of results) {
    const labelIds = applyLabelDelta(JSON.parse(row.label_ids || '[]'), delta);
    threadIds.add(row.gmail_thread_id);
    statements.push({
      sql: `
        UPDATE messages
        SET label_ids = ?, is_unread = ?, is_starred = ?, is_important = ?
        WHERE id = ?
      `,
      args: [
        JSON.stringify(labelIds),
        labelIds.includes('UNREAD') ? 1 : 0,
        labelIds.includes('STARRED') ? 1 : 0,
        labelIds.includes('IMPORTANT') ? 1 : 0,
        row.id
      ]
    });
  }
  if (statements.length) await db.batch(statements);
  await recomputeThreads(db, accountId, [...threadIds]);
  return { updated: results.length };
}