import { Hono } from 'hono';
import { requirePage, requirePermission } from '../middleware/auth.js';
import { triggerSync, refreshLabels } from '../services/gmail-sync.js';
import { getMessageFull, getMessageMetadata, listMessages, createLabel, updateLabel, deleteLabel } from '../services/gmail.js';
import { parseMessageBody, rewriteInlineImages } from '../services/mail-body.js';
import { signedAttachmentUrl } from '../services/signing.js';
import { storeAttachments, storeMessages } from '../services/mail-store.js';
import { normalizeMessage } from '../services/gmail-parse.js';
import { applyAction, permissionForAction } from '../services/mail-actions.js';
import { snoozeMessages } from '../services/snooze.js';
import { sendMail, parseRecipients, MailError, discardLocalDraft } from '../services/mail-send.js';
import { createDraft, updateDraft, deleteDraft } from '../services/gmail.js';
import { buildMime } from '../services/mime.js';
import { enqueueOutbox } from '../services/outbox.js';
import { summarizeThread, composeAssist } from '../services/ai-summary.js';
import { chatWithMail, confirmAiAction } from '../services/ai-chat.js';
import { encryptToken, decryptToken } from '../services/token-crypto.js';

const mail = new Hono();

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

function decodeCursor(value) {
  const [date, id] = String(value || '').split('_');
  const internalDate = Number(date);
  const rowId = Number(id);
  if (!Number.isFinite(internalDate) || !Number.isFinite(rowId)) return null;
  return { internalDate, rowId };
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1) || '*'}***@${domain}`;
}

const CHAT_SESSION_MAX = 15;
const CHAT_MESSAGE_MAX = 60;

function cleanChatSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 6).map((source) => ({
    accountId: Number(source?.accountId) || 0,
    threadId: String(source?.threadId || '').slice(0, 200),
    subject: String(source?.subject || '').slice(0, 200),
    from: String(source?.from || '').slice(0, 200)
  }));
}

function cleanChatMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
  const clientId = String(message.clientId || '');
  if (!/^[a-zA-Z0-9_-]{8,60}$/.test(clientId)) return null;
  const content = message.content.slice(0, 4000);
  if (!content.trim()) return null;
  const createdAt = Number(message.createdAt);
  return {
    clientId,
    role: message.role,
    content,
    sources: message.role === 'assistant' ? cleanChatSources(message.sources) : [],
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.min(createdAt, Date.now() + 86400000) : Date.now()
  };
}

async function accountList(db, revealEmail) {
  const { results } = await db.prepare(`
    SELECT a.id, a.email, a.display_name, a.card_color, a.status, a.signature,
           COALESCE((SELECT COUNT(*) FROM messages m
                     WHERE m.account_id = a.id AND m.is_unread = 1
                       AND m.label_ids LIKE '%"INBOX"%'
                       AND m.label_ids NOT LIKE '%"TRASH"%'
                       AND m.label_ids NOT LIKE '%"SPAM"%'), 0) AS unread
    FROM google_accounts a ORDER BY a.is_default DESC, a.id
  `).all();
  return results.map((account) => ({
    ...account,
    email: revealEmail ? account.email : maskEmail(account.email)
  }));
}

mail.get('/accounts', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:view', user);
  if (err) return err;
  const revealEmail = user.role === 'master' || user.permissions.includes('accounts:view_email');
  return c.json({ results: await accountList(c.get('db'), revealEmail) });
});

mail.get('/', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;

  const db = c.get('db');
  const box = BOXES.has(c.req.query('box')) ? c.req.query('box') : 'inbox';
  const accountId = Number(c.req.query('accountId')) || 0;
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 30));
  const cursor = decodeCursor(c.req.query('cursor'));
  const revealEmail = user.role === 'master' || user.permissions.includes('accounts:view_email');

  const labelName = String(c.req.query('label') || '').trim();
  const baseClauses = [];
  const baseArgs = [];

  if (labelName) {
    const { results: labelRows } = await db.prepare(
      'SELECT account_id, gmail_label_id FROM labels WHERE name = ? COLLATE NOCASE'
    ).bind(labelName).all();
    const rows = accountId ? labelRows.filter((row) => row.account_id === accountId) : labelRows;
    if (!rows.length) {
      baseClauses.push('0');
    } else {
      baseClauses.push(`(${rows.map(() => 'm.label_ids LIKE ?').join(' OR ')})`);
      baseArgs.push(...rows.map((row) => `%"${row.gmail_label_id}"%`));
    }
  } else {
    baseClauses.push(boxFilter(box));
  }
  if (accountId) { baseClauses.push('m.account_id = ?'); baseArgs.push(accountId); }

  const clauses = [...baseClauses];
  const args = [...baseArgs];
  if (cursor) {
    clauses.push('(m.internal_date < ? OR (m.internal_date = ? AND m.id < ?))');
    args.push(cursor.internalDate, cursor.internalDate, cursor.rowId);
  }
  const where = clauses.join(' AND ');

  const { results } = await db.prepare(`
    SELECT m.id, m.account_id, m.gmail_message_id, m.gmail_thread_id, m.internal_date,
           m.from_name, m.from_email, m.subject, m.snippet, m.label_ids,
           m.is_unread, m.is_starred, m.is_important, m.has_attachment,
           a.email AS account_email, a.display_name AS account_name, a.card_color
    FROM messages m JOIN google_accounts a ON a.id = m.account_id
    WHERE ${where}
    ORDER BY m.internal_date DESC, m.id DESC
    LIMIT ?
  `).bind(...args, limit + 1).all();

  const page = results.slice(0, limit);
  if (!revealEmail) page.forEach((row) => { row.account_email = maskEmail(row.account_email); });
  const last = page[page.length - 1];
  const total = (await db.prepare(`
    SELECT COUNT(*) AS n FROM messages m WHERE ${baseClauses.join(' AND ')}
  `).bind(...baseArgs).first())?.n || 0;

  return c.json({
    box,
    label: labelName || null,
    results: page,
    total,
    accounts: await accountList(db, revealEmail),
    nextCursor: results.length > limit && last ? `${last.internal_date}_${last.id}` : null
  });
});

mail.get('/drafts', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:view', user);
  if (err) return err;
  const db = c.get('db');
  const { results } = await db.prepare(`
    SELECT d.*, a.email AS account_email, a.display_name AS account_name, a.card_color
    FROM drafts d JOIN google_accounts a ON a.id = d.account_id
    ORDER BY d.updated_at DESC, d.id DESC LIMIT 100
  `).all();
  return c.json({ results });
});

mail.get('/threads/:accountId/:threadId', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;

  const db = c.get('db');
  const env = c.get('env') || {};
  const accountId = Number(c.req.param('accountId'));
  const threadId = c.req.param('threadId');
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const { results } = await db.prepare(`
    SELECT * FROM messages
    WHERE account_id = ? AND gmail_thread_id = ?
    ORDER BY internal_date ASC, id ASC
  `).bind(accountId, threadId).all();
  if (!results.length) return c.json({ error: 'Thread not found' }, 404);

  const messages = await Promise.all(results.map(async (row) => {
    let body = { html: '', text: row.snippet || '', attachments: [] };
    let urls = new Map();
    try {
      const full = await getMessageFull(db, env, accountId, row.gmail_message_id);
      const parsed = parseMessageBody(full);
      for (const attachment of parsed.attachments) {
        urls.set(attachment.attachment_id, await signedAttachmentUrl(db, accountId, row.gmail_message_id, attachment));
      }
      body = {
        html: rewriteInlineImages(parsed.html, parsed.attachments, accountId, row.gmail_message_id,
          (attachment) => urls.get(attachment.attachment_id)),
        text: parsed.text,
        attachments: parsed.attachments
      };
      if (parsed.attachments.length) await storeAttachments(db, accountId, row.id, parsed.attachments);
    } catch {
      body.text = row.snippet || '';
    }
    const headers = JSON.parse(row.raw_headers_json || '{}');
    return {
      id: row.id,
      gmail_message_id: row.gmail_message_id,
      internal_date: row.internal_date,
      from_name: row.from_name,
      from_email: row.from_email,
      to_json: row.to_json,
      cc_json: row.cc_json,
      bcc_json: row.bcc_json,
      reply_to: row.reply_to,
      subject: row.subject,
      snippet: row.snippet,
      label_ids: row.label_ids,
      is_unread: row.is_unread,
      is_starred: row.is_starred,
      is_important: row.is_important,
      headers,
      body_html: body.html,
      body_text: body.text,
      attachments: body.attachments.map((attachment) => ({
        ...attachment,
        url: urls.get(attachment.attachment_id)
      }))
    };
  }));

  const { results: settings } = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('mark_read_on_open', 'block_remote_images', 'default_reply_all')"
  ).all();
  const settingsMap = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  return c.json({
    account: {
      id: account.id,
      email: account.email,
      display_name: account.display_name,
      card_color: account.card_color
    },
    thread: {
      account_id: accountId,
      gmail_thread_id: threadId,
      subject: messages[messages.length - 1].subject,
      messages
    },
    mark_read_on_open: settingsMap.mark_read_on_open !== '0',
    block_remote_images: settingsMap.block_remote_images !== '0',
    default_reply_all: settingsMap.default_reply_all === '1'
  });
});

mail.post('/ai/compose', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:draft', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  try {
    const text = await composeAssist(c.get('db'), c.get('env') || {}, {
      text: body.text,
      mode: String(body.mode || ''),
      language: body.language
    });
    return c.json({ text });
  } catch (error) {
    return c.json({ error: error.message || 'AI assist failed' }, error.status || 502);
  }
});

mail.get('/ai/chat/sessions', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const db = c.get('db');
  const env = c.get('env') || {};
  const { results } = await db.prepare(`
    SELECT id, title, updated_at FROM ai_chat_sessions
    WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT ${CHAT_SESSION_MAX}
  `).bind(user.id).all();
  const sessions = [];
  for (const row of results) {
    const { results: stored } = await db.prepare(`
      SELECT client_id, payload, created_at FROM ai_chat_messages
      WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC, seq ASC
    `).bind(user.id, row.id).all();
    let messages;
    try {
      messages = stored.map((item) => {
        const payload = JSON.parse(decryptToken(item.payload, env));
        return {
          clientId: item.client_id,
          createdAt: item.created_at,
          role: payload.role,
          content: payload.content,
          sources: Array.isArray(payload.sources) ? payload.sources : []
        };
      });
    } catch {
      return c.json({ error: 'Chat history cannot be decrypted. Check TOKEN_ENCRYPTION_KEY.' }, 503);
    }
    messages = messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string');
    if (messages.length) sessions.push({ id: row.id, title: row.title, updatedAt: row.updated_at, messages });
  }
  return c.json({ sessions });
});

mail.post('/ai/chat/sessions/:id/messages', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const id = String(c.req.param('id') || '');
  if (!/^[a-zA-Z0-9_-]{8,40}$/.test(id)) return c.json({ error: 'Invalid session id' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(cleanChatMessage)
    .filter(Boolean)
    .slice(-CHAT_MESSAGE_MAX);
  if (!messages.length) return c.json({ error: 'messages is required' }, 400);

  const db = c.get('db');
  const env = c.get('env') || {};
  const existing = await db.prepare('SELECT deleted FROM ai_chat_sessions WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (existing?.deleted) return c.json({ error: 'Chat was deleted' }, 410);

  await db.prepare(`
    INSERT INTO ai_chat_sessions (id, user_id, title, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO UPDATE SET
      title = CASE WHEN ai_chat_sessions.title = '' THEN excluded.title ELSE ai_chat_sessions.title END,
      updated_at = excluded.updated_at
    WHERE ai_chat_sessions.deleted = 0
  `).bind(id, user.id, String(body.title || '').slice(0, 80), Date.now()).run();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ai_chat_messages (user_id, session_id, client_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  let appended = 0;
  for (const message of messages) {
    const payload = encryptToken(JSON.stringify({
      role: message.role,
      content: message.content,
      sources: message.sources
    }), env);
    const result = await insert.bind(user.id, id, message.clientId, payload, message.createdAt).run();
    if (result.meta.changes) appended += 1;
  }

  await db.prepare(`
    DELETE FROM ai_chat_messages WHERE seq IN (
      SELECT seq FROM ai_chat_messages WHERE user_id = ? AND session_id = ?
      ORDER BY created_at DESC, seq DESC LIMIT -1 OFFSET ${CHAT_MESSAGE_MAX}
    )
  `).bind(user.id, id).run();

  const { results: stale } = await db.prepare(`
    SELECT id FROM ai_chat_sessions WHERE user_id = ? AND deleted = 0
    ORDER BY updated_at DESC LIMIT -1 OFFSET ${CHAT_SESSION_MAX}
  `).bind(user.id).all();
  for (const session of stale) {
    await db.prepare('DELETE FROM ai_chat_messages WHERE user_id = ? AND session_id = ?').bind(user.id, session.id).run();
    await db.prepare('DELETE FROM ai_chat_sessions WHERE user_id = ? AND id = ?').bind(user.id, session.id).run();
  }

  return c.json({ ok: true, appended });
});

mail.delete('/ai/chat/sessions/:id', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const db = c.get('db');
  const id = String(c.req.param('id') || '');
  await db.prepare(`UPDATE ai_chat_sessions SET deleted = 1, title = '', updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(Date.now(), id, user.id).run();
  await db.prepare('DELETE FROM ai_chat_messages WHERE user_id = ? AND session_id = ?').bind(user.id, id).run();
  return c.json({ ok: true });
});

