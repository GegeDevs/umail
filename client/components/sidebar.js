import { api } from '../api.js';
import { getCurrentUser, hasPermission, hasPageAccess } from '../auth-state.js';
import { getCurrentPath, getQueryParams } from '../router.js';
import { showToast } from './toast.js';
import { openComposer } from './composer.js';
import { safeColor, escapeHtml } from '../lib/html.js';

const MAILBOXES = [
  { box: 'inbox', label: 'Inbox', icon: 'inbox' },
  { box: 'starred', label: 'Starred', icon: 'star' },
  { box: 'important', label: 'Important', icon: 'label_important' },
  { box: 'sent', label: 'Sent', icon: 'send' },
  { box: 'drafts', label: 'Drafts', icon: 'drafts' },
  { box: 'archive', label: 'Archive', icon: 'archive' },
  { box: 'spam', label: 'Spam', icon: 'report' },
  { box: 'trash', label: 'Trash', icon: 'delete' }
];

function navLink({ href, icon, label, active = false, extra = '' }) {
  return `
    <a href="${href}" class="sidebar-link flex items-center gap-3 px-3 py-2 rounded-full text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${active ? 'active' : ''}" data-href="${href}" title="${label}">
      <span class="material-icons-outlined text-xl">${icon}</span>
      <span class="flex-1 truncate sidebar-text">${label}</span>
      ${extra}
    </a>`;
}

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const user = getCurrentUser();
  if (!sidebar || !user) return;

  const canMail = hasPageAccess('mail');
  const canSend = hasPermission('mail:send');
  const mailItems = canMail ? MAILBOXES.map((item) => navLink({
    href: `#/?box=${item.box}`,
    icon: item.icon,
    label: item.label,
    extra: item.box === 'inbox'
      ? '<span id="nav-inbox-unread" class="badge bg-blue-600 text-white hidden">0</span>'
      : ''
  })).join('') : '';

  const adminItems = [
    hasPermission('admin:view_users') ? navLink({ href: '#/users', icon: 'group', label: 'Users' }) : '',
    hasPermission('admin:view_activity') ? navLink({ href: '#/activity', icon: 'history', label: 'Activity' }) : '',
    hasPermission('admin:view_logs') ? navLink({ href: '#/logs', icon: 'article', label: 'System logs' }) : '',
    hasPermission('admin:manage_api') ? navLink({ href: '#/api-access', icon: 'key', label: 'API access' }) : '',
    hasPermission('admin:view_api_docs') ? navLink({ href: '#/api-docs', icon: 'menu_book', label: 'API docs' }) : ''
  ].join('');

  sidebar.innerHTML = `
    <div class="px-3 pt-3">
      <button id="compose-btn" class="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-full bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors shadow-sm ${canSend ? '' : 'opacity-90'}">
        <span class="material-icons-outlined text-xl">edit</span> <span class="sidebar-text">Compose</span>
      </button>
    </div>

    <nav class="flex-1 overflow-y-auto px-2 py-3 space-y-1">
      ${mailItems}
      <div class="sidebar-section pt-4 pb-1 pl-3 pr-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        <span>Labels</span>
        <button id="label-add" class="btn-icon !p-1 text-gray-400 hover:text-blue-600" title="Create label">
          <span class="material-icons-outlined text-base">add</span>
        </button>
      </div>
      <div id="sidebar-labels" class="space-y-0.5">
        <div class="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Loading labels...</div>
      </div>
      <div class="pt-3 border-t border-gray-100 dark:border-gray-800 mt-2">
        ${hasPageAccess('accounts') ? navLink({ href: '#/accounts', icon: 'alternate_email', label: 'Accounts' }) : ''}
        ${hasPageAccess('settings') ? navLink({ href: '#/settings', icon: 'settings', label: 'Settings' }) : ''}
        ${adminItems}
      </div>
    </nav>

    <div class="sidebar-sync-block p-3 border-t border-gray-200 dark:border-gray-700">
      <div class="sidebar-sync flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300">
        <button id="sidebar-sync-toggle" type="button" class="flex flex-1 min-w-0 items-center gap-2 text-left" aria-expanded="true" title="Toggle mailbox sync">
          <span class="material-icons-outlined text-base text-blue-600">cloud_sync</span>
          <span class="flex-1 truncate">Mailbox sync</span>
          <span id="sidebar-sync-chevron" class="material-icons-outlined text-base text-gray-400">expand_less</span>
        </button>
        <a href="#/accounts" class="btn-icon !p-1 text-gray-400 hover:text-blue-600" title="Open accounts">
          <span class="material-icons-outlined text-base">open_in_new</span>
        </a>
      </div>
      <div id="sidebar-sync-body" class="mt-2">
        <div class="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div id="sidebar-sync-fill" class="h-full w-0 bg-blue-600"></div>
        </div>
        <div id="sidebar-sync-summary" class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Loading accounts...</div>
        <div id="sidebar-accounts-unread" class="mt-2 space-y-1"></div>
      </div>
    </div>
      <div class="sidebar-user m-3 flex items-center gap-2">
        <div class="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold">
          ${user.username.slice(0, 1).toUpperCase()}
        </div>
        <div class="sidebar-user-meta min-w-0 flex-1">
          <div class="text-sm font-medium truncate">${user.username}</div>
          <div class="text-[11px] text-gray-500 dark:text-gray-400 capitalize">${user.role}</div>
        </div>
        <button id="sidebar-logout" class="btn-icon text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Sign out">
          <span class="material-icons-outlined text-lg">logout</span>
        </button>
      </div>
  `;

  const compose = sidebar.querySelector('#compose-btn');
  compose?.addEventListener('click', () => {
    if (!canSend) return showToast('You do not have mail:send permission.', 'error');
    openComposer({});
  });
  sidebar.querySelector('#label-add')?.addEventListener('click', createNewLabelItem);
  sidebar.querySelector('#sidebar-labels')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-label-action]');
    if (!button) return;
    const label = currentLabels.find((item) => item.name === button.dataset.labelName);
    if (!label) return;
    if (button.dataset.labelAction === 'rename') renameLabelItem(label);
    else removeLabelItem(label);
  });
  sidebar.querySelector('#sidebar-logout')?.addEventListener('click', async () => {
    const { showLogoutModal } = await import('./logout-modal.js');
    showLogoutModal();
  });
  const syncToggle = sidebar.querySelector('#sidebar-sync-toggle');
  const syncBody = sidebar.querySelector('#sidebar-sync-body');
  const syncChevron = sidebar.querySelector('#sidebar-sync-chevron');
  const applySyncCollapsed = (collapsed) => {
    syncBody?.classList.toggle('hidden', collapsed);
    if (syncChevron) syncChevron.textContent = collapsed ? 'expand_more' : 'expand_less';
    syncToggle?.setAttribute('aria-expanded', String(!collapsed));
  };
  applySyncCollapsed(localStorage.getItem('umail.syncCollapsed') === '1');
  syncToggle?.addEventListener('click', () => {
    const collapsed = !syncBody?.classList.contains('hidden');
    localStorage.setItem('umail.syncCollapsed', collapsed ? '1' : '0');
    applySyncCollapsed(collapsed);
  });
  sidebar.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      sidebar.classList.remove('sidebar-open');
      // Clicking the active mailbox does not change the hash, so force a reload instead.
      if (window.location.hash === link.getAttribute('href')) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    });
  });

  renderMobileNav();
  updateActiveNav();
  updateSyncSummary();
  updateLabels();
  window.addEventListener('umail:counts-changed', () => {
    updateSyncSummary();
    updateLabels();
  });
}

