import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function keyFor(env = {}) {
  const raw = String(env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}

export function hasTokenEncryptionKey(env = {}) {
  return Boolean(keyFor(env));
}

export function encryptToken(value, env = {}) {
  if (!value) return value;
  const text = String(value);
  if (text.startsWith(PREFIX)) return text;
  const key = keyFor(env);
  if (!key) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptToken(value, env = {}) {
  if (!value) return value;
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text;
  const key = keyFor(env);
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is required to read encrypted tokens');
  const [iv, tag, data] = text.slice(PREFIX.length).split('.');
  if (!iv || !tag || !data) throw new Error('Stored token is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export async function encryptStoredTokens(db, env = {}) {  if (!keyFor(env)) return 0;
  const { results } = await db.prepare('SELECT id, access_token, refresh_token FROM google_accounts').all();
  let updated = 0;
  for (const row of results) {
    const access = encryptToken(row.access_token, env);
    const refresh = encryptToken(row.refresh_token, env);
    if (access === row.access_token && refresh === row.refresh_token) continue;
    await db.prepare('UPDATE google_accounts SET access_token = ?, refresh_token = ? WHERE id = ?')
      .bind(access, refresh, row.id).run();
    updated += 1;
  }
  return updated;
}

export async function encryptStoredChat(db, env = {}) {
  if (!keyFor(env)) return 0;
  const { results } = await db.prepare('SELECT seq, payload FROM ai_chat_messages').all();
  let updated = 0;
  for (const row of results) {
    const payload = encryptToken(row.payload, env);
    if (payload === row.payload) continue;
    await db.prepare('UPDATE ai_chat_messages SET payload = ? WHERE seq = ?').bind(payload, row.seq).run();
    updated += 1;
  }
  return updated;
}