mail.post('/snooze', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:archive', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
  const until = Number(body.until);
  if (!accountId || !messageIds.length) return c.json({ error: 'accountId and messageIds are required' }, 400);
  try {
    return c.json(await snoozeMessages(c.get('db'), c.get('env') || {}, accountId, messageIds, until));
  } catch (error) {
    return c.json({ error: error.message || 'Snooze failed' }, error.status || 502);
  }
});

mail.get('/templates', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const { results } = await c.get('db').prepare(
    'SELECT id, name, subject, body FROM templates WHERE user_id = ? ORDER BY name COLLATE NOCASE'
  ).bind(user.id).all();
  return c.json({ results });
});

mail.post('/templates', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 80);
  const subject = String(body.subject || '').slice(0, 300);
  const text = String(body.body || '').slice(0, 20000);
  if (!name) return c.json({ error: 'name is required' }, 400);
  const result = await c.get('db').prepare(
    'INSERT INTO templates (user_id, name, subject, body) VALUES (?, ?, ?, ?)'
  ).bind(user.id, name, subject, text).run();
  return c.json({ id: result.meta.last_row_id });
});

mail.put('/templates/:id', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return c.json({ error: 'name is required' }, 400);
  const result = await c.get('db').prepare(`
    UPDATE templates SET name = ?, subject = ?, body = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).bind(name, String(body.subject || '').slice(0, 300), String(body.body || '').slice(0, 20000),
    Number(c.req.param('id')), user.id).run();
  if (!result.meta.changes) return c.json({ error: 'Template not found' }, 404);
  return c.json({ ok: true });
});

mail.delete('/templates/:id', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  await c.get('db').prepare('DELETE FROM templates WHERE id = ? AND user_id = ?')
    .bind(Number(c.req.param('id')), user.id).run();
  return c.json({ ok: true });
});

mail.get('/contacts', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:view', user);
  if (err) return err;
  const q = String(c.req.query('q') || '').trim().toLowerCase();
  const like = `%${q}%`;
  const { results } = await c.get('db').prepare(`
    SELECT address, MAX(name) AS name FROM (
      SELECT from_email AS address, from_name AS name FROM messages WHERE from_email IS NOT NULL
      UNION ALL
      SELECT json_extract(j.value, '$.email') AS address, json_extract(j.value, '$.name') AS name
      FROM messages m, json_each(m.to_json) j
    )
    WHERE address IS NOT NULL AND address != ''
      AND (? = '' OR lower(address) LIKE ? OR lower(name) LIKE ?)
    GROUP BY address ORDER BY address LIMIT 20
  `).bind(q, like, like).all();
  return c.json({ results });
});

mail.post('/ai/chat', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await chatWithMail(c.get('db'), c.get('env') || {}, body.messages, user);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message || 'AI chat failed' }, error.status || 502);
  }
});

mail.post('/ai/chat/confirm', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await confirmAiAction(c.get('db'), c.get('env') || {}, user, body, Boolean(body.remember)));
  } catch (error) {
    return c.json({ error: error.message || 'Action failed' }, error.status || 502);
  }
});

mail.get('/ai/action-rules', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const { results } = await c.get('db').prepare(
    'SELECT action FROM ai_action_rules WHERE user_id = ? AND allowed = 1 ORDER BY action'
  ).bind(user.id).all();
  return c.json({ results: results.map((row) => row.action) });
});

mail.delete('/ai/action-rules/:action', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  await c.get('db').prepare('DELETE FROM ai_action_rules WHERE user_id = ? AND action = ?')
    .bind(user.id, c.req.param('action')).run();
  return c.json({ ok: true });
});

mail.post('/threads/:accountId/:threadId/summary', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const accountId = Number(c.req.param('accountId'));
  const threadId = c.req.param('threadId');
  try {
    const summary = await summarizeThread(c.get('db'), c.get('env') || {}, accountId, threadId);
    return c.json({ summary });
  } catch (error) {
    return c.json({ error: error.message || 'AI summary failed' }, error.status || 502);
  }
});

mail.post('/actions', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || '');
  const permission = permissionForAction(action);
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, permission, user);
  if (err) return err;

  const accountId = Number(body.accountId);
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
  const labelId = String(body.labelId || '');
  if (!accountId || !messageIds.length) return c.json({ error: 'accountId and messageIds are required' }, 400);
  try {
    return c.json(await applyAction(c.get('db'), c.get('env') || {}, accountId, messageIds, action, labelId));
  } catch (error) {
    return c.json({ error: error.message || 'Action failed' }, error.status || 502);
  }
});

mail.post('/spam/clear', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:delete', user);
  if (err) return err;

  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId) || 0;
  const db = c.get('db');
  const env = c.get('env') || {};
  const { results: accounts } = accountId
    ? await db.prepare('SELECT id FROM google_accounts WHERE id = ?').bind(accountId).all()
    : await db.prepare('SELECT id FROM google_accounts').all();
  if (accountId && !accounts.length) return c.json({ error: 'Account not found' }, 404);

  let cleared = 0;
  let failed = 0;
  const errors = [];
  for (const account of accounts) {
    try {
      const ids = [];
      let pageToken = '';
      do {
        const page = await listMessages(db, env, account.id, { q: 'in:spam', maxResults: 500, pageToken });
        for (const message of page.messages || []) if (message.id) ids.push(message.id);
        pageToken = page.nextPageToken || '';
      } while (pageToken);

      // Permanent delete needs the full-mailbox scope; with gmail.modify, clearing spam moves it to Trash.
      for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500);
        await applyAction(db, env, account.id, chunk, 'clear_spam');
        cleared += chunk.length;
      }
    } catch (error) {
      failed += 1;
      errors.push({ accountId: account.id, error: error.message || 'Clear spam failed' });
    }
  }
  return c.json({ cleared, failed, errors });
});

mail.get('/outbox', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const { results } = await c.get('db').prepare(`
    SELECT id, account_id, payload_json, next_attempt_at
    FROM outbox WHERE status = 'queued' ORDER BY next_attempt_at LIMIT 50
  `).all();
  return c.json({
    results: results.map((row) => {
      const payload = JSON.parse(row.payload_json);
      return {
        id: row.id,
        account_id: row.account_id,
        next_attempt_at: row.next_attempt_at,
        to: payload.to || '',
        subject: payload.subject || ''
      };
    })
  });
});

mail.post('/outbox/:id/cancel', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  const row = await db.prepare("SELECT * FROM outbox WHERE id = ? AND status = 'queued'").bind(id).first();
  if (!row) return c.json({ error: 'Scheduled message not found' }, 404);
  await db.prepare("DELETE FROM outbox WHERE id = ? AND status = 'queued'").bind(id).run();
  return c.json({ cancelled: true, payload: JSON.parse(row.payload_json) });
});

mail.post('/send', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:send', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!accountId) return c.json({ error: 'accountId is required' }, 400);
  const db = c.get('db');
  const env = c.get('env') || {};
  const scheduleAt = Number(body.sendAt) || 0;
  const undo = body.undo === true || body.undo === 1;
  if (scheduleAt || undo) {
    const delay = scheduleAt ? Math.ceil((scheduleAt - Date.now()) / 1000) : 10;
    if (scheduleAt && (delay < 5 || delay > 366 * 86400)) {
      return c.json({ error: 'Scheduled time must be between 5 seconds and 1 year from now' }, 400);
    }
    const outboxId = await enqueueOutbox(db, accountId, body, delay);
    await discardLocalDraft(db, env, accountId, body.draftId);
    return c.json({ ok: true, scheduled: true, outboxId, sendAt: Date.now() + delay * 1000 });
  }
  try {
    return c.json(await sendMail(db, env, accountId, body));
  } catch (error) {
    if (error.code === 'gmail_network') {
      const outboxId = await enqueueOutbox(db, accountId, body);
      return c.json({ ok: true, queued: true, outboxId });
    }
    return c.json({ error: error.message || 'Send failed' }, error.status || 502);
  }
});

function draftFields(body) {
  return {
    to: parseRecipients(body.to),
    cc: parseRecipients(body.cc),
    bcc: parseRecipients(body.bcc),
    subject: String(body.subject || ''),
    body: String(body.body || ''),
    bodyHtml: String(body.bodyHtml || ''),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    threadId: body.threadId ? String(body.threadId) : ''
  };
}

async function saveDraft(db, env, accountId, fields, id) {
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) throw new MailError('Account not found', 404);
  const raw = buildMime({
    from: account.email,
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    text: fields.body,
    html: fields.bodyHtml,
    attachments: fields.attachments
  });

  let rowId = Number(id) || 0;
  if (rowId) {
    const existing = await db.prepare('SELECT * FROM drafts WHERE id = ? AND account_id = ?').bind(rowId, accountId).first();
    if (!existing) throw new MailError('Draft not found', 404);
    await db.prepare(`
      UPDATE drafts SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body = ?, body_html = ?,
        attachments_json = ?, thread_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      JSON.stringify(fields.to), JSON.stringify(fields.cc), JSON.stringify(fields.bcc),
      fields.subject, fields.body, fields.bodyHtml,
      JSON.stringify(fields.attachments), fields.threadId || null, rowId
    ).run();
  } else {
    const result = await db.prepare(`
      INSERT INTO drafts (account_id, to_json, cc_json, bcc_json, subject, body, body_html, attachments_json, thread_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).bind(
      accountId, JSON.stringify(fields.to), JSON.stringify(fields.cc), JSON.stringify(fields.bcc),
      fields.subject, fields.body, fields.bodyHtml,
      JSON.stringify(fields.attachments), fields.threadId || null
    ).run();
    rowId = result.meta.last_row_id;
  }

  let gmailSaved = false;
  try {
    const existing = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(rowId).first();
    const threadId = fields.threadId || existing?.thread_id || '';
    const saved = existing?.gmail_draft_id
      ? await updateDraft(db, env, accountId, existing.gmail_draft_id, raw, threadId)
      : await createDraft(db, env, accountId, raw, threadId);
    await db.prepare(`
      UPDATE drafts SET gmail_draft_id = ?, gmail_message_id = ?, updated_at = datetime('now') WHERE id = ?
    `).bind(saved.id || null, saved.message?.id || null, rowId).run();
    gmailSaved = true;
  } catch {}

  const draft = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(rowId).first();
  return { ok: true, gmail: gmailSaved, draft };
}

mail.post('/drafts', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:draft', user);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!accountId) return c.json({ error: 'accountId is required' }, 400);
  try {
    return c.json(await saveDraft(c.get('db'), c.get('env') || {}, accountId, draftFields(body), body.id));
  } catch (error) {
    return c.json({ error: error.message || 'Could not save draft' }, error.status || 502);
  }
});

mail.delete('/drafts/:id', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:draft', user);
  if (err) return err;
  const db = c.get('db');
  const env = c.get('env') || {};
  const id = Number(c.req.param('id'));
  const row = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'Draft not found' }, 404);
  if (row.gmail_draft_id) {
    try { await deleteDraft(db, env, row.account_id, row.gmail_draft_id); } catch {}
  }
  await db.prepare('DELETE FROM drafts WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

mail.post('/backfill', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:read', user);
  if (err) return err;
  const db = c.get('db');
  const env = c.get('env') || {};
  const { results } = await db.prepare(
    "SELECT id FROM google_accounts WHERE status != 'reauth_required'"
  ).all();
  for (const row of results) {
    triggerSync(db, env, row.id, { force: true }).catch(() => {});
  }
  return c.json({ ok: true, queued: results.length });
});

mail.get('/labels', async (c) => {
  const user = c.get('user');
  const err = requirePage(c, 'mail', user);
  if (err) return err;
  const db = c.get('db');
  const { results: rows } = await db.prepare(`
    SELECT l.account_id, l.gmail_label_id, l.name,
           (SELECT COUNT(*) FROM messages m
            WHERE m.account_id = l.account_id AND m.is_unread = 1
              AND m.label_ids LIKE '%"' || l.gmail_label_id || '"%') AS messages_unread,
           (SELECT COUNT(*) FROM messages m
            WHERE m.account_id = l.account_id
              AND m.label_ids LIKE '%"' || l.gmail_label_id || '"%') AS messages_total
    FROM labels l WHERE l.type = 'user'
    ORDER BY l.name COLLATE NOCASE, l.account_id
  `).all();
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.name)) {
      grouped.set(row.name, { name: row.name, unread: 0, total: 0, accounts: [] });
    }
    const item = grouped.get(row.name);
    item.unread += Number(row.messages_unread) || 0;
    item.total += Number(row.messages_total) || 0;
    item.accounts.push({ account_id: row.account_id, gmail_label_id: row.gmail_label_id });
  }
  return c.json({ results: [...grouped.values()] });
});

function labelTargets(body) {
  return (Array.isArray(body.accounts) ? body.accounts : [])
    .map((item) => ({
      accountId: Number(item.account_id),
      labelId: String(item.gmail_label_id || '')
    }))
    .filter((item) => item.accountId && item.labelId);
}

async function refreshAccounts(db, env, accountIds) {
  for (const accountId of new Set(accountIds)) {
    await refreshLabels(db, env, accountId).catch(() => {});
  }
}

mail.post('/labels', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:labels', user);
  if (err) return err;

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 225);
  if (!name) return c.json({ error: 'Label name is required' }, 400);

  const db = c.get('db');
  const env = c.get('env') || {};
  const { results: accounts } = await db.prepare(
    "SELECT id FROM google_accounts WHERE status != 'reauth_required' ORDER BY id"
  ).all();
  if (!accounts.length) return c.json({ error: 'No connected accounts' }, 400);

  const errors = [];
  let created = 0;
  for (const account of accounts) {
    try {
      await createLabel(db, env, account.id, name);
      created += 1;
    } catch (error) {
      errors.push({ accountId: account.id, error: error.message });
    }
  }
  await refreshAccounts(db, env, accounts.map((account) => account.id));
  if (!created) return c.json({ error: errors[0]?.error || 'Could not create label', errors }, 502);
  return c.json({ ok: true, created, errors }, 201);
});

mail.patch('/labels', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:labels', user);
  if (err) return err;

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().slice(0, 225);
  const targets = labelTargets(body);
  if (!name) return c.json({ error: 'Label name is required' }, 400);
  if (!targets.length) return c.json({ error: 'No labels selected' }, 400);

  const db = c.get('db');
  const env = c.get('env') || {};
  const errors = [];
  let updated = 0;
  for (const target of targets) {
    try {
      await updateLabel(db, env, target.accountId, target.labelId, name);
      updated += 1;
    } catch (error) {
      errors.push({ accountId: target.accountId, error: error.message });
    }
  }
  await refreshAccounts(db, env, targets.map((target) => target.accountId));
  if (!updated) return c.json({ error: errors[0]?.error || 'Could not rename label', errors }, 502);
  return c.json({ ok: true, updated, errors });
});

mail.delete('/labels', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:labels', user);
  if (err) return err;

  const body = await c.req.json().catch(() => ({}));
  const targets = labelTargets(body);
  if (!targets.length) return c.json({ error: 'No labels selected' }, 400);

  const db = c.get('db');
  const env = c.get('env') || {};
  const errors = [];
  let deleted = 0;
  for (const target of targets) {
    try {
      await deleteLabel(db, env, target.accountId, target.labelId);
      await db.prepare(`
        UPDATE messages SET label_ids = (
          SELECT COALESCE(json_group_array(value), '[]')
          FROM json_each(label_ids) WHERE value != ?
        ) WHERE account_id = ? AND label_ids LIKE ?
      `).bind(target.labelId, target.accountId, `%"${target.labelId}"%`).run();
      await db.prepare('DELETE FROM labels WHERE account_id = ? AND gmail_label_id = ?')
        .bind(target.accountId, target.labelId).run();
      deleted += 1;
    } catch (error) {
      errors.push({ accountId: target.accountId, error: error.message });
    }
  }
  if (!deleted) return c.json({ error: errors[0]?.error || 'Could not delete label', errors }, 502);
  return c.json({ ok: true, deleted, errors });
});

async function searchAccount(db, env, account, q, limit) {
  const listed = await listMessages(db, env, account.id, { q, maxResults: limit });
  const ids = (listed.messages || []).map((message) => message.id).slice(0, limit);
  const messages = [];
  for (let index = 0; index < ids.length; index += 10) {
    const chunk = ids.slice(index, index + 10);
    const settled = await Promise.allSettled(
      chunk.map((id) => getMessageMetadata(db, env, account.id, id))
    );
    for (const item of settled) {
      if (item.status === 'fulfilled') messages.push(normalizeMessage(account.id, item.value));
    }
  }
  if (messages.length) await storeMessages(db, account.id, messages);
  return messages;
}

async function cachedSearch(db, accountId, q, limit) {
  const like = `%${q}%`;
  const { results } = await db.prepare(`
    SELECT m.id, m.account_id, m.gmail_message_id, m.gmail_thread_id, m.internal_date,
           m.from_name, m.from_email, m.subject, m.snippet, m.label_ids,
           m.is_unread, m.is_starred, m.is_important, m.has_attachment,
           a.display_name AS account_name, a.card_color
    FROM messages m JOIN google_accounts a ON a.id = m.account_id
    WHERE m.account_id = ?
      AND (m.subject LIKE ? OR m.snippet LIKE ? OR m.from_email LIKE ? OR m.from_name LIKE ?)
    ORDER BY m.internal_date DESC LIMIT ?
  `).bind(accountId, like, like, like, like, limit).all();
  return results;
}

mail.get('/search', async (c) => {
  const user = c.get('user');
  let err = requirePage(c, 'mail', user);
  if (err) return err;
  err = requirePermission(c, 'mail:search', user);
  if (err) return err;

  const q = String(c.req.query('q') || '').trim();
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit')) || 30));
  const accountId = Number(c.req.query('accountId')) || 0;
  if (!q) return c.json({ query: '', results: [], total: 0, accounts: [], cached: false });

  const db = c.get('db');
  const env = c.get('env') || {};
  const revealEmail = user.role === 'master' || user.permissions.includes('accounts:view_email');

  const { results: accounts } = await db.prepare(`
    SELECT id, email, display_name, card_color FROM google_accounts
    WHERE status != 'reauth_required' ${accountId ? 'AND id = ?' : ''}
    ORDER BY is_default DESC, id
  `).bind(...(accountId ? [accountId] : [])).all();

  const merged = [];
  const statuses = [];
  await Promise.all(accounts.map(async (account) => {
    const email = revealEmail ? account.email : maskEmail(account.email);
    try {
      const messages = await searchAccount(db, env, account, q, limit);
      merged.push(...messages.map((message) => ({
        ...message,
        account_email: email,
        account_name: account.display_name,
        card_color: account.card_color
      })));
      statuses.push({ id: account.id, email, count: messages.length });
    } catch {
      const cached = await cachedSearch(db, account.id, q, limit);
      cached.forEach((message) => { message.account_email = email; });
      merged.push(...cached);
      statuses.push({
        id: account.id, email, count: cached.length,
        error: 'Gmail unavailable — showing cached results'
      });
    }
  }));

  const seen = new Set();
  const unique = merged.filter((message) => {
    const key = `${message.account_id}|${message.gmail_message_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.internal_date) - Number(a.internal_date));

  return c.json({
    query: q,
    results: unique.slice(0, limit),
    total: unique.length,
    accounts: statuses.sort((a, b) => a.id - b.id),
    cached: statuses.some((status) => status.error)
  });
});

export default mail;