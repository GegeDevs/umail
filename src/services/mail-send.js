import { sendMessage, deleteDraft } from './gmail.js';
import { buildMime, MimeError } from './mime.js';
import { storeMessages } from './mail-store.js';

export class MailError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MailError';
    this.status = status;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRecipients(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  const emails = [];
  for (const part of parts) {
    const text = String(part || '').trim();
    if (!text) continue;
    const match = text.match(/<([^>]+)>/);
    const email = (match ? match[1] : text).trim().toLowerCase();
    if (EMAIL.test(email)) emails.push(email);
  }
  return [...new Set(emails)];
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function recordSent(db, accountId, account, payload, result) {
  const to = parseRecipients(payload.to);
  const cc = parseRecipients(payload.cc);
  const bcc = parseRecipients(payload.bcc);
  const address = (email) => ({ name: '', email });
  await storeMessages(db, accountId, [{
    account_id: accountId,
    gmail_message_id: result.id,
    gmail_thread_id: result.threadId || payload.threadId || result.id,
    internal_date: Date.now(),
    from_name: account.display_name || null,
    from_email: account.email,
    to_json: JSON.stringify(to.map(address)),
    cc_json: JSON.stringify(cc.map(address)),
    bcc_json: JSON.stringify(bcc.map(address)),
    reply_to: null,
    subject: payload.subject || '',
    snippet: snippet(payload.body),
    label_ids: JSON.stringify(result.labelIds || ['SENT']),
    size_estimate: 0,
    is_unread: 0,
    is_starred: 0,
    is_important: 0,
    has_attachment: (payload.attachments || []).length ? 1 : 0,
    raw_headers_json: JSON.stringify({
      messageId: '',
      inReplyTo: payload.inReplyTo || '',
      references: payload.references || ''
    })
  }]);
}

export async function discardLocalDraft(db, env, accountId, draftId) {
  if (!draftId) return;
  const row = await db.prepare('SELECT * FROM drafts WHERE id = ? AND account_id = ?').bind(draftId, accountId).first();
  if (!row) return;
  if (row.gmail_draft_id) {
    try { await deleteDraft(db, env, accountId, row.gmail_draft_id); } catch {}
  }
  await db.prepare('DELETE FROM drafts WHERE id = ?').bind(draftId).run();
}

export async function sendMail(db, env, accountId, payload) {
  const account = await db.prepare('SELECT * FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) throw new MailError('Account not found', 404);

  const to = parseRecipients(payload.to);
  const cc = parseRecipients(payload.cc).filter((email) => email !== account.email.toLowerCase());
  const bcc = parseRecipients(payload.bcc).filter((email) => email !== account.email.toLowerCase());
  if (!to.length && !cc.length && !bcc.length) {
    throw new MailError('At least one valid recipient is required.');
  }

  let raw;
  try {
    raw = buildMime({
      from: account.email,
      to,
      cc,
      bcc,
      subject: payload.subject || '',
      text: payload.body || '',
      html: payload.bodyHtml || '',
      inReplyTo: payload.inReplyTo || '',
      references: payload.references || '',
      attachments: payload.attachments || []
    });
  } catch (error) {
    if (error instanceof MimeError) throw new MailError(error.message);
    throw error;
  }

  const result = await sendMessage(db, env, accountId, raw, payload.threadId || '');
  try {
    await recordSent(db, accountId, account, payload, result);
  } catch {}
  await discardLocalDraft(db, env, accountId, payload.draftId);
  return { ok: true, messageId: result.id, threadId: result.threadId || payload.threadId || null };
}