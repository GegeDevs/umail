import { getProfile, listLabels, listMessages, getMessageMetadata, listHistory } from './gmail.js';
import { normalizeMessage } from './gmail-parse.js';
import { storeLabels, storeMessages, deleteMessages } from './mail-store.js';
import { logSystem } from './logger.js';

const MAX_MESSAGES = 1000;
const BATCH_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 90;

async function syncQuery(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sync_window_days'").first();
  const days = Math.max(1, Math.min(3650, Number(row?.value) || DEFAULT_WINDOW_DAYS));
  return `newer_than:${days}d -in:chats`;
}

const inflight = new Map();
const progress = new Map();

export function isSyncing(accountId) {
  return inflight.has(accountId);
}

export function getSyncProgress(accountId) {
  return progress.get(accountId) || null;
}

export function collectHistoryChanges(page = {}) {
  const added = new Set();
  const deleted = new Set();
  const records = Array.isArray(page.history) ? page.history : [];
  for (const record of records) {
    for (const item of record.messagesAdded || []) {
      if (item.message?.id) added.add(item.message.id);
    }
    for (const item of record.messagesDeleted || []) {
      if (item.message?.id) deleted.add(item.message.id);
    }
    for (const item of record.labelsAdded || []) {
      if (item.message?.id) added.add(item.message.id);
    }
    for (const item of record.labelsRemoved || []) {
      if (item.message?.id) added.add(item.message.id);
    }
    for (const item of record.messages || []) {
      if (item.id) added.add(item.id);
    }
  }
  return { added, deleted, historyId: page.historyId || null };
}

async function fetchChunk(db, env, accountId, ids) {
  const results = await Promise.allSettled(ids.map((id) => getMessageMetadata(db, env, accountId, id)));
  const messages = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      messages.push(normalizeMessage(accountId, result.value));
    } else if (result.reason?.status !== 404 && result.reason?.code !== 'gmail_404') {
      throw result.reason;
    }
  }
  return messages;
}

async function storeIds(db, env, accountId, ids, phase) {
  const total = ids.length;
  let done = 0;
  progress.set(accountId, { phase, done, total });
  for (let index = 0; index < total; index += BATCH_SIZE) {
    const chunk = ids.slice(index, index + BATCH_SIZE);
    const messages = await fetchChunk(db, env, accountId, chunk);
    await storeMessages(db, accountId, messages);
    done += chunk.length;
    progress.set(accountId, { phase, done, total });
  }
}

export async function refreshLabels(db, env, accountId) {
  const labels = await listLabels(db, env, accountId);
  if (!Array.isArray(labels.labels)) return;
  await storeLabels(db, accountId, labels.labels);
  const ids = labels.labels.map((label) => label.id);
  if (ids.length) {
    await db.prepare(
      `DELETE FROM labels WHERE account_id = ? AND gmail_label_id NOT IN (${ids.map(() => '?').join(',')})`
    ).bind(accountId, ...ids).run();
  }
}

async function fullSync(db, env, accountId) {
  const profile = await getProfile(db, env, accountId);
  const historyId = profile.historyId || null;

  await refreshLabels(db, env, accountId);

  const ids = [];
  let pageToken = '';
  const query = await syncQuery(db);
  while (ids.length < MAX_MESSAGES) {
    const page = await listMessages(db, env, accountId, {
      q: query,
      maxResults: 500,
      pageToken
    });
    for (const message of page.messages || []) ids.push(message.id);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  const uniqueIds = [...new Set(ids)].slice(0, MAX_MESSAGES);

  await storeIds(db, env, accountId, uniqueIds, 'messages');

  await db.prepare(`
    INSERT INTO sync_state (account_id, history_id, last_full_sync_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      history_id = excluded.history_id,
      last_full_sync_at = datetime('now'),
      last_error = NULL
  `).bind(accountId, historyId).run();
  await db.prepare(`
    UPDATE google_accounts
    SET history_id = ?, status = 'healthy', last_error = NULL,
        last_synced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(historyId, accountId).run();
}

async function incrementalSync(db, env, accountId, startHistoryId) {
  const added = new Set();
  const deleted = new Set();
  let historyId = startHistoryId;
  let pageToken = '';

  for (;;) {
    let page;
    try {
      page = await listHistory(db, env, accountId, startHistoryId, { pageToken });
    } catch (error) {
      if (error.status === 404 || error.code === 'gmail_404') {
        await logSystem(db, 'warn', 'Gmail history expired, running full sync', `account ${accountId}`);
        return fullSync(db, env, accountId);
      }
      throw error;
    }
    const changes = collectHistoryChanges(page);
    for (const id of changes.added) added.add(id);
    for (const id of changes.deleted) deleted.add(id);
    if (changes.historyId) historyId = changes.historyId;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  for (const id of deleted) added.delete(id);
  if (deleted.size) await deleteMessages(db, accountId, [...deleted]);
  await storeIds(db, env, accountId, [...added], 'incremental');
  await refreshLabels(db, env, accountId);

  await db.prepare(`
    UPDATE sync_state
    SET history_id = ?, last_incremental_sync_at = datetime('now'), last_error = NULL
    WHERE account_id = ?
  `).bind(historyId, accountId).run();
  await db.prepare(`
    UPDATE google_accounts
    SET history_id = ?, status = 'healthy', last_error = NULL,
        last_synced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(historyId, accountId).run();
}

async function syncAccount(db, env, accountId, force = false) {
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account || (!account.sync_enabled && !force) || account.status === 'reauth_required') {
    return { ok: false, skipped: true };
  }
  const state = await db.prepare('SELECT * FROM sync_state WHERE account_id = ?').bind(accountId).first();
  const startHistoryId = state?.last_full_sync_at ? state.history_id : null;

  try {
    if (startHistoryId) await incrementalSync(db, env, accountId, startHistoryId);
    else await fullSync(db, env, accountId);
    return { ok: true };
  } catch (error) {
    const message = String(error.message || 'Gmail sync failed').slice(0, 500);
    const reauth = Boolean(error.reauth) || error.status === 401
      || error.code === 'invalid_grant' || error.code === 'missing_refresh_token';
    const status = reauth ? 'reauth_required' : 'error';
    await db.prepare(`
      UPDATE google_accounts
      SET status = ?, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(status, message, accountId).run();
    await db.prepare(`
      INSERT INTO sync_state (account_id, last_error) VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET last_error = excluded.last_error
    `).bind(accountId, message).run();
    await logSystem(db, 'error', `Gmail sync failed: ${account.email}`, message);
    return { ok: false, error: message };
  }
}

export function triggerSync(db, env, accountId, { force = false } = {}) {
  const id = Number(accountId);
  if (inflight.has(id)) return inflight.get(id);

  const promise = syncAccount(db, env, id, force).finally(() => {
    inflight.delete(id);
    progress.delete(id);
  });

  inflight.set(id, promise);
  progress.set(id, { phase: 'starting', done: 0, total: 0 });
  return promise;
}