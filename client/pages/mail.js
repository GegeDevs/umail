import { api } from '../api.js';
import { getQueryParams, navigate } from '../router.js';
import { showToast } from '../components/toast.js';
import { openComposer } from '../components/composer.js';
import { escapeHtml, safeColor } from '../lib/html.js';
import { renderAiMarkdown } from '../lib/ai-markdown.js';
import { formatTimeAgo, formatDateTime } from '../time-utils.js';
import { hasPermission } from '../auth-state.js';

const MAILBOXES = {
  inbox: { title: 'Inbox', subtitle: 'Unified across all accounts', icon: 'inbox' },
  starred: { title: 'Starred', subtitle: 'Messages you marked with a star', icon: 'star' },
  sent: { title: 'Sent', subtitle: 'Mail sent from connected accounts', icon: 'send' },
  drafts: { title: 'Drafts', subtitle: 'Unsent messages', icon: 'drafts' },
  archive: { title: 'Archive', subtitle: 'Messages outside the inbox', icon: 'archive' },
  spam: { title: 'Spam', subtitle: 'Messages Gmail marked as spam', icon: 'report' },
  trash: { title: 'Trash', subtitle: 'Deleted messages', icon: 'delete' },
  important: { title: 'Important', subtitle: 'Messages Gmail marked important', icon: 'label_important' }
};

const SYSTEM_LABELS = new Set([
  'INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH',
  'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
]);
const PAGE_SIZE = 30;
let mailPageVersion = 0;

function beginMailRender() {
  return ++mailPageVersion;
}

function recipientList(json) {
  try {
    return JSON.parse(json || '[]').map((item) => item.email || item).filter(Boolean);
  } catch {
    return [];
  }
}

function labelList(json) {
  try {
    return JSON.parse(json || '[]').filter((label) => !SYSTEM_LABELS.has(label));
  } catch {
    return [];
  }
}

function subjectWith(prefix, subject) {
  const text = String(subject || '');
  return new RegExp(`^${prefix}\\s*:`, 'i').test(text) ? text : `${prefix}: ${text}`;
}

function notifyCounts() {
  window.dispatchEvent(new CustomEvent('umail:counts-changed'));
}

function textHtml(text) {
  return escapeHtml(text || '').replace(/\r?\n/g, '<br>');
}

function iframeDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:;">
    <base target="_blank">
    <style>
      body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:14px;color:#111827;font-size:14px;line-height:1.55;word-break:break-word}
      img{max-width:100%;height:auto}
      a{color:#2563eb}
      blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #e5e7eb;color:#4b5563}
      pre{white-space:pre-wrap}
      table{max-width:100%}
    </style></head><body>${html || ''}</body></html>`;
}

function proxyRemoteImages(html) {
  if (!html || typeof DOMParser === 'undefined') return html || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('img').forEach((img) => {
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    const src = img.getAttribute('src') || '';
    const absolute = src.startsWith('//') ? `https:${src}` : src;
    if (!/^https?:/i.test(absolute)) return;
    img.setAttribute('src', `/api/mail/image?url=${encodeURIComponent(absolute)}`);
  });
  return doc.body.innerHTML;
}

export async function renderMailPage(params = {}) {
  const main = document.getElementById('main-content');
  const rawBox = getQueryParams().get('box') || 'inbox';
  const box = MAILBOXES[rawBox] ? rawBox : 'inbox';
  const labelName = String(params.name || '').trim();
  const meta = labelName
    ? { title: labelName, subtitle: 'Unified messages with this label', icon: 'label' }
    : MAILBOXES[box];
  const savedFilter = Number(localStorage.getItem('umail.mailAccount')) || 0;
  const pageVersion = beginMailRender();
  const state = {
    pageVersion,
    box,
    label: labelName,
    meta,
    accountId: savedFilter,
    cursor: null,
    messages: [],
    accounts: [],
    labels: [],
    thread: null,
    selected: new Map(),
    selectionAnchor: null,
    loading: false,
    observer: null,
    timer: null
  };

  main.innerHTML = shell(meta, box, state);
  bindSelectAll(state);

  const refresh = () => loadList(state, true);
  const onChange = () => {
    loadList(state, true);
    notifyCounts();
    if (state.thread) openThread(state, state.thread.account_id, state.thread.gmail_thread_id, true);
  };
  const onRefreshMail = async () => {
    try {
      await api('/api/mail/backfill', { method: 'POST' });
      showToast('Sync started. Mailbox will refresh shortly.', 'info');
      setTimeout(() => loadList(state, true), 2500);
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  window.addEventListener('umail:mail-changed', onChange);
  window.addEventListener('umail:refresh-mail', onRefreshMail);

  document.getElementById('mail-refresh')?.addEventListener('click', onRefreshMail);
  document.getElementById('mail-clear-spam')?.addEventListener('click', async (event) => {
    if (!confirm('Move all spam messages to Trash?')) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api('/api/mail/spam/clear', {
        method: 'POST',
        body: { accountId: state.accountId || 0 }
      });
      const reason = result.errors?.[0]?.error || '';
      showToast(
        result.failed ? `${result.cleared} cleared, ${result.failed} account(s) failed${reason ? `: ${reason}` : '.'}` : `${result.cleared} spam messages moved to Trash.`,
        result.failed ? 'error' : 'success'
      );
      notifyCounts();
      await loadList(state, false);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('mail-add-account')?.addEventListener('click', () => navigate('/accounts'));
  document.getElementById('mail-compose-fab')?.addEventListener('click', () => openComposer({}));
  document.getElementById('account-filter')?.addEventListener('change', (event) => {
    state.accountId = Number(event.target.value) || 0;
    localStorage.setItem('umail.mailAccount', String(state.accountId));
    loadList(state, false);
  });

  const onKeydown = (event) => {
    if (state.pageVersion !== mailPageVersion) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (document.getElementById('composer-root') || document.querySelector('#modal-root > *')) return;
    if (document.getElementById('mail-layout')?.classList.contains('reader-open')) return;
    const rows = [...document.querySelectorAll('#mail-list article[data-thread]')];
    const focused = rows.findIndex((row) => row.classList.contains('keyboard-focus'));
    const moveFocus = (index) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (!next) return;
      rows.forEach((row) => row.classList.remove('keyboard-focus'));
      next.classList.add('keyboard-focus');
      next.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'j' || event.key === 'k') {
      if (!rows.length) return;
      event.preventDefault();
      moveFocus(event.key === 'j' ? focused + 1 : (focused < 0 ? rows.length - 1 : focused - 1));
      return;
    }
    if (event.key === 'Enter' && focused >= 0) {
      event.preventDefault();
      rows[focused].click();
      return;
    }
    if (event.key !== 'Delete' || !state.selected.size) return;
    event.preventDefault();
    document.querySelector('#bulk-bar [data-bulk="trash"]')?.click();
  };
  document.addEventListener('keydown', onKeydown);

  state.timer = setInterval(() => {
    if (!document.hidden) loadList(state, false, true);
  }, 60000);

  await loadLabelOptions(state);
  await loadList(state, false);

  return () => {
    clearInterval(state.timer);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('umail:mail-changed', onChange);
    window.removeEventListener('umail:refresh-mail', onRefreshMail);
  };
}

function shell(meta, box, state) {
  return `
    <div id="mail-layout" class="mail-layout h-full flex flex-col">
      <div class="mail-page-header h-16 shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex items-center justify-between gap-3 px-4">
        <div class="min-w-0">
          <h1 class="text-lg md:text-xl font-bold truncate">${meta.title}</h1>
          <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${meta.subtitle}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <select id="account-filter" class="field !w-auto max-w-[160px] hidden sm:block">
            <option value="0">All accounts</option>
          </select>
          ${box === 'spam' && hasPermission('mail:delete') ? `<button id="mail-clear-spam" class="btn-secondary !px-2.5 !py-1.5 !text-xs text-red-600 dark:text-red-400" title="Move all spam to Trash"><span class="material-icons-outlined text-base">delete_sweep</span><span class="hidden sm:inline">Clear spam</span></button>` : ''}
          <button id="mail-refresh" class="btn-icon text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" title="Sync mail">
            <span class="material-icons-outlined">refresh</span>
          </button>
        </div>
      </div>
      <div class="flex flex-1 min-h-0">
        <section class="mail-list-pane w-full flex-1 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col min-h-0">
          <div id="list-toolbar" class="h-9 shrink-0 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2 px-2 text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            <input id="select-all" type="checkbox" class="rounded" title="Select all" aria-label="Select all messages">
            <span class="w-6 shrink-0" aria-hidden="true"></span>
            <span class="w-2 shrink-0" aria-hidden="true"></span>
            <span class="w-28 sm:w-36 shrink-0 hidden sm:block">From</span>
            <span class="flex-1 min-w-0 hidden sm:block">Content</span>
            <span id="mail-count" class="ml-auto shrink-0 normal-case">0 messages</span>
          </div>
          <div id="bulk-bar" class="hidden shrink-0 border-b border-gray-200 dark:border-gray-700 bg-blue-50/60 dark:bg-blue-900/20 px-2 h-11 items-center gap-1 text-xs">
            <button id="bulk-clear" class="btn-icon text-gray-600 dark:text-gray-300" title="Clear selection">
              <span class="material-icons-outlined text-lg">close</span>
            </button>
            <span id="bulk-count" class="font-medium text-blue-700 dark:text-blue-300 mr-1"></span>
            <button data-bulk="read" class="btn-icon text-gray-600 dark:text-gray-300" title="Mark as read"><span class="material-icons-outlined text-lg">mark_email_read</span></button>
            <button data-bulk="unread" class="btn-icon text-gray-600 dark:text-gray-300" title="Mark as unread"><span class="material-icons-outlined text-lg">mark_email_unread</span></button>
            <button data-bulk="star" class="btn-icon text-gray-600 dark:text-gray-300" title="Star"><span class="material-icons-outlined text-lg">star_border</span></button>
            <button data-bulk="unstar" class="btn-icon text-gray-600 dark:text-gray-300" title="Unstar"><span class="material-icons-outlined text-lg">star</span></button>
            <button data-bulk="archive" class="btn-icon text-gray-600 dark:text-gray-300" title="Archive"><span class="material-icons-outlined text-lg">archive</span></button>
            <button data-bulk="spam" class="btn-icon text-gray-600 dark:text-gray-300" title="Report spam"><span class="material-icons-outlined text-lg">report</span></button>
            <button data-bulk="trash" class="btn-icon text-red-600 dark:text-red-400" title="Delete"><span class="material-icons-outlined text-lg">delete</span></button>
            <select id="bulk-label" class="field !w-auto !py-1 !text-xs ml-1"><option value="">Label…</option></select>
            <button data-bulk="apply_label" class="btn-icon text-gray-600 dark:text-gray-300" title="Apply label"><span class="material-icons-outlined text-lg">label</span></button>
            <button data-bulk="remove_label" class="btn-icon text-gray-600 dark:text-gray-300" title="Remove label"><span class="material-icons-outlined text-lg">label_off</span></button>
          </div>
          <div id="mail-list" class="flex-1 overflow-y-auto">
            <div class="p-8 text-center muted">Loading...</div>
          </div>
        </section>
        <section id="mail-reader" class="mail-reader-pane flex-1 min-w-0 overflow-y-auto bg-gray-50 dark:bg-gray-900">
          ${readerEmpty()}
        </section>
      </div>
      ${hasPermission('mail:send') ? `<button id="mail-compose-fab" class="md:hidden fixed bottom-20 right-4 z-30 w-14 h-14 rounded-full bg-blue-600 text-white shadow-lg flex items-center justify-center" title="Compose">
        <span class="material-icons-outlined text-2xl">edit</span>
      </button>` : ''}
    </div>`;
}

function readerEmpty() {
  return `
    <div class="m-auto text-center max-w-xs p-8">
      <span class="material-icons-outlined text-6xl text-gray-300 dark:text-gray-700">mark_email_unread</span>
      <h2 class="text-base font-semibold mt-4">No message selected</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Choose a message from the list to read it here.</p>
    </div>`;
}

function renderAccounts(state, accounts) {
  state.accounts = accounts || [];
  const filter = document.getElementById('account-filter');
  if (!filter) return;
  if (state.accountId && !state.accounts.some((account) => account.id === state.accountId)) {
    state.accountId = 0;
    localStorage.removeItem('umail.mailAccount');
  }
  filter.innerHTML = '<option value="0">All accounts</option>' + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.email)}</option>`).join('');
  filter.value = String(state.accountId || 0);
}

