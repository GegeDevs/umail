import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createOAuthState(db, userId, redirectUri) {
  const now = Date.now();
  const state = randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now).run();
  await db.prepare(
    'INSERT INTO oauth_states (state, user_id, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(state, userId, redirectUri, now, now + STATE_TTL_MS).run();
  return state;
}

export async function consumeOAuthState(db, state, userId) {
  if (!state) return null;
  const row = await db.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first();
  if (!row) return null;
  await db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (Number(row.expires_at) < Date.now() || Number(row.user_id) !== Number(userId)) return null;
  return row;
}
