import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { hasPermission } from '../auth-state.js';
import { getQueryParams } from '../router.js';
import { escapeHtml, safeColor } from '../lib/html.js';
import { formatDateTime } from '../time-utils.js';

let syncPollTimer = null;

const OAUTH_ERRORS = {
  not_configured: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart.',
  permission: 'You do not have permission to add accounts.',
  denied: 'Google access was denied or the token expired. Try connecting again.',
  state: 'The OAuth request expired or was already used. Try again.',
  google_error: 'Google returned an error during consent.',
  exchange_failed: 'Could not exchange the Google authorization code.',
  gmail_failed: 'Could not read the Gmail profile. Make sure Gmail API is enabled for this OAuth project.',
  no_refresh_token: 'Google did not return a refresh token. Remove the app from your Google account and reconnect.',
  store_failed: 'Google connected, but the account could not be saved.'
};

export async function renderAccountsPage() {
  clearTimeout(syncPollTimer);
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-7xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 class="text-xl md:text-2xl font-bold">Accounts <span id="accounts-count" class="text-gray-400 font-medium"></span></h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Gmail accounts connected to this UMail instance.</p>
        </div>
        <div class="flex items-center gap-2">
          <button id="accounts-refresh" class="btn-secondary">
            <span class="material-icons-outlined text-base">refresh</span> Reload
          </button>
          ${hasPermission('accounts:add') ? `<button id="accounts-add" class="btn-primary">
            <span class="material-icons-outlined text-base">person_add</span> Add Account
          </button>` : ''}
        </div>
      </div>

      <div id="oauth-banner" class="hidden mb-5 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 px-4 py-3"></div>

      <div id="accounts-grid" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div class="p-8 text-center muted col-span-full">Loading...</div>
      </div>
    </div>
  `;

  let oauthStatus = { configured: true, redirect_uri: '' };
  try {
    oauthStatus = await api('/api/accounts/oauth-status');
  } catch {}

  const startOAuth = (email = '') => {
    if (!oauthStatus.configured) {
      showToast(OAUTH_ERRORS.not_configured, 'error');
      return;
    }
    window.location.href = email ? `/auth/google?email=${encodeURIComponent(email)}` : '/auth/google';
  };

  document.getElementById('accounts-add')?.addEventListener('click', () => startOAuth());
  document.getElementById('accounts-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const icon = button.querySelector('span');
    button.disabled = true;
    icon?.classList.add('animate-spin');
    try {
      const { results } = await api('/api/accounts');
      const accounts = results || [];
      await Promise.all(accounts
        .filter((account) => account.status !== 'reauth_required' && hasPermission('accounts:refresh'))
        .map((account) => api(`/api/accounts/${account.id}/refresh`, { method: 'POST' }).catch(() => {})));
      await loadAccounts(oauthStatus, startOAuth);
      showToast('Accounts refreshed.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      icon?.classList.remove('animate-spin');
    }
  });

  renderOAuthBanner(oauthStatus);
  showCallbackResult();
  await loadAccounts(oauthStatus, startOAuth);
}

function renderOAuthBanner(status) {
  const banner = document.getElementById('oauth-banner');
  if (!banner || status.configured) return;
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="flex items-start gap-2">
      <span class="material-icons-outlined text-amber-600 dark:text-amber-400 text-lg">warning</span>
      <div class="text-sm text-amber-900 dark:text-amber-200 min-w-0">
        <p class="font-medium">Google OAuth is not configured</p>
        <p class="mt-1">Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code>, then restart UMail.</p>
        <p class="mt-2">Authorized redirect URI:</p>
        <div class="mt-1 flex items-center gap-2">
          <code class="text-xs bg-white/70 dark:bg-black/30 rounded px-2 py-1 break-all">${escapeHtml(status.redirect_uri)}</code>
          <button id="copy-redirect" class="btn-icon shrink-0" title="Copy redirect URI">
            <span class="material-icons-outlined text-base">content_copy</span>
          </button>
        </div>
      </div>
    </div>`;
  banner.querySelector('#copy-redirect')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(status.redirect_uri);
      showToast('Redirect URI copied.', 'success');
    } catch {
      showToast('Copy failed. Select the URI manually.', 'error');
    }
  });
}