function observeMore(state) {
  state.observer?.disconnect();
  const sentinel = document.getElementById('load-sentinel');
  if (!sentinel || !state.cursor) return;
  state.observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || state.loading || !state.cursor) return;
    state.observer.disconnect();
    state.loading = true;
    loadList(state, true, true).finally(() => { state.loading = false; });
  }, { root: document.getElementById('mail-list'), rootMargin: '240px' });
  state.observer.observe(sentinel);
}

async function loadList(state, append, silent = false) {
  if (state.pageVersion !== mailPageVersion) return;
  const list = document.getElementById('mail-list');
  if (!list) return;
  if (state.box === 'drafts') {
    await loadDrafts(state);
    return;
  }
  if (!append && !silent) list.innerHTML = '<div class="p-8 text-center muted">Loading...</div>';

  const params = new URLSearchParams({ box: state.box, limit: String(PAGE_SIZE) });
  if (state.label) params.set('label', state.label);
  if (state.accountId) params.set('accountId', String(state.accountId));
  if (append && state.cursor) params.set('cursor', state.cursor);

  let data;
  try {
    data = await api(`/api/mail?${params}`);
  } catch (error) {
    if (state.pageVersion !== mailPageVersion || !list.isConnected) return;
    list.innerHTML = `<div class="p-8 text-center"><p class="text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</p></div>`;
    return;
  }
  // A route change can finish after this response; ignore it so the new mailbox stays visible.
  if (state.pageVersion !== mailPageVersion || !list.isConnected) return;
  if (data.box !== state.box) return;

  renderAccounts(state, data.accounts || []);
  if (append) state.messages.push(...(data.results || []));
  else state.messages = data.results || [];
  const prevCursor = state.cursor;
  state.cursor = append && data.nextCursor && data.nextCursor === prevCursor ? null : data.nextCursor;

  document.getElementById('mail-count').textContent = `${data.total || 0} messages`;
  if (!state.accounts.length) {
    list.innerHTML = `
      <div class="p-8 text-center">
        <span class="material-icons-outlined text-5xl text-gray-300 dark:text-gray-700">alternate_email</span>
        <h2 class="text-base font-semibold mt-4">No Gmail account yet</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xs mx-auto">Connect an account to start syncing your unified inbox.</p>
        <button id="mail-add-account" class="btn-primary mt-5 mx-auto">
          <span class="material-icons-outlined text-base">add</span> Add Gmail account
        </button>
      </div>`;
    document.getElementById('mail-add-account')?.addEventListener('click', () => navigate('/accounts'));
    return;
  }
  if (!state.messages.length) {
    list.innerHTML = `
      <div class="p-8 text-center">
        <span class="material-icons-outlined text-5xl text-gray-300 dark:text-gray-700">${state.meta.icon}</span>
        <h2 class="text-base font-semibold mt-4">${escapeHtml(state.meta.title)} is empty</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">${state.accountId ? 'Try another mailbox or account filter.' : 'New mail will appear here after the next sync.'}</p>
      </div>`;
    paintBulk(state);
    return;
  }

  list.innerHTML = state.messages.map((message) => renderRow(message, state)).join('') + (state.cursor
    ? '<div id="load-sentinel" class="h-10 flex items-center justify-center"><span class="material-icons-outlined text-lg text-gray-300 dark:text-gray-600">more_horiz</span></div>'
    : '');
  bindRows(state);
  paintBulk(state);
  observeMore(state);
}

function labelNames(state, message) {
  return labelList(message.label_ids).map((id) => {
    const label = state.labels?.find((item) => item.accounts.some((acc) => acc.gmail_label_id === id));
    return label?.name || id;
  });
}

function renderRow(message, state) {
  const color = safeColor(message.card_color);
  const labels = labelNames(state, message);
  const key = `${message.account_id}|${message.gmail_message_id}`;
  const unread = Number(message.is_unread);
  const starred = Number(message.is_starred);
  const date = message.internal_date ? formatTimeAgo(new Date(Number(message.internal_date)).toISOString()) : '';
  return `
    <article class="mail-row ${unread ? 'unread' : ''} ${state.selected.has(key) ? 'selected' : ''}"
      data-account="${message.account_id}" data-message="${escapeHtml(message.gmail_message_id)}" data-thread="${escapeHtml(message.gmail_thread_id)}">
      <input type="checkbox" data-select class="rounded shrink-0" ${state.selected.has(key) ? 'checked' : ''} aria-label="Select message">
      <button data-star class="shrink-0 ${starred ? 'text-amber-400' : 'text-gray-300 dark:text-gray-600'}" title="${starred ? 'Unstar' : 'Star'}">
        <span class="material-icons-outlined text-lg">${starred ? 'star' : 'star_border'}</span>
      </button>
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${color}" title="${escapeHtml(message.account_email || message.account_name || '')}"></span>
      <span class="row-sender shrink-0 w-28 sm:w-36 truncate ${unread ? 'font-semibold' : 'text-gray-600 dark:text-gray-300'}">${escapeHtml(message.from_name || message.from_email || 'Unknown sender')}</span>
      <div class="row-main flex-1 min-w-0 flex items-baseline gap-1.5">
        <span class="truncate ${unread ? 'font-semibold' : ''}">${escapeHtml(message.subject || '(no subject)')}</span>
        <span class="mail-snippet flex-1 truncate hidden lg:block">— ${escapeHtml(message.snippet || '')}</span>
      </div>
      ${Number(message.has_attachment) ? '<span class="row-attach material-icons-outlined text-sm text-gray-400 shrink-0">attach_file</span>' : ''}
      <span class="row-date text-[11px] text-gray-400 shrink-0 w-14 text-right">${escapeHtml(date)}</span>
      <div class="row-actions items-center gap-0.5 shrink-0">
        <button data-row-action="archive" class="btn-icon text-gray-500 dark:text-gray-400" title="Archive"><span class="material-icons-outlined text-lg">archive</span></button>
        <button data-row-action="trash" class="btn-icon text-gray-500 dark:text-gray-400" title="Delete"><span class="material-icons-outlined text-lg">delete</span></button>
        <button data-row-action="${unread ? 'read' : 'unread'}" class="btn-icon text-gray-500 dark:text-gray-400" title="${unread ? 'Mark as read' : 'Mark as unread'}">
          <span class="material-icons-outlined text-lg">${unread ? 'mark_email_read' : 'mark_email_unread'}</span>
        </button>
      </div>
      ${labels.length ? `<a href="#/label/${encodeURIComponent(labels[0])}" data-label-link class="badge bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hidden xl:inline-flex shrink-0">${escapeHtml(labels[0])}</a>` : ''}
    </article>`;
}

