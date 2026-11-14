import { Hono } from 'hono';
import { requirePermission } from '../middleware/auth.js';
import { fetchAttachment } from '../services/gmail.js';
import { safeAttachmentName } from '../services/mail-body.js';
import { verifyAttachment } from '../services/signing.js';

const attachments = new Hono();

attachments.get('/:accountId/:messageId/:attachmentId', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'mail:attachments', user);
  if (err) return err;

  const accountId = Number(c.req.param('accountId'));
  const messageId = c.req.param('messageId');
  const attachmentId = c.req.param('attachmentId');
  if (!accountId || !messageId || !attachmentId) {
    return c.json({ error: 'Invalid attachment path' }, 400);
  }

  const db = c.get('db');
  const valid = await verifyAttachment(
    db, accountId, messageId, attachmentId, c.req.query('exp'), c.req.query('token')
  );
  if (!valid) return c.json({ error: 'Attachment link expired' }, 403);
  const account = await db.prepare('SELECT id FROM google_accounts WHERE id = ?').bind(accountId).first();
  if (!account) return c.json({ error: 'Account not found' }, 404);

  let res;
  try {
    res = await fetchAttachment(db, c.get('env') || {}, accountId, messageId, attachmentId);
  } catch (error) {
    return c.json({ error: 'Attachment unavailable' }, error.status === 404 ? 404 : 502);
  }

  let buffer;
  try {
    const payload = await res.json();
    buffer = Buffer.from(payload?.data || '', 'base64url');
  } catch {
    return c.json({ error: 'Attachment unavailable' }, 502);
  }
  if (!buffer.length) return c.json({ error: 'Attachment unavailable' }, 502);
  const name = safeAttachmentName(c.req.query('name'));
  const type = c.req.query('type') || res.headers.get('content-type') || 'application/octet-stream';
  const disposition = c.req.query('inline') === '1' ? 'inline' : 'attachment';
  return c.body(buffer, 200, {
    'Content-Type': type,
    'Content-Disposition': `${disposition}; filename="${name}"`,
    'Content-Length': String(buffer.byteLength),
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });
});

export default attachments;