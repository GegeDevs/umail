import { getAccessToken, refreshAccountToken } from './token-manager.js';
import { METADATA_HEADERS } from './gmail-parse.js';
import { logSystem } from './logger.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REQUEST_TIMEOUT_MS = 30000;
const NETWORK_RETRIES = 2;
const RATE_LIMIT_RETRIES = 3;
const GLOBAL_LIMIT = 4;
const ACCOUNT_LIMIT = 2;

export class GmailError extends Error {
  constructor(message, { status = 502, code = 'gmail_error' } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.code = code;
  }
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  return (fn) => new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < max) start();
    else queue.push(start);
  });
}

const globalLimiter = createLimiter(GLOBAL_LIMIT);
const accountLimiters = new Map();

function limitForAccount(accountId) {
  if (!accountLimiters.has(accountId)) accountLimiters.set(accountId, createLimiter(ACCOUNT_LIMIT));
  return accountLimiters.get(accountId);
}

function runLimited(accountId, fn) {
  return globalLimiter(() => limitForAccount(accountId)(fn));
}

async function readBody(res) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { return await res.json(); } catch { return {}; }
  }
  try { return await res.text(); } catch { return ''; }
}

function headers(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function isRateLimited(res) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const body = await res.clone().json().catch(() => null);
  const error = body?.error;
  if (!error) return false;
  if (error.status === 'RESOURCE_EXHAUSTED' || error.status === 'rateLimitExceeded') return true;
  return (error.errors || []).some((item) =>
    item.reason === 'rateLimitExceeded' || item.reason === 'userRateLimitExceeded');
}

export async function gmailRequest(db, env, accountId, path, options = {}) {
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;
  let token = await getAccessToken(db, env, accountId);
  let authRetried = false;
  let networkRetries = 0;
  let rateRetries = 0;

  for (;;) {
    let res;
    try {
      res = await runLimited(accountId, () => fetch(url, {
        ...options,
        headers: headers(token, options.headers || {}),
        signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }));
    } catch (error) {
      if (networkRetries < NETWORK_RETRIES) {
        networkRetries += 1;
        continue;
      }
      throw new GmailError(`Gmail network error: ${error.message}`, { code: 'gmail_network' });
    }

    if (res.status === 401 && !authRetried) {
      authRetried = true;
      token = await refreshAccountToken(db, env, accountId);
      continue;
    }

    if (await isRateLimited(res)) {
      if (rateRetries >= RATE_LIMIT_RETRIES) {
        throw new GmailError('Gmail rate limit exceeded', {
          status: res.status,
          code: 'rate_limit_exceeded'
        });
      }
      const wait = Math.min(2 ** (rateRetries + 1) * 1000, 60000);
      rateRetries += 1;
      await logSystem(db, 'warn', 'Gmail rate limit', `account ${accountId}: retry in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }

    if (!res.ok) {
      const body = await readBody(res);
      const message = body?.error?.message || body?.error || (typeof body === 'string' ? body : '')
        || `Gmail request failed (${res.status})`;
      throw new GmailError(String(message).slice(0, 500), {
        status: res.status,
        code: body?.error?.status || `gmail_${res.status}`
      });
    }
    return res;
  }
}

async function gmailJson(db, env, accountId, path, options = {}) {
  const res = await gmailRequest(db, env, accountId, path, options);
  return res.json();
}

export function getProfile(db, env, accountId) {
  return gmailJson(db, env, accountId, '/users/me/profile');
}

export function listLabels(db, env, accountId) {
  return gmailJson(db, env, accountId, '/users/me/labels');
}

function labelBody(label) {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(label)
  };
}

export function createLabel(db, env, accountId, name) {
  return gmailJson(db, env, accountId, '/users/me/labels', {
    method: 'POST',
    ...labelBody({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' })
  });
}

export function updateLabel(db, env, accountId, labelId, name) {
  return gmailJson(db, env, accountId, `/users/me/labels/${encodeURIComponent(labelId)}`, {
    method: 'PATCH',
    ...labelBody({ name })
  });
}

export async function deleteLabel(db, env, accountId, labelId) {
  await gmailRequest(db, env, accountId, `/users/me/labels/${encodeURIComponent(labelId)}`, {
    method: 'DELETE'
  });
}

export function listMessages(db, env, accountId, { q = '', maxResults = 500, pageToken = '' } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  return gmailJson(db, env, accountId, `/users/me/messages?${params}`);
}

export function getMessageMetadata(db, env, accountId, id) {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const name of METADATA_HEADERS) params.append('metadataHeaders', name);
  return gmailJson(db, env, accountId, `/users/me/messages/${encodeURIComponent(id)}?${params}`);
}

export function listHistory(db, env, accountId, startHistoryId, { pageToken = '' } = {}) {
  const params = new URLSearchParams({ startHistoryId: String(startHistoryId), maxResults: '500' });
  if (pageToken) params.set('pageToken', pageToken);
  return gmailJson(db, env, accountId, `/users/me/history?${params}`);
}

export async function fetchGmailProfile(accessToken) {
  const res = await fetch(`${GMAIL_BASE}/users/me/profile`, {
    headers: headers(accessToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await readBody(res);
  if (!res.ok) {
    const message = body?.error?.message || body?.error || `Gmail profile failed (${res.status})`;
    throw new GmailError(String(message).slice(0, 500), { status: res.status, code: 'gmail_profile_failed' });
  }
  return body;
}

export async function revokeGoogleToken(token) {
  if (!token) return false;
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getMessageFull(db, env, accountId, id) {
  const params = new URLSearchParams({ format: 'full' });
  return gmailJson(db, env, accountId, `/users/me/messages/${encodeURIComponent(id)}?${params}`);
}

export function fetchAttachment(db, env, accountId, messageId, attachmentId) {
  return gmailRequest(
    db, env, accountId,
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
}

export function sendMessage(db, env, accountId, raw, threadId) {
  const body = { raw };
  if (threadId) body.threadId = threadId;
  return gmailJson(db, env, accountId, '/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export function createDraft(db, env, accountId, raw, threadId) {
  const message = { raw };
  if (threadId) message.threadId = threadId;
  return gmailJson(db, env, accountId, '/users/me/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

export function updateDraft(db, env, accountId, draftId, raw, threadId) {
  const message = { raw };
  if (threadId) message.threadId = threadId;
  return gmailJson(db, env, accountId, `/users/me/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: draftId, message })
  });
}

export async function deleteDraft(db, env, accountId, draftId) {
  await gmailRequest(db, env, accountId, `/users/me/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE'
  });
  return true;
}

export async function batchModify(db, env, accountId, ids, addLabelIds = [], removeLabelIds = []) {
  await gmailRequest(db, env, accountId, '/users/me/messages/batchModify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds })
  });
  return true;
}