function rowSelectionKey(row) {
  return `${row.dataset.account}|${row.dataset.message}`;
}

function setRowSelected(state, row, selected) {
  const key = rowSelectionKey(row);
  if (selected) {
    state.selected.set(key, {
      accountId: Number(row.dataset.account),
      messageId: row.dataset.message
    });
  } else {
    state.selected.delete(key);
  }
  row.classList.toggle('selected', selected);
  const checkbox = row.querySelector('[data-select]');
  if (checkbox) checkbox.checked = selected;
}

function toggleRowSelection(state, row) {
  setRowSelected(state, row, !state.selected.has(rowSelectionKey(row)));
  state.selectionAnchor = rowSelectionKey(row);
  paintBulk(state);
}

function selectRowRange(state, row) {
  const rows = [...document.querySelectorAll('#mail-list article[data-thread]')];
  const anchorIndex = rows.findIndex((item) => rowSelectionKey(item) === state.selectionAnchor);
  const targetIndex = rows.indexOf(row);
  if (anchorIndex === -1 || targetIndex === -1) {
    setRowSelected(state, row, true);
    state.selectionAnchor = rowSelectionKey(row);
  } else {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    for (let index = start; index <= end; index += 1) setRowSelected(state, rows[index], true);
  }
  paintBulk(state);
}

function bindRows(state) {
  const list = document.getElementById('mail-list');
  if (!list) return;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  list.querySelectorAll('article[data-thread]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (row.dataset.swiped === '1') {
        delete row.dataset.swiped;
        return;
      }
      if (event.target.closest('[data-star]') || event.target.closest('[data-select]') || event.target.closest('[data-label-link]')) return;
      if (event.shiftKey) {
        event.preventDefault();
        selectRowRange(state, row);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        toggleRowSelection(state, row);
        return;
      }
      openThread(state, Number(row.dataset.account), row.dataset.thread);
    });
    if (coarse) {
      let startX = 0;
      let startY = 0;
      let dx = 0;
      let tracking = false;
      row.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        dx = 0;
        tracking = true;
      }, { passive: true });
      const resetSwipe = () => {
        row.classList.remove('swiping', 'swipe-left', 'swipe-right');
        row.style.transform = '';
        row.style.removeProperty('--swipe');
      };
      row.addEventListener('touchmove', (event) => {
        if (!tracking) return;
        const touch = event.touches[0];
        dx = touch.clientX - startX;
        if (Math.abs(touch.clientY - startY) > Math.abs(dx)) {
          tracking = false;
          resetSwipe();
          return;
        }
        if (Math.abs(dx) > 10) {
          row.classList.add('swiping');
          const shift = Math.max(-90, Math.min(90, dx));
          row.style.transform = `translateX(${shift}px)`;
          row.style.setProperty('--swipe', `${Math.abs(shift)}px`);
          row.classList.toggle('swipe-left', dx < -40);
          row.classList.toggle('swipe-right', dx > 40);
        }
      }, { passive: true });
      row.addEventListener('touchcancel', resetSwipe);
      row.addEventListener('touchend', async () => {
        const swiped = tracking;
        tracking = false;
        resetSwipe();
        if (!swiped || Math.abs(dx) < 70) return;
        row.dataset.swiped = '1';
        const action = dx > 0 ? 'archive' : 'trash';
        try {
          await api('/api/mail/actions', {
            method: 'POST',
            body: { accountId: Number(row.dataset.account), messageIds: [row.dataset.message], action }
          });
          notifyCounts();
          showToast(action === 'archive' ? 'Archived.' : 'Moved to trash.', 'success');
          await reloadList(state);
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    }
    const checkbox = row.querySelector('[data-select]');
    checkbox?.addEventListener('click', (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      selectRowRange(state, row);
    });
    checkbox?.addEventListener('change', (event) => {
      setRowSelected(state, row, event.target.checked);
      state.selectionAnchor = rowSelectionKey(row);
      paintBulk(state);
    });
    row.querySelector('[data-star]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = row.querySelector('[data-star] span').textContent === 'star' ? 'unstar' : 'star';
      try {
        await api('/api/mail/actions', {
          method: 'POST',
          body: { accountId: Number(row.dataset.account), messageIds: [row.dataset.message], action }
        });
        await reloadList(state);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
    row.querySelectorAll('[data-row-action]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await api('/api/mail/actions', {
            method: 'POST',
            body: {
              accountId: Number(row.dataset.account),
              messageIds: [row.dataset.message],
              action: button.dataset.rowAction
            }
          });
          notifyCounts();
          await reloadList(state);
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    });
  });
}

async function loadLabelOptions(state) {
  try {
    const { results } = await api('/api/mail/labels');
    state.labels = results || [];
    const select = document.getElementById('bulk-label');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Label…</option>' + state.labels.map((label) =>
      `<option value="${escapeHtml(label.name)}">${escapeHtml(label.name)}</option>`).join('');
    select.value = current;
  } catch {}
}

function reloadList(state, silent = true) {
  return state.reload ? state.reload() : loadList(state, false, silent);
}

