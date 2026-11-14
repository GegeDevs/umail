import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 60 * 60 * 1000;
let cachedSecret = null;

async function secret(db) {
  if (cachedSecret) return cachedSecret;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'signing_secret'").first();
  if (row?.value) {
    cachedSecret = row.value;
    return cachedSecret;
  }
  cachedSecret = randomBytes(32).toString('hex');
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('signing_secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(cachedSecret).run();
  return cachedSecret;
}

function digest(key, parts) {
  return createHmac('sha256', key).update(parts.join('\n')).digest('base64url');
}

export function resetSigningSecret() {
  cachedSecret = null;
}

export async function signAttachment(db, accountId, messageId, attachmentId, ttl = TTL_MS) {
  const exp = Date.now() + ttl;
  const token = digest(await secret(db), [accountId, messageId, attachmentId, exp]);
  return { exp, token };
}

export async function verifyAttachment(db, accountId, messageId, attachmentId, exp, token) {
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < Date.now() || !token) return false;
  const expected = Buffer.from(digest(await secret(db), [accountId, messageId, attachmentId, expires]));
  const actual = Buffer.from(String(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function signedAttachmentUrl(db, accountId, messageId, attachment) {
  const { exp, token } = await signAttachment(db, accountId, messageId, attachment.attachment_id);
  const query = new URLSearchParams({
    name: attachment.filename,
    type: attachment.mime_type,
    exp: String(exp),
    token
  });
  if (attachment.is_inline) query.set('inline', '1');
  return `/api/attachments/${accountId}/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.attachment_id)}?${query}`;
}
