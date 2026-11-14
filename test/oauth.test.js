import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildAuthUrl, isOAuthConfigured, GMAIL_SCOPES } from '../src/services/google-oauth.js';
import { createOAuthState, consumeOAuthState } from '../src/services/oauth-state.js';
import { pickAccountColor, normalizeCardColor } from '../src/services/account-colors.js';

function memoryDB() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY, user_id INTEGER NOT NULL, redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  return {
    sqlite,
    prepare(sql) {
      const stmt = sqlite.query(sql);
      return {
        bind(...args) {
          return {
            first: async () => stmt.get(...args) ?? null,
            run: async () => stmt.run(...args)
          };
        }
      };
    }
  };
}

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
const env = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'secret' };

test('configured check and auth url params', () => {
  expect(isOAuthConfigured(env)).toBe(true);
  expect(isOAuthConfigured({})).toBe(false);
  expect(isOAuthConfigured({ ...env, GOOGLE_CLIENT_ID: '511597536932-gjoabr1633v12gvrh7gabhkjsap5clpc.apps.googleusercon' })).toBe(false);
  expect(isOAuthConfigured({ ...env, GOOGLE_CLIENT_SECRET: '' })).toBe(false);

  const url = new URL(buildAuthUrl({ env, redirectUri: 'https://mail.test/auth/callback', state: 'abc', loginHint: 'a@b.co' }));
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(url.searchParams.get('redirect_uri')).toBe('https://mail.test/auth/callback');
  expect(url.searchParams.get('state')).toBe('abc');
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  expect(url.searchParams.get('login_hint')).toBe('a@b.co');
  expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '));
});

test('oauth state is one-time and user-bound', async () => {
  const db = memoryDB();
  const state = await createOAuthState(db, 1, 'https://mail.test/auth/callback');
  expect(state).toMatch(/^[0-9a-f]{64}$/);

  const row = await consumeOAuthState(db, state, 1);
  expect(row.redirect_uri).toBe('https://mail.test/auth/callback');
  expect(await consumeOAuthState(db, state, 1)).toBe(null);

  const other = await createOAuthState(db, 1, 'https://mail.test/auth/callback');
  expect(await consumeOAuthState(db, other, 2)).toBe(null);
  expect(await consumeOAuthState(db, other, 1)).toBe(null);
});

test('expired oauth state is rejected', async () => {
  const db = memoryDB();
  const state = 'expired-state';
  db.sqlite.run(
    'INSERT INTO oauth_states (state, user_id, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    state, 1, 'https://mail.test/auth/callback', Date.now() - 1000, Date.now() - 1
  );
  expect(await consumeOAuthState(db, state, 1)).toBe(null);
});

test('account colors are validated and unique picks differ', () => {
  expect(normalizeCardColor('#A1B2C3')).toBe('#a1b2c3');
  expect(normalizeCardColor('red')).toBe(null);
  expect(normalizeCardColor('')).toBe(null);
  const first = pickAccountColor([]);
  expect(pickAccountColor([first])).toBe('#7c3aed');
});