function bindSelectAll(state) {
  const box = document.getElementById('select-all');
  if (!box) return;
  box.onchange = () => {
    state.selected.clear();
    state.selectionAnchor = null;
    if (box.checked) {
      for (const message of state.messages) {
        state.selected.set(`${message.account_id}|${message.gmail_message_id}`, {
          accountId: message.account_id,
          messageId: message.gmail_message_id
        });
      }
    }
    document.querySelectorAll('article[data-thread]').forEach((row) => {
      row.classList.toggle('selected', box.checked);
      const checkbox = row.querySelector('[data-select]');
      if (checkbox) checkbox.checked = box.checked;
    });
    paintBulk(state);
  };
}

function paintBulk(state) {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  const count = state.selected.size;
  bar.classList.toggle('hidden', !count);
  bar.classList.toggle('flex', Boolean(count));
  document.getElementById('list-toolbar')?.classList.toggle('hidden', Boolean(count));
  const selectAll = document.getElementById('select-all');
  if (selectAll) selectAll.checked = count > 0 && count === state.messages.length;
  const label = document.getElementById('bulk-count');
  if (label) label.textContent = `${count} selected`;
  document.getElementById('bulk-clear')?.addEventListener('click', () => {
    state.selected.clear();
    state.selectionAnchor = null;
    reloadList(state);
  });
  bar.querySelectorAll('[data-bulk]').forEach((button) => {
    button.onclick = async () => {
      const action = button.dataset.bulk;
      const needsLabel = action === 'apply_label' || action === 'remove_label';
      const labelName = document.getElementById('bulk-label')?.value || '';
      if (needsLabel && !labelName) {
        showToast('Choose a label first.', 'error');
        return;
      }
      const groups = new Map();
      for (const item of state.selected.values()) {
        if (!groups.has(item.accountId)) groups.set(item.accountId, []);
        groups.get(item.accountId).push(item.messageId);
      }
      let done = 0;
      let failed = 0;
      for (const [accountId, messageIds] of groups) {
        let labelId = '';
        if (needsLabel) {
          const label = state.labels.find((item) => item.name === labelName);
          labelId = label?.accounts.find((entry) => entry.account_id === accountId)?.gmail_label_id || '';
          if (!labelId) {
            failed += messageIds.length;
            continue;
          }
        }
        try {
          await api('/api/mail/actions', { method: 'POST', body: { accountId, messageIds, action, labelId } });
          done += messageIds.length;
        } catch {
          failed += messageIds.length;
        }
      }
      state.selected.clear();
      state.selectionAnchor = null;
      showToast(failed ? `${done} updated, ${failed} failed.` : `${done} messages updated.`, failed ? 'error' : 'success');
      notifyCounts();
      await reloadList(state);
    };
  });
}

