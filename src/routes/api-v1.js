import { Hono } from 'hono';
import { authenticateApiKey, checkRateLimit } from '../services/api-keys.js';
import { applyAction } from '../services/mail-actions.js';
import { sendMail } from '../services/mail-send.js';

const apiV1 = new Hono();

const BOXES = new Set(['inbox', 'starred', 'sent', 'drafts', 'archive', 'spam', 'trash', 'important']);

function boxFilter(box) {
  const has = (label) => `m.label_ids LIKE '%"${label}"%'`;
  const hasNot = (label) => `m.label_ids NOT LIKE '%"${label}"%'`;
  switch (box) {
    case 'starred': return has('STARRED');
    case 'sent': return has('SENT');
    case 'spam': return has('SPAM');
    case 'trash': return has('TRASH');
    case 'important': return has('IMPORTANT');
    case 'archive':
      return `${hasNot('INBOX')} AND ${hasNot('SENT')} AND ${hasNot('DRAFT')} AND ${hasNot('TRASH')} AND ${hasNot('SPAM')} AND ${hasNot('CHAT')}`;
    case 'inbox':
    default:
      return `${has('INBOX')} AND ${hasNot('TRASH')} AND ${hasNot('SPAM')}`;
  }
}

function requireApi(c, permission) {
  if (!c.get('apiKey')?.permissions.includes(permission)) {
    return c.json({ error: `Missing permission: ${permission}` }, 403);
  }
  return null;
}

apiV1.use('*', async (c, next) => {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return c.json({ error: 'Missing API key' }, 401);

  const db = c.get('db');
  const key = await authenticateApiKey(db, token);
  if (!key) return c.json({ error: 'Invalid or expired API key' }, 401);

  const limit = await checkRateLimit(db, key.hash, key.rate_limit);
  c.header('X-RateLimit-Limit', String(limit.limit));
  c.header('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  await db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(key.id).run();
  c.set('apiKey', key);
  await next();
});

apiV1.get('/accounts', async (c) => {
  const err = requireApi(c, 'api:accounts:read');
  if (err) return err;
  const { results } = await c.get('db').prepare(`
    SELECT a.id, a.email, a.display_name, a.card_color, a.status,
           COALESCE((SELECT COUNT(*) FROM messages m
                     WHERE m.account_id = a.id AND m.is_unread = 1
                       AND m.label_ids LIKE '%"INBOX"%'
                       AND m.label_ids NOT LIKE '%"TRASH"%'
                       AND m.label_ids NOT LIKE '%"SPAM"%'), 0) AS unread
    FROM google_accounts a ORDER BY a.is_default DESC, a.id
  `).all();
  return c.json({ results });
});

apiV1.get('/messages', async (c) => {
  const err = requireApi(c, 'api:mail:read');
  if (err) return err;

  const db = c.get('db');
  const box = BOXES.has(c.req.query('box')) ? c.req.query('box') : 'inbox';
  const accountId = Number(c.req.query('accountId')) || 0;
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 30));
  const clauses = [boxFilter(box)];
  const args = [];
  if (accountId) { clauses.push('m.account_id = ?'); args.push(accountId); }

  const cursor = String(c.req.query('cursor') || '');
  const [date, rowId] = cursor.split('_');
  if (Number.isFinite(Number(date)) && Number.isFinite(Number(rowId)) && cursor) {
    clauses.push('(m.internal_date < ? OR (m.internal_date = ? AND m.id < ?))');
    args.push(Number(date), Number(date), Number(rowId));
  }

  const { results } = await db.prepare(`
    SELECT m.id, m.account_id, m.gmail_message_id, m.gmail_thread_id, m.internal_date,
           m.from_name, m.from_email, m.to_json, m.subject, m.snippet, m.label_ids,
           m.is_unread, m.is_starred, m.is_important, m.has_attachment,
           a.display_name AS account_name, a.card_color
    FROM messages m JOIN google_accounts a ON a.id = m.account_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY m.internal_date DESC, m.id DESC LIMIT ?
  `).bind(...args, limit + 1).all();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    box,
    results: page,
    nextCursor: results.length > limit && last ? `${last.internal_date}_${last.id}` : null
  });
});