function showCallbackResult() {
  const params = getQueryParams();
  const connected = params.get('connected');
  const error = params.get('oauth_error');
  if (!connected && !error) return;

  if (connected) showToast('Gmail account connected.', 'success');
  if (error) showToast(OAUTH_ERRORS[error] || `OAuth failed: ${error}`, 'error');

  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/accounts`);
}

async function loadAccounts(oauthStatus, startOAuth) {
  const grid = document.getElementById('accounts-grid');
  const count = document.getElementById('accounts-count');
  if (!grid) return;
  clearTimeout(syncPollTimer);

  let data;
  try {
    data = await api('/api/accounts');
  } catch (error) {
    grid.innerHTML = `<div class="col-span-full card p-6 text-center"><p class="text-red-600 dark:text-red-400 text-sm">${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const accounts = data.results || [];
  count.textContent = `(${accounts.length})`;
  if (!accounts.length) {
    grid.innerHTML = `
      <div class="col-span-full card p-10 text-center">
        <span class="material-icons-outlined text-6xl text-gray-300 dark:text-gray-700">alternate_email</span>
        <h2 class="text-lg font-semibold mt-4">No Gmail accounts connected</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto">Connect a Google account to sync its mail into the unified inbox. Each account keeps its own identity and labels.</p>
        ${hasPermission('accounts:add') ? `<button id="accounts-empty-add" class="btn-primary mt-5 mx-auto">
          <span class="material-icons-outlined text-base">add</span> Add Gmail account
        </button>` : ''}
      </div>`;
    document.getElementById('accounts-empty-add')?.addEventListener('click', () => startOAuth());
    return;
  }

  grid.innerHTML = accounts.map((account) => renderCard(account)).join('');
  bindCardActions(grid, startOAuth);
  if (accounts.some((account) => account.syncing)) {
    syncPollTimer = setTimeout(() => loadAccounts(oauthStatus, startOAuth), 3000);
  }
}

function renderCard(account) {
  const color = safeColor(account.card_color);
  const initial = (account.display_name || account.email || '?').slice(0, 1).toUpperCase();
  const status = {
    healthy: { label: 'Healthy', dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400' },
    reauth_required: { label: 'Reconnect required', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
    error: { label: 'Error', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' }
  }[account.status] || { label: account.status, dot: 'bg-gray-400', text: 'text-gray-500' };

  const avatar = account.avatar_url
    ? `<img src="${escapeHtml(account.avatar_url)}" alt="" class="w-full h-full rounded-full object-cover" referrerpolicy="no-referrer">`
    : escapeHtml(initial);

  return `
    <div class="rounded-xl bg-white dark:bg-gray-800 p-4 flex flex-col hover:shadow-md transition-shadow" data-id="${account.id}"
      style="border:2px solid ${color};border-top:4px solid ${color}">
      <div class="flex items-start gap-3">
        <div class="w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 overflow-hidden"
          style="background:${color}20;color:${color}">${avatar}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <h3 class="text-sm font-semibold truncate">${escapeHtml(account.display_name || account.email)}</h3>
            ${account.is_default ? '<span class="badge bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Default</span>' : ''}
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${escapeHtml(account.email)}</p>
        </div>
        ${Number(account.unread) > 0 ? `<span class="badge bg-blue-600 text-white shrink-0">${Number(account.unread)}</span>` : ''}
      </div>

      ${hasPermission('accounts:signature') ? `<details class="mt-3 text-xs">
        <summary class="cursor-pointer text-gray-500 dark:text-gray-400 select-none">Signature</summary>
        <textarea data-signature rows="3" class="field mt-1.5 text-xs" placeholder="Plain-text signature added to new messages">${escapeHtml(account.signature || '')}</textarea>
        <div class="flex justify-end mt-1.5">
          <button data-action="signature" data-id="${account.id}" class="btn-chip">Save signature</button>
        </div>
      </details>` : ''}

      <div class="mt-3 flex items-center justify-between text-xs">
        <span class="inline-flex items-center gap-1.5 ${status.text}">
          <span class="w-1.5 h-1.5 rounded-full ${status.dot}"></span>${status.label}
        </span>
        <span class="text-gray-400">${account.sync_enabled ? 'Sync on' : 'Sync off'}</span>
      </div>

      <div class="mt-1 text-[11px] text-gray-400">
        ${account.syncing
          ? `<span class="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400"><span class="material-icons-outlined text-xs animate-spin">sync</span>${account.sync_progress?.total
            ? `Syncing ${account.sync_progress.done}/${account.sync_progress.total}`
            : 'Syncing...'}</span>`
          : account.last_synced_at ? `Last sync: ${escapeHtml(formatDateTime(account.last_synced_at))}` : 'Not synced yet'}
      </div>
      ${account.status !== 'healthy' && account.last_error ? `<p class="mt-2 text-[11px] text-red-500 break-words">${escapeHtml(account.last_error)}</p>` : ''}

      ${account.status !== 'healthy' && hasPermission('accounts:add') ? `<button data-action="reconnect" data-id="${account.id}"
        class="mt-3 w-full btn-secondary text-amber-700 dark:text-amber-300">
        <span class="material-icons-outlined text-base">link</span> Reconnect
      </button>` : ''}

      <div class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex items-center gap-1">
        ${!account.is_default && hasPermission('accounts:set_default')
          ? `<button data-action="default" data-id="${account.id}" class="btn-chip">Set default</button>` : '<span></span>'}
        <div class="ml-auto flex items-center gap-1">
          ${hasPermission('accounts:color') ? `<label class="btn-icon relative cursor-pointer" title="Change color">
            <span class="material-icons-outlined text-lg" style="color:${color}">palette</span>
            <input type="color" data-action="color" data-id="${account.id}" value="${color}"
              class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" aria-label="Card color">
          </label>` : ''}
          ${hasPermission('accounts:refresh') ? `<button data-action="refresh" data-id="${account.id}" class="btn-icon text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" title="Sync now">
            <span class="material-icons-outlined text-lg">refresh</span>
          </button>` : ''}
          ${hasPermission('accounts:remove') ? `<button data-action="remove" data-id="${account.id}" data-email="${escapeHtml(account.email)}" class="btn-icon text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="Remove account">
            <span class="material-icons-outlined text-lg">delete</span>
          </button>` : ''}
        </div>
      </div>
    </div>`;
}

function bindCardActions(grid, startOAuth) {
  const patch = async (id, body, message) => {
    try {
      await api(`/api/accounts/${id}`, { method: 'PATCH', body });
      if (message) showToast(message, 'success');
      await loadAccountsFromDom(startOAuth);
    } catch (error) {
      showToast(error.message, 'error');
    }
  };

  grid.querySelectorAll('[data-action="default"]').forEach((button) => {
    button.addEventListener('click', () => patch(button.dataset.id, { is_default: true }, 'Default account updated.'));
  });

  grid.querySelectorAll('[data-action="color"]').forEach((input) => {
    input.addEventListener('change', () => patch(input.dataset.id, { card_color: input.value }, 'Card color updated.'));
  });

  grid.querySelectorAll('[data-action="signature"]').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('div[data-id]');
      const value = card?.querySelector('[data-signature]')?.value || '';
      patch(button.dataset.id, { signature: value }, 'Signature saved.');
    });
  });

  grid.querySelectorAll('[data-action="refresh"]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.classList.add('opacity-50');
      try {
        const result = await api(`/api/accounts/${button.dataset.id}/refresh`, { method: 'POST' });
        showToast(result.ok ? 'Sync started.' : (result.error || 'Health check failed.'), result.ok ? 'success' : 'error');
      } catch (error) {
        showToast(error.message, 'error');
      }
      await loadAccountsFromDom(startOAuth);
    });
  });

  grid.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm(`Remove ${button.dataset.email}? Its cached mail and tokens will be deleted. The Google account itself is not affected.`)) return;
      try {
        await api(`/api/accounts/${button.dataset.id}`, { method: 'DELETE' });
        showToast('Account removed.', 'success');
        await loadAccountsFromDom(startOAuth);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  grid.querySelectorAll('[data-action="reconnect"]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const { url } = await api(`/api/accounts/${button.dataset.id}/reconnect`, { method: 'POST' });
        window.location.href = url;
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
}

async function loadAccountsFromDom(startOAuth) {
  const status = await api('/api/accounts/oauth-status').catch(() => ({ configured: true, redirect_uri: '' }));
  await loadAccounts(status, startOAuth);
  renderOAuthBanner(status);
}
