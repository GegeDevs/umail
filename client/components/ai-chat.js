import { api } from '../api.js';
import { hasPageAccess } from '../auth-state.js';
import { escapeHtml } from '../lib/html.js';
import { renderAiMarkdown } from '../lib/ai-markdown.js';
import { showToast } from './toast.js';

const STORE_KEY = 'umail.aiChatSessions';
const ACTIVE_KEY = 'umail.aiChatActive';
const MAX_SESSIONS = 15;
const MAX_STORED_MESSAGES = 60;
const MAX_STORED_CHARS = 4000;

let sessions = [];
let current = null;
let root = null;
let listEl = null;
let historyEl = null;
let inputEl = null;
let busy = false;
let lastError = '';

function newSession() {
  return {
    id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, ''),
    title: '',
    updatedAt: Date.now(),
    messages: []
  };
}

function makeMessage(role, content, sources = []) {
  const random = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return { clientId: `m-${random}`.slice(0, 60), role, content, sources, createdAt: Date.now() };
}

function sanitizeSessions(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .filter((session) => session && typeof session.id === 'string' && Array.isArray(session.messages))
    .map((session) => ({
      id: session.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
      title: String(session.title || '').slice(0, 80),
      updatedAt: Number(session.updatedAt) || Date.now(),
      messages: session.messages
        .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
        .slice(-MAX_STORED_MESSAGES)
        .map((message, index) => ({
          clientId: String(message.clientId || `legacy-${session.id}-${index}`)
            .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60),
          createdAt: Number(message.createdAt) || (Number(session.updatedAt) || Date.now()) + index,
          role: message.role,
          content: message.content.slice(0, MAX_STORED_CHARS),
          ...(message.role === 'assistant' && Array.isArray(message.sources)
            ? {
                sources: message.sources
                  .filter((source) => source && typeof source.subject === 'string')
                  .slice(0, 6)
                  .map((source) => ({
                    accountId: Number(source.accountId) || 0,
                    threadId: String(source.threadId || ''),
                    subject: source.subject.slice(0, 200),
                    from: String(source.from || '').slice(0, 200)
                  }))
              }
            : {})
        }))
    }))
    .filter((session) => session.id && session.messages.length)
    .slice(0, MAX_SESSIONS);
}

function loadSessions() {
  try {
    return sanitizeSessions(JSON.parse(localStorage.getItem(STORE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function writeStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  } catch {
    sessions = sessions.slice(0, 5);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
      localStorage.setItem(ACTIVE_KEY, current?.id || '');
    } catch {
      // Storage full: keep the in-memory transcript for this tab.
    }
  }
}

function persist() {
  if (!current || !current.messages.length) return;
  current.updatedAt = Date.now();
  if (!current.title) {
    current.title = (current.messages.find((message) => message.role === 'user')?.content || 'New chat').slice(0, 48);
  }
  current.messages = current.messages.slice(-MAX_STORED_MESSAGES);
  sessions = [current, ...sessions.filter((session) => session.id !== current.id)].slice(0, MAX_SESSIONS);
  localStorage.setItem(ACTIVE_KEY, current.id);
  writeStore();
}

function forgetSession(id) {
  sessions = sessions.filter((session) => session.id !== id);
  writeStore();
  if (current?.id === id) {
    current = sessions[0] || newSession();
    localStorage.setItem(ACTIVE_KEY, current.id);
    lastError = 'This chat was deleted on another device.';
  }
  renderHistory();
  renderMessages();
}

// Append-only: server ignores duplicate clientIds, so two devices cannot overwrite each other.
function appendMessages(session, messages) {
  if (!messages.length) return Promise.resolve(null);
  return api(`/api/mail/ai/chat/sessions/${session.id}/messages`, {
    method: 'POST',
    body: { title: session.title, messages }
  }).catch((error) => {
    if (error.status === 410) {
      forgetSession(session.id);
      showToast('This chat was deleted on another device.', 'error');
    } else {
      console.warn('AI chat sync failed:', error.message);
    }
    return null;
  });
}

function removeRemoteSession(id) {
  api(`/api/mail/ai/chat/sessions/${id}`, { method: 'DELETE' })
    .catch((error) => console.warn('AI chat delete failed:', error.message));
}

function selectSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session) return;
  current = session;
  lastError = '';
  localStorage.setItem(ACTIVE_KEY, current.id);
  historyEl?.classList.add('hidden');
  renderMessages();
  inputEl?.focus();
}