async function loadDrafts(state) {
  if (state.pageVersion !== mailPageVersion) return;
  const list = document.getElementById('mail-list');
  if (!list) return;
  list.innerHTML = '<div class="p-8 text-center muted">Loading...</div>';
  let data;
  let scheduled = [];
  try {
    data = await api('/api/mail/drafts');
    const outbox = await api('/api/mail/outbox').catch(() => ({ results: [] }));
    scheduled = outbox.results || [];
    const accounts = await api('/api/mail/accounts').catch(() => ({ results: [] }));
    renderAccounts(state, accounts.results || []);
  } catch (error) {
    if (state.pageVersion !== mailPageVersion || !list.isConnected) return;
    list.innerHTML = `<div class="p-8 text-center"><p class="text-sm text-red-600">${escapeHtml(error.message)}</p></div>`;
    return;
  }
  if (state.pageVersion !== mailPageVersion || !list.isConnected) return;
  let drafts = data.results || [];
  if (state.accountId) {
    drafts = drafts.filter((draft) => draft.account_id === state.accountId);
    scheduled = scheduled.filter((row) => row.account_id === state.accountId);
  }
  document.getElementById('mail-count').textContent = `${drafts.length} drafts${scheduled.length ? ` · ${scheduled.length} scheduled` : ''}`;
  if (!drafts.length && !scheduled.length) {
    list.innerHTML = `
      <div class="p-8 text-center">
        <span class="material-icons-outlined text-5xl text-gray-300 dark:text-gray-700">drafts</span>
        <h2 class="text-base font-semibold mt-4">No drafts</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Saved drafts appear here.</p>
      </div>`;
    return;
  }
  const scheduledHtml = scheduled.map((row) => {
    const when = new Date(`${row.next_attempt_at.replace(' ', 'T')}Z`).toLocaleString();
    return `
      <article class="mail-row" data-scheduled="${row.id}">
        <span class="material-icons-outlined text-amber-500 shrink-0">schedule_send</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-medium truncate flex-1">${escapeHtml(row.to || '(no recipient)')}</span>
            <span class="text-[11px] text-amber-600 dark:text-amber-400 shrink-0">${escapeHtml(when)}</span>
          </div>
          <div class="text-sm truncate mt-0.5">${escapeHtml(row.subject || '(no subject)')}</div>
        </div>
        <button data-scheduled-cancel="${row.id}" class="btn-icon text-gray-400 shrink-0" title="Cancel scheduled send">
          <span class="material-icons-outlined text-lg">close</span>
        </button>
      </article>`;
  }).join('');
  list.innerHTML = scheduledHtml + drafts.map((draft) => {
    const to = recipientList(draft.to_json).join(', ');
    return `
      <article class="mail-row" data-draft="${draft.id}">
        <span class="material-icons-outlined text-blue-600 mt-0.5">drafts</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-medium truncate flex-1">${escapeHtml(to || '(no recipient)')}</span>
            <span class="text-[11px] text-gray-400 shrink-0">${escapeHtml(formatTimeAgo(draft.updated_at))}</span>
          </div>
          <div class="text-sm truncate mt-0.5">${escapeHtml(draft.subject || '(no subject)')}</div>
          <div class="mail-snippet mt-0.5">${escapeHtml(String(draft.body || '').slice(0, 120))}</div>
        </div>
        <button data-discard="${draft.id}" class="btn-icon text-red-400 shrink-0" title="Discard draft">
          <span class="material-icons-outlined text-lg">delete</span>
        </button>
      </article>`;
  }).join('');

  list.querySelectorAll('[data-scheduled-cancel]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        const result = await api(`/api/mail/outbox/${button.dataset.scheduledCancel}/cancel`, { method: 'POST' });
        showToast('Scheduled send cancelled.', 'success');
        openComposer(result.payload);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  list.querySelectorAll('[data-draft]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-discard]')) return;
      const draft = drafts.find((item) => item.id === Number(row.dataset.draft));
      if (draft) openComposer({ draft });
    });
    row.querySelector('[data-discard]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm('Discard this draft?')) return;
      try {
        await api(`/api/mail/drafts/${row.dataset.discard}`, { method: 'DELETE' });
        showToast('Draft discarded.', 'success');
        await loadDrafts(state);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
}

async function openThread(state, accountId, threadId, silent = false) {
  if (state.pageVersion !== mailPageVersion) return;
  const reader = document.getElementById('mail-reader');
  if (!reader) return;
  if (!silent) reader.innerHTML = '<div class="m-auto p-8 muted">Loading thread...</div>';
  let data;
  try {
    data = await api(`/api/mail/threads/${accountId}/${encodeURIComponent(threadId)}`);
  } catch (error) {
    if (state.pageVersion !== mailPageVersion || !reader.isConnected) return;
    if (!silent) reader.innerHTML = `<div class="m-auto p-8 text-center text-sm text-red-500">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (state.pageVersion !== mailPageVersion || !reader.isConnected) return;
  state.thread = data.thread;
  document.getElementById('mail-layout')?.classList.add('reader-open');
  reader.innerHTML = renderThread(state, data);
  bindThread(state, data);
  if (data.mark_read_on_open) {
    const unread = data.thread.messages.filter((message) => Number(message.is_unread));
    if (unread.length) {
      try {
        await api('/api/mail/actions', {
          method: 'POST',
          body: {
            accountId,
            messageIds: unread.map((message) => message.gmail_message_id),
            action: 'read'
          }
        });
        await reloadList(state);
        notifyCounts();
      } catch {}
    }
  }
}

function renderThread(state, data) {
  const thread = data.thread;
  const account = data.account;
  const color = safeColor(account.card_color);
  const allowImages = !data.block_remote_images;
  const latest = thread.messages[thread.messages.length - 1];
  const starred = Number(latest.is_starred);
  const labels = labelNames(state, latest);
  return `
    <div class="w-full min-h-full flex flex-col bg-white dark:bg-gray-900">
      <div class="sticky top-0 z-20 flex items-center gap-1 px-2 sm:px-4 h-12 border-b border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 backdrop-blur">
        <button id="reader-back" class="btn-icon text-gray-600 dark:text-gray-300" title="Back">
          <span class="material-icons-outlined">arrow_back</span>
        </button>
        <span class="text-xs text-gray-500 dark:text-gray-400 truncate ml-1 hidden md:inline">${escapeHtml(account.email)}</span>
        <div class="flex items-center gap-0.5 sm:gap-1 ml-1 sm:ml-2">
          <button data-compose="reply" class="btn-icon text-gray-600 dark:text-gray-300" title="Reply"><span class="material-icons-outlined">reply</span></button>
          <button data-compose="replyAll" class="btn-icon text-gray-600 dark:text-gray-300" title="Reply all"><span class="material-icons-outlined">reply_all</span></button>
          <button data-compose="forward" class="btn-icon text-gray-600 dark:text-gray-300" title="Forward"><span class="material-icons-outlined">forward</span></button>
        </div>
        <div class="ml-auto flex items-center gap-1 shrink-0">
          <button data-reader-action="star" class="btn-icon ${starred ? 'text-amber-400' : 'text-gray-400'}" title="${starred ? 'Unstar' : 'Star'}">
            <span class="material-icons-outlined">${starred ? 'star' : 'star_border'}</span>
          </button>
          <button data-reader-action="archive" class="btn-icon text-gray-500" title="Archive"><span class="material-icons-outlined">archive</span></button>
          <button data-reader-action="trash" class="btn-icon text-red-500" title="Trash"><span class="material-icons-outlined">delete</span></button>
          <button data-reader-action="unread" class="btn-icon text-gray-500 hidden sm:inline-flex" title="Mark unread"><span class="material-icons-outlined">mark_email_unread</span></button>
          <button data-ai-summary class="btn-icon text-blue-600 dark:text-blue-400" title="Summarize with AI"><span class="material-icons-outlined">auto_awesome</span></button>
          <a href="https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.email)}#all/${encodeURIComponent(thread.gmail_thread_id)}" target="_blank" rel="noopener noreferrer" class="btn-icon text-gray-500 hidden sm:inline-flex" title="Open in Gmail"><span class="material-icons-outlined">open_in_new</span></a>
        </div>
      </div>
      <div class="px-4 md:px-6 pt-4 pb-3">
        <h2 class="text-lg md:text-xl font-bold break-words">${escapeHtml(thread.subject || '(no subject)')}</h2>
        <div class="flex flex-wrap items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:${color}"></span>${escapeHtml(account.display_name || account.email)}</span>
          ${labels.slice(0, 3).map((label) => `<span class="badge bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">${escapeHtml(label.replace(/_/g, ' ').toLowerCase())}</span>`).join('')}
        </div>
      </div>
      <div id="ai-summary-slot"></div>
      <div class="flex-1 border-t border-gray-200 dark:border-gray-700">
        ${thread.messages.map((message, index) => renderMessage(message, index === thread.messages.length - 1, account, allowImages, state)).join('')}
      </div>
    </div>`;
}

function renderMessage(message, open, account, allowImages, state) {
  const labels = labelNames(state, message);
  const sender = message.from_name || message.from_email || 'Unknown sender';
  const initial = sender.slice(0, 1).toUpperCase();
  return `
    <article class="border-b border-gray-200 dark:border-gray-700 last:border-0 bg-white dark:bg-gray-900" data-message-card="${escapeHtml(message.gmail_message_id)}">
      <div class="px-4 md:px-6 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60" data-toggle-message>
        <span class="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 flex items-center justify-center text-sm font-semibold shrink-0">${escapeHtml(initial)}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-semibold truncate">${escapeHtml(sender)}</span>
            <span class="text-[11px] text-gray-500 dark:text-gray-400 truncate hidden sm:inline">&lt;${escapeHtml(message.from_email || '')}&gt;</span>
            <span class="text-[11px] text-gray-400 shrink-0 ml-auto">${escapeHtml(message.internal_date ? formatDateTime(new Date(Number(message.internal_date)).toISOString()) : '')}</span>
            <span data-chevron class="material-icons-outlined text-base text-gray-400 shrink-0">${open ? 'expand_less' : 'expand_more'}</span>
          </div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
            to ${escapeHtml(recipientList(message.to_json).join(', ') || account.email)}
            ${labels.length ? ` · ${labels.slice(0, 2).map((label) => escapeHtml(label)).join(', ')}` : ''}
          </div>
        </div>
      </div>
      ${open ? '' : `<div class="px-4 pb-3 -mt-1 text-xs text-gray-500 dark:text-gray-400 truncate" data-message-preview>${escapeHtml(message.snippet || '')}</div>`}
      <div class="${open ? '' : 'hidden'} border-t border-gray-100 dark:border-gray-700" data-message-body>
        ${message.body_html || message.body_text
          ? `<iframe data-mid="${escapeHtml(message.gmail_message_id)}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" class="w-full border-0" style="height:420px" title="Message body"></iframe>`
          : '<p class="px-4 py-3 text-sm text-gray-500">No body available.</p>'}
        ${message.attachments?.length ? `<div class="px-4 py-2 border-t border-gray-100 dark:border-gray-700 flex flex-wrap gap-2">
          ${message.attachments.map((attachment) => `<a href="${attachment.url}" class="badge bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 gap-1 hover:bg-gray-200">
            <span class="material-icons-outlined text-xs">attach_file</span>${escapeHtml(attachment.filename)}
            <span class="text-gray-400">${Math.max(1, Math.round((attachment.size || 0) / 1024))} KB</span>
          </a>`).join('')}
        </div>` : ''}
        ${message.body_html && !allowImages ? `<div class="px-4 pb-3"><label class="inline-flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 cursor-pointer"><input type="checkbox" data-show-images class="accent-blue-600"> Show remote images</label></div>` : ''}
      </div>
    </article>`;
}

function bindThread(state, data) {
  const reader = document.getElementById('mail-reader');
  if (!reader) return;
  const thread = data.thread;
  const latest = thread.messages[thread.messages.length - 1];
  const account = data.account;

  reader.querySelector('#reader-back')?.addEventListener('click', () => {
    document.getElementById('mail-layout')?.classList.remove('reader-open');
  });

  const aiSlot = reader.querySelector('#ai-summary-slot');
  const aiButton = reader.querySelector('[data-ai-summary]');
  aiButton?.addEventListener('click', async () => {
    if (localStorage.getItem('umail.aiNotice') !== '1') {
      if (!confirm('Send this thread to the configured AI provider for summarization?')) return;
      localStorage.setItem('umail.aiNotice', '1');
    }
    aiButton.disabled = true;
    aiSlot.innerHTML = '<div class="mx-4 mb-3 text-xs text-gray-500 dark:text-gray-400">Summarizing...</div>';
    try {
      const result = await api(
        `/api/mail/threads/${thread.account_id}/${encodeURIComponent(thread.gmail_thread_id)}/summary`,
        { method: 'POST' }
      );
      aiSlot.innerHTML = `
        <div class="mx-4 mb-3 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-900/20 p-3 text-sm">
          <div class="flex items-center gap-2 mb-1">
            <span class="material-icons-outlined text-base text-blue-600 dark:text-blue-400">auto_awesome</span>
            <span class="font-semibold">AI summary</span>
            <button data-ai-close class="btn-icon !p-1 ml-auto text-gray-400" title="Close summary"><span class="material-icons-outlined text-base">close</span></button>
          </div>
          <div class="text-gray-700 dark:text-gray-200 space-y-1">${renderAiMarkdown(result.summary)}</div>
        </div>`;
      aiSlot.querySelector('[data-ai-close]')?.addEventListener('click', () => { aiSlot.innerHTML = ''; });
    } catch (error) {
      aiSlot.innerHTML = '';
      showToast(error.message, 'error');
    } finally {
      aiButton.disabled = false;
    }
  });

  reader.querySelectorAll('iframe[data-mid]').forEach((frame) => {
    const message = thread.messages.find((item) => item.gmail_message_id === frame.dataset.mid);
    if (!message) return;
    const allowImages = !data.block_remote_images;
    const html = message.body_html || textHtml(message.body_text);
    const autoSize = () => {
      try {
        const doc = frame.contentDocument;
        if (doc) frame.style.height = `${Math.max(120, doc.documentElement.scrollHeight)}px`;
      } catch {}
    };
    frame.onload = autoSize;
    frame.srcdoc = iframeDoc(allowImages ? proxyRemoteImages(html) : html);
    const card = frame.closest('[data-message-card]');
    card?.querySelector('[data-show-images]')?.addEventListener('change', (event) => {
      frame.srcdoc = iframeDoc(event.currentTarget.checked ? proxyRemoteImages(html) : html);
    });
  });

  reader.querySelectorAll('[data-toggle-message]').forEach((header) => {
    header.addEventListener('click', () => {
      const card = header.closest('[data-message-card]');
      const body = card?.querySelector('[data-message-body]');
      const preview = card?.querySelector('[data-message-preview]');
      const chevron = header.querySelector('[data-chevron]');
      if (!body) return;
      const open = body.classList.contains('hidden');
      body.classList.toggle('hidden', !open);
      preview?.classList.toggle('hidden', open);
      if (chevron) chevron.textContent = open ? 'expand_less' : 'expand_more';
    });
  });

  const act = async (action, messageIds) => {
    try {
      await api('/api/mail/actions', {
        method: 'POST',
        body: { accountId: thread.account_id, messageIds, action }
      });
      if (['archive', 'trash', 'read', 'unread'].includes(action) && action !== 'read') {
        state.thread = null;
        document.getElementById('mail-layout')?.classList.remove('reader-open');
        reader.innerHTML = readerEmpty();
      } else if (state.thread) {
        await openThread(state, thread.account_id, thread.gmail_thread_id, true);
      }
      await reloadList(state);
      notifyCounts();
      showToast('Message updated.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  reader.querySelectorAll('[data-reader-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.readerAction;
      const ids = thread.messages.map((message) => message.gmail_message_id);
      if (action === 'star') act(Number(latest.is_starred) ? 'unstar' : 'star', [latest.gmail_message_id]);
      else if (action === 'archive') act('archive', ids);
      else if (action === 'trash') act('trash', ids);
      else if (action === 'unread') act('unread', [latest.gmail_message_id]);
    });
  });

  const self = String(account.email || '').toLowerCase();
  const composeData = (message) => {
    const to = recipientList(message.to_json).filter((email) => email.toLowerCase() !== self);
    const cc = recipientList(message.cc_json).filter((email) => email.toLowerCase() !== self);
    const inReplyTo = message.headers?.messageId || '';
    const references = [message.headers?.references, inReplyTo].filter(Boolean).join(' ');
    return {
      accountId: thread.account_id,
      threadId: thread.gmail_thread_id,
      inReplyTo,
      references,
      to,
      cc
    };
  };

  reader.querySelectorAll('[data-compose]').forEach((button) => {
    button.addEventListener('click', () => {
      const message = thread.messages.find((item) => item.gmail_message_id === button.dataset.composeMid) || latest;
      const target = composeData(message);
      const mode = button.dataset.compose === 'reply' && data.default_reply_all ? 'replyAll' : button.dataset.compose;
      if (mode === 'forward') {
        openComposer({
          ...target,
          mode,
          subject: subjectWith('Fwd', message.subject),
          body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from_name || ''} <${message.from_email || ''}>\nDate: ${message.internal_date ? new Date(Number(message.internal_date)).toUTCString() : ''}\nSubject: ${message.subject || ''}\n\n${message.body_text || message.snippet || ''}`
        });
        return;
      }
      const all = mode === 'replyAll';
      openComposer({
        ...target,
        mode,
        to: [message.from_email, ...(all ? target.to : [])].filter(Boolean),
        cc: all ? target.cc : [],
        subject: subjectWith('Re', message.subject)
      });
    });
  });
}