let currentLabels = [];

function notifyLabelsChanged() {
  window.dispatchEvent(new CustomEvent('umail:counts-changed'));
}

async function createNewLabelItem() {
  const name = prompt('New label name:');
  if (!name || !name.trim()) return;
  try {
    await api('/api/mail/labels', { method: 'POST', body: { name: name.trim() } });
    showToast('Label created.', 'success');
    notifyLabelsChanged();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function renameLabelItem(label) {
  const name = prompt('Rename label:', label.name);
  if (!name || !name.trim() || name.trim() === label.name) return;
  try {
    await api('/api/mail/labels', {
      method: 'PATCH',
      body: { name: name.trim(), accounts: label.accounts }
    });
    showToast('Label renamed.', 'success');
    notifyLabelsChanged();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function removeLabelItem(label) {
  if (!confirm(`Delete label "${label.name}"? Messages keep their content; only the label is removed.`)) return;
  try {
    await api('/api/mail/labels', { method: 'DELETE', body: { accounts: label.accounts } });
    showToast('Label deleted.', 'success');
    notifyLabelsChanged();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function updateLabels() {
  const container = document.getElementById('sidebar-labels');
  if (!container || !hasPageAccess('mail')) return;
  try {
    const { results } = await api('/api/mail/labels');
    const labels = (results || []).slice(0, 12);
    currentLabels = labels;
    if (!labels.length) {
      container.innerHTML = '<div class="sidebar-label-empty px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No custom labels yet.</div>';
      return;
    }
    container.innerHTML = labels.map((label) => `
      <div class="group flex items-center">
        <a href="#/label/${encodeURIComponent(label.name)}" data-href="#/label/${encodeURIComponent(label.name)}" title="${escapeHtml(label.name)}"
           class="sidebar-link flex flex-1 min-w-0 items-center gap-3 px-3 py-1.5 rounded-full text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <span class="material-icons-outlined text-lg">label</span>
          <span class="flex-1 truncate sidebar-text">${escapeHtml(label.name)}</span>
          ${Number(label.unread) ? `<span class="badge bg-blue-600 text-white">${Number(label.unread)}</span>` : ''}
        </a>
        <div class="label-actions hidden group-hover:flex items-center shrink-0 pr-1">
          <button data-label-action="rename" data-label-name="${escapeHtml(label.name)}" class="btn-icon !p-1 text-gray-400 hover:text-blue-600" title="Rename label">
            <span class="material-icons-outlined text-sm">edit</span>
          </button>
          <button data-label-action="delete" data-label-name="${escapeHtml(label.name)}" class="btn-icon !p-1 text-gray-400 hover:text-red-600" title="Delete label">
            <span class="material-icons-outlined text-sm">delete</span>
          </button>
        </div>
      </div>`).join('');
    updateActiveNav();
  } catch {
    container.innerHTML = '<div class="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Labels unavailable.</div>';
  }
}

async function updateSyncSummary() {
  const summary = document.getElementById('sidebar-sync-summary');
  const fill = document.getElementById('sidebar-sync-fill');
  const unreadList = document.getElementById('sidebar-accounts-unread');
  if (!summary) return;
  try {
    const path = hasPageAccess('mail') ? '/api/mail/accounts' : '/api/accounts';
    const { results } = await api(path);
    const accounts = results || [];
    const healthy = accounts.filter((account) => account.status === 'healthy').length;
    summary.textContent = accounts.length
      ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${healthy} healthy`
      : 'No accounts connected';
    if (fill) fill.style.width = `${accounts.length ? Math.round((healthy / accounts.length) * 100) : 0}%`;

    const totalUnread = accounts.reduce((sum, account) => sum + Number(account.unread || 0), 0);
    const badge = document.getElementById('nav-inbox-unread');
    if (badge) {
      badge.textContent = String(totalUnread);
      badge.classList.toggle('hidden', !totalUnread);
    }
    if (unreadList) {
      unreadList.innerHTML = accounts.map((account) => `
        <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${safeColor(account.card_color)}"></span>
          <span class="truncate flex-1">${escapeHtml(account.email)}</span>
          ${Number(account.unread) ? `<span class="font-semibold text-blue-600 dark:text-blue-400">${Number(account.unread)}</span>` : ''}
        </div>`).join('');
    }
  } catch {
    summary.textContent = 'Accounts unavailable';
  }
}

function renderMobileNav() {
  const nav = document.getElementById('mobile-nav');
  if (!nav) return;
  const items = [
    hasPageAccess('mail') ? { href: '#/?box=inbox', icon: 'inbox', label: 'Mail' } : null,
    hasPageAccess('accounts') ? { href: '#/accounts', icon: 'alternate_email', label: 'Accounts' } : null,
    hasPageAccess('settings') ? { href: '#/settings', icon: 'settings', label: 'Settings' } : null,
    hasPermission('admin:view_users') ? { href: '#/users', icon: 'group', label: 'Users' } : null,
    hasPermission('admin:view_activity') ? { href: '#/activity', icon: 'history', label: 'Activity' } : null
  ].filter(Boolean);
  nav.innerHTML = items.map((item) => `
    <a href="${item.href}" class="mobile-nav-link flex flex-col items-center justify-center gap-0.5 py-1 px-3 rounded-lg text-gray-500 dark:text-gray-400" data-href="${item.href}">
      <span class="material-icons-outlined text-xl">${item.icon}</span>
      <span class="text-[10px] font-medium">${item.label}</span>
    </a>`).join('');
  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.location.hash === link.getAttribute('href')) {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    });
  });
}

export function updateActiveNav() {
  const path = getCurrentPath();
  const query = getQueryParams();
  const box = query.get('box') || 'inbox';
  document.querySelectorAll('.sidebar-link, .mobile-nav-link').forEach((link) => {
    const href = link.getAttribute('data-href') || '';
    let active = false;
    if (path === '/' || path === '') active = href.includes(`box=${box}`);
    else active = href === `#${path}`;
    link.classList.toggle('active', active);
  });
}