function deleteSession(id) {
  sessions = sessions.filter((session) => session.id !== id);
  writeStore();
  removeRemoteSession(id);
  if (current?.id === id) {
    current = sessions[0] || newSession();
    localStorage.setItem(ACTIVE_KEY, current.id);
  }
  renderHistory();
  renderMessages();
}

function startNewSession() {
  current = newSession();
  lastError = '';
  localStorage.setItem(ACTIVE_KEY, current.id);
  historyEl?.classList.add('hidden');
  renderMessages();
  inputEl?.focus();
}

function renderHistory() {
  if (!historyEl) return;
  historyEl.innerHTML = sessions.length
    ? sessions.map((session) => `
        <div class="flex items-center gap-1 px-2">
          <button data-session="${session.id}" class="flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
            <div class="truncate text-xs font-medium ${session.id === current?.id ? 'text-blue-600 dark:text-blue-400' : ''}">${escapeHtml(session.title || 'New chat')}</div>
            <div class="text-[10px] text-gray-500 dark:text-gray-400">${new Date(session.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
          </button>
          <button data-delete="${session.id}" class="btn-icon !p-1 text-gray-400 hover:text-red-500" title="Delete chat">
            <span class="material-icons-outlined text-base">delete</span>
          </button>
        </div>`).join('')
    : '<div class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">No saved chats yet.</div>';
}

function sourceLink(source) {
  const label = [source.from, source.subject].filter(Boolean).join(' — ');
  return `<a href="#/search?q=${encodeURIComponent(source.subject || '')}" data-ai-source
    class="block truncate text-xs text-blue-600 dark:text-blue-400 hover:underline">${escapeHtml(label)}</a>`;
}

function renderMessages() {
  if (!listEl) return;
  const messages = current?.messages || [];
  const bubbles = messages.map((message) => {
    if (message.role === 'user') {
      return `<div class="ml-auto max-w-[85%] rounded-lg bg-blue-600 text-white px-3 py-2 text-sm whitespace-pre-line">${escapeHtml(message.content)}</div>`;
    }
    const sources = message.sources?.length
      ? `<div class="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-0.5">
          <div class="text-[11px] text-gray-500 dark:text-gray-400">Sources</div>
          ${message.sources.map(sourceLink).join('')}
        </div>`
      : '';
    return `<div class="max-w-[95%] rounded-lg bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-100 space-y-1">
      ${renderAiMarkdown(message.content)}${sources}
    </div>`;
  }).join('');
  const empty = messages.length
    ? ''
    : `<div class="text-sm text-gray-500 dark:text-gray-400">
        Ask about your mail. For example: "What is the latest email from my bank?" or "Summarize this week's invoices."
      </div>`;
  const thinking = busy
    ? `<div class="text-xs text-gray-500 dark:text-gray-400">Thinking...</div>`
    : '';
  const error = lastError
    ? `<div class="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">${escapeHtml(lastError)}</div>`
    : '';
  listEl.innerHTML = `${empty}${bubbles}${thinking}${error}`;
  listEl.scrollTop = listEl.scrollHeight;
}