export async function renderSearchPage() {
  const main = document.getElementById('main-content');
  const q = getQueryParams().get('q') || '';
  const meta = {
    title: 'Search',
    subtitle: q ? `Results for “${q}”` : 'Search all accounts',
    icon: 'search'
  };
  const savedFilter = Number(localStorage.getItem('umail.mailAccount')) || 0;
  const pageVersion = beginMailRender();
  const state = {
    pageVersion,
    box: 'inbox',
    label: '',
    meta,
    q,
    accountId: savedFilter,
    cursor: null,
    messages: [],
    accounts: [],
    labels: [],
    thread: null,
    selected: new Map(),
    selectionAnchor: null,
    loading: false,
    observer: null,
    timer: null
  };
  state.reload = () => runSearch(state);

  main.innerHTML = shell(meta, 'inbox', state);
  bindSelectAll(state);
  const accounts = await api('/api/mail/accounts').catch(() => ({ results: [] }));
  renderAccounts(state, accounts.results || []);

  document.getElementById('mail-refresh')?.addEventListener('click', () => runSearch(state));
  document.getElementById('account-filter')?.addEventListener('change', (event) => {
    state.accountId = Number(event.target.value) || 0;
    localStorage.setItem('umail.mailAccount', String(state.accountId));
    runSearch(state);
  });
  if (hasPermission('mail:send')) {
    document.getElementById('mail-compose-fab')?.addEventListener('click', () => openComposer({}));
  }

  await loadLabelOptions(state);
  await runSearch(state);
}