apiV1.get('/threads/:accountId/:threadId', async (c) => {
  const err = requireApi(c, 'api:mail:read');
  if (err) return err;
  const db = c.get('db');
  const accountId = Number(c.req.param('accountId'));
  const threadId = c.req.param('threadId');
  const { results } = await db.prepare(`
    SELECT id, account_id, gmail_message_id, gmail_thread_id, internal_date,
           from_name, from_email, to_json, cc_json, subject, snippet, label_ids,
           is_unread, is_starred, is_important, has_attachment
    FROM messages WHERE account_id = ? AND gmail_thread_id = ?
    ORDER BY internal_date ASC, id ASC
  `).bind(accountId, threadId).all();
  if (!results.length) return c.json({ error: 'Thread not found' }, 404);
  return c.json({ thread: { account_id: accountId, gmail_thread_id: threadId, messages: results } });
});

apiV1.get('/labels', async (c) => {
  const err = requireApi(c, 'api:mail:read');
  if (err) return err;
  const { results: rows } = await c.get('db').prepare(`
    SELECT l.account_id, l.gmail_label_id, l.name,
           (SELECT COUNT(*) FROM messages m
            WHERE m.account_id = l.account_id AND m.is_unread = 1
              AND m.label_ids LIKE '%"' || l.gmail_label_id || '"%') AS messages_unread,
           (SELECT COUNT(*) FROM messages m
            WHERE m.account_id = l.account_id
              AND m.label_ids LIKE '%"' || l.gmail_label_id || '"%') AS messages_total
    FROM labels l WHERE l.type = 'user' ORDER BY l.name COLLATE NOCASE, l.account_id
  `).all();
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.name)) grouped.set(row.name, { name: row.name, total: 0, unread: 0, accounts: [] });
    const item = grouped.get(row.name);
    item.total += Number(row.messages_total) || 0;
    item.unread += Number(row.messages_unread) || 0;
    item.accounts.push({ account_id: row.account_id, gmail_label_id: row.gmail_label_id });
  }
  return c.json({ results: [...grouped.values()] });
});

apiV1.get('/search', async (c) => {
  const err = requireApi(c, 'api:mail:read');
  if (err) return err;
  const q = String(c.req.query('q') || '').trim();
  if (!q) return c.json({ query: '', results: [], total: 0 });
  const db = c.get('db');
  const accountId = Number(c.req.query('accountId')) || 0;
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 30));
  const like = `%${q}%`;
  const { results } = await db.prepare(`
    SELECT m.id, m.account_id, m.gmail_message_id, m.gmail_thread_id, m.internal_date,
           m.from_name, m.from_email, m.subject, m.snippet, m.label_ids,
           m.is_unread, m.is_starred, m.is_important, m.has_attachment,
           a.display_name AS account_name, a.card_color
    FROM messages m JOIN google_accounts a ON a.id = m.account_id
    WHERE ${accountId ? 'm.account_id = ? AND ' : ''}
      (m.subject LIKE ? OR m.snippet LIKE ? OR m.from_email LIKE ? OR m.from_name LIKE ?)
    ORDER BY m.internal_date DESC LIMIT ?
  `).bind(...(accountId ? [accountId] : []), like, like, like, like, limit).all();
  return c.json({ query: q, results, total: results.length, cached: true });
});

apiV1.post('/messages/actions', async (c) => {
  const err = requireApi(c, 'api:mail:modify');
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
  if (!accountId || !messageIds.length) {
    return c.json({ error: 'accountId and messageIds are required' }, 400);
  }
  try {
    const result = await applyAction(
      c.get('db'), c.get('env') || {}, accountId, messageIds,
      String(body.action || ''), String(body.labelId || '')
    );
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message || 'Action failed' }, error.status || 502);
  }
});

apiV1.post('/messages/send', async (c) => {
  const err = requireApi(c, 'api:mail:send');
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!accountId) return c.json({ error: 'accountId is required' }, 400);
  try {
    return c.json(await sendMail(c.get('db'), c.get('env') || {}, accountId, body));
  } catch (error) {
    return c.json({ error: error.message || 'Send failed' }, error.status || 502);
  }
});

export default apiV1;