function ensurePanel() {
  if (root) return;
  root = document.createElement('div');
  root.id = 'ai-chat-root';
  root.className = 'hidden fixed inset-0 z-[60]';
  root.innerHTML = `
    <div id="ai-chat-backdrop" class="absolute inset-0 bg-black/30"></div>
    <aside class="absolute right-0 top-0 h-full w-full md:w-[420px] bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col shadow-2xl">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <span class="material-icons-outlined text-blue-600 dark:text-blue-400">forum</span>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm">Ask your mail</div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400">Read-only. Never send or change.</div>
        </div>
        <button id="ai-chat-new" class="btn-icon !p-1.5 text-gray-500" title="New chat">
          <span class="material-icons-outlined">add_comment</span>
        </button>
        <button id="ai-chat-history-btn" class="btn-icon !p-1.5 text-gray-500" title="Chat history" aria-expanded="false">
          <span class="material-icons-outlined">history</span>
        </button>
        <button id="ai-chat-close" class="btn-icon !p-1.5 text-gray-500" title="Close chat" aria-label="Close chat">
          <span class="material-icons-outlined">close</span>
        </button>
      </div>
      <div id="ai-chat-history" class="hidden max-h-52 overflow-y-auto py-1 border-b border-gray-100 dark:border-gray-700"></div>
      <div id="ai-chat-messages" class="flex-1 overflow-y-auto px-3 py-3 space-y-2"></div>
      <form id="ai-chat-form" class="flex items-center gap-2 px-3 py-3 border-t border-gray-100 dark:border-gray-700">
        <input id="ai-chat-input" class="field !py-1.5" placeholder="Ask about your mail" autocomplete="off" maxlength="1000">
        <button id="ai-chat-send" class="btn-primary !px-3" type="submit" title="Send">
          <span class="material-icons-outlined text-base">send</span>
        </button>
      </form>
    </aside>`;
  document.body.appendChild(root);
  listEl = root.querySelector('#ai-chat-messages');
  historyEl = root.querySelector('#ai-chat-history');
  inputEl = root.querySelector('#ai-chat-input');
  const form = root.querySelector('#ai-chat-form');
  const sendButton = root.querySelector('#ai-chat-send');
  const newButton = root.querySelector('#ai-chat-new');
  const historyButton = root.querySelector('#ai-chat-history-btn');

  root.querySelector('#ai-chat-close').addEventListener('click', closePanel);
  root.querySelector('#ai-chat-backdrop').addEventListener('click', closePanel);
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-ai-source]')) closePanel();
  });
  // Keep the panel inside the visible area when the mobile keyboard opens.
  const fitViewport = () => {
    const vv = window.visualViewport;
    if (!vv || root.classList.contains('hidden')) return;
    root.style.height = `${vv.height}px`;
    root.style.top = `${vv.offsetTop}px`;
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  };
  root._fitViewport = fitViewport;
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  newButton.addEventListener('click', startNewSession);
  historyButton.addEventListener('click', () => {
    renderHistory();
    historyEl.classList.toggle('hidden');
    historyButton.setAttribute('aria-expanded', String(!historyEl.classList.contains('hidden')));
  });
  historyEl.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete]');
    if (deleteButton) {
      deleteSession(deleteButton.dataset.delete);
      return;
    }
    const pick = event.target.closest('[data-session]');
    if (pick) selectSession(pick.dataset.session);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    await send(text);
  });
  function setBusy(value) {
    busy = value;
    sendButton.disabled = value;
    inputEl.disabled = value;
    newButton.disabled = value;
    historyButton.disabled = value;
  }
  root._setBusy = setBusy;
}

function openPanel() {
  ensurePanel();
  if (!current) current = newSession();
  root.classList.remove('hidden');
  root._fitViewport();
  renderMessages();
  inputEl.focus();
  root._fitViewport();
}

function closePanel() {
  root?.classList.add('hidden');
}

async function send(text) {
  if (localStorage.getItem('umail.aiNotice') !== '1') {
    if (!confirm('Send your question and matching email content to the configured AI provider?')) return;
    localStorage.setItem('umail.aiNotice', '1');
  }
  if (!current) current = newSession();
  const session = current;
  historyEl?.classList.add('hidden');
  const userMessage = makeMessage('user', text);
  session.messages.push(userMessage);
  lastError = '';
  persist();
  appendMessages(session, [userMessage]);
  root._setBusy(true);
  renderMessages();
  try {
    const result = await api('/api/mail/ai/chat', {
      method: 'POST',
      body: {
        messages: session.messages.slice(-8).map(({ role, content, sources }) => (
          role === 'assistant' ? { role, content, sources: sources || [] } : { role, content }
        ))
      }
    });
    const answer = makeMessage('assistant', result.answer, result.sources || []);
    session.messages.push(answer);
    persist();
    appendMessages(session, [answer]);
  } catch (error) {
    lastError = error.message;
  } finally {
    root._setBusy(false);
    renderMessages();
    inputEl.focus();
  }
}

export async function initAiChat() {
  const button = document.getElementById('btn-ai-chat');
  if (!button || !hasPageAccess('mail')) return;
  sessions = loadSessions();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  current = activeId ? sessions.find((session) => session.id === activeId) || newSession() : sessions[0] || newSession();
  try {
    const remote = sanitizeSessions((await api('/api/mail/ai/chat/sessions')).sessions);
    const migrated = localStorage.getItem('umail.aiChatMigrated') === '1';
    if (!migrated && !remote.length && sessions.length) {
      // One-time upload of history saved before server sync existed.
      for (const session of sessions) appendMessages(session, session.messages);
    } else {
      sessions = remote;
      const restored = sessions.find((session) => session.id === activeId) || sessions[0];
      current = restored || newSession();
      writeStore();
      localStorage.setItem(ACTIVE_KEY, current.id);
    }
    localStorage.setItem('umail.aiChatMigrated', '1');
  } catch {
    // Server unavailable: keep the browser cache.
  }
  button.classList.remove('hidden');
  button.addEventListener('click', openPanel);
}