async function runSearch(state) {
  if (state.pageVersion !== mailPageVersion) return;
  const list = document.getElementById('mail-list');
  if (!list) return;
  const q = String(state.q || '').trim();
  if (!q) {
    list.innerHTML = `
      <div class="p-8 text-center">
        <span class="material-icons-outlined text-5xl text-gray-300 dark:text-gray-700">search</span>
        <h2 class="text-base font-semibold mt-4">Search your mail</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Type a query in the top bar, e.g. <code>from:ada has:attachment</code>.</p>
      </div>`;
    return;
  }

  list.innerHTML = '<div class="p-8 text-center muted">Searching Gmail...</div>';
  const params = new URLSearchParams({ q, limit: '50' });
  if (state.accountId) params.set('accountId', String(state.accountId));

  let data;
  try {
    data = await api(`/api/mail/search?${params}`);
  } catch (error) {
    if (state.pageVersion !== mailPageVersion || !list.isConnected) return;
    list.innerHTML = `<div class="p-8 text-center"><p class="text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</p></div>`;
    return;
  }
  if (state.pageVersion !== mailPageVersion || !list.isConnected) return;

  state.messages = data.results || [];
  document.getElementById('mail-count').textContent = `${data.total || 0} results`;
  const status = (data.accounts || [])
    .map((account) => `${account.email}: ${account.count}${account.error ? ' (cached)' : ''}`)
    .join(' · ');

  if (!state.messages.length) {
    list.innerHTML = `
      <div class="p-8 text-center">
        <span class="material-icons-outlined text-5xl text-gray-300 dark:text-gray-700">search_off</span>
        <h2 class="text-base font-semibold mt-4">No results</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Nothing matched “${escapeHtml(q)}”.</p>
      </div>
      ${status ? `<div class="px-4 pb-4 text-center text-[11px] text-gray-400">${escapeHtml(status)}</div>` : ''}`;
    paintBulk(state);
    return;
  }

  list.innerHTML = (status
    ? `<div class="px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-[11px] text-gray-500 dark:text-gray-400">${escapeHtml(status)}</div>`
    : '') + state.messages.map((message) => renderRow(message, state)).join('');
  bindRows(state);
  paintBulk(state);
}