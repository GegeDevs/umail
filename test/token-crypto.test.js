import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { wrapDatabase } from '../src/db/local.js';
import { initDB } from '../src/db/index.js';
import { decryptToken, encryptToken, encryptStoredTokens, hasTokenEncryptionKey } from '../src/services/token-crypto.js';

const env = { TOKEN_ENCRYPTION_KEY: 'test-secret' };

test('tokens pass through unchanged without a key', () => {
  expect(hasTokenEncryptionKey({})).toBe(false);
  expect(encryptToken('plain', {})).toBe('plain');
  expect(decryptToken('plain', {})).toBe('plain');
});

test('encrypts to enc:v1 format and decrypts back', () => {
  const encrypted = encryptToken('ya29.secret', env);
  expect(hasTokenEncryptionKey(env)).toBe(true);
  expect(encrypted.startsWith('enc:v1:')).toBe(true);
  expect(encrypted).not.toContain('ya29.secret');
  expect(decryptToken(encrypted, env)).toBe('ya29.secret');
  expect(encryptToken(encrypted, env)).toBe(encrypted);
});

test('fails to decrypt with the wrong key', () => {
  const encrypted = encryptToken('ya29.secret', env);
  expect(() => decryptToken(encrypted, { TOKEN_ENCRYPTION_KEY: 'other' })).toThrow();
  expect(() => decryptToken(encrypted, {})).toThrow('TOKEN_ENCRYPTION_KEY');
});

test('startup migration encrypts existing plaintext tokens', async () => {
  const db = wrapDatabase(new Database(':memory:'));
  await initDB(db);
  await db.prepare(`
    INSERT INTO google_accounts (email, access_token, refresh_token, token_expiry, card_color)
    VALUES ('ada@example.com', 'access', 'refresh', 1, '#2563eb')
  `).run();

  expect(await encryptStoredTokens(db, env)).toBe(1);
  const row = await db.prepare('SELECT access_token, refresh_token FROM google_accounts').first();
  expect(row.access_token.startsWith('enc:v1:')).toBe(true);
  expect(row.refresh_token.startsWith('enc:v1:')).toBe(true);
  expect(decryptToken(row.access_token, env)).toBe('access');
  expect(decryptToken(row.refresh_token, env)).toBe('refresh');
  expect(await encryptStoredTokens(db, env)).toBe(0);
});
