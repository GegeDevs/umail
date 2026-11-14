import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { getCurrentUser, hasPermission } from '../auth-state.js';
import { escapeHtml } from '../lib/html.js';
import { formatDateTime } from '../time-utils.js';

function pageHeader(title, subtitle) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div>
        <h1 class="text-xl md:text-2xl font-bold">${title}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">${subtitle}</p>
      </div>
    </div>`;
}

export async function renderActivityPage() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-6xl mx-auto">
      ${pageHeader('Activity', 'User actions recorded by UMail.')}
      <form id="activity-filter" class="flex flex-wrap items-center gap-2 mb-3">
        <input id="filter-user" class="field !w-auto" placeholder="Username">
        <input id="filter-action" class="field !w-auto" placeholder="Action, e.g. auth.login">
        <button class="btn-secondary" type="submit"><span class="material-icons-outlined text-base">filter_alt</span> Filter</button>
        <button id="activity-refresh" type="button" class="btn-icon text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Refresh"><span class="material-icons-outlined">refresh</span></button>
      </form>
      <div id="activity-list" class="card overflow-hidden"><div class="p-8 text-center muted">Loading...</div></div>
    </div>`;

  document.getElementById('activity-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    loadActivity();
  });
  document.getElementById('activity-refresh').addEventListener('click', loadActivity);
  await loadActivity();
}

async function loadActivity() {
  const container = document.getElementById('activity-list');
  if (!container) return;
  const user = document.getElementById('filter-user').value.trim();
  const action = document.getElementById('filter-action').value.trim();
  const params = new URLSearchParams({ limit: '100' });
  if (user) params.set('user', user);
  if (action) params.set('action', action);
  try {
    const data = await api(`/api/activity?${params}`);
    const results = data.results || [];
    if (!results.length) {
      container.innerHTML = `<div class="p-8 text-center muted">No activity recorded.</div>`;
      return;
    }
    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-800/60 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr><th class="px-4 py-3 font-medium">Time</th><th class="px-4 py-3 font-medium">User</th><th class="px-4 py-3 font-medium">Action</th><th class="px-4 py-3 font-medium">Detail</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
            ${results.map((row) => `<tr>
              <td class="px-4 py-3 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">${escapeHtml(formatDateTime(row.created_at))}</td>
              <td class="px-4 py-3 font-medium">${escapeHtml(row.username || '—')}</td>
              <td class="px-4 py-3"><code class="text-xs bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">${escapeHtml(row.action)}</code></td>
              <td class="px-4 py-3 text-gray-600 dark:text-gray-300">${escapeHtml(row.detail || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (error) {
    container.innerHTML = `<div class="p-6 text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</div>`;
  }
}

export async function renderLogsPage() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-6xl mx-auto">
      ${pageHeader('System logs', 'Token, sync, and API events. Never contains email bodies or secrets.')}
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <select id="log-level" class="field !w-auto">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <button id="logs-refresh" class="btn-secondary"><span class="material-icons-outlined text-base">refresh</span> Refresh</button>
        ${getCurrentUser()?.role === 'master' ? '<button id="logs-clear" class="btn-secondary text-red-600 dark:text-red-400"><span class="material-icons-outlined text-base">delete_sweep</span> Clear</button>' : ''}
      </div>
      <div id="logs-list" class="card overflow-hidden"><div class="p-8 text-center muted">Loading...</div></div>
    </div>`;

  document.getElementById('log-level').addEventListener('change', loadLogs);
  document.getElementById('logs-refresh').addEventListener('click', loadLogs);
  document.getElementById('logs-clear')?.addEventListener('click', async () => {
    if (!confirm('Clear all system logs?')) return;
    try {
      await api('/api/logs', { method: 'DELETE' });
      showToast('Logs cleared.', 'success');
      loadLogs();
    } catch (error) { showToast(error.message, 'error'); }
  });
  await loadLogs();
}

async function loadLogs() {
  const container = document.getElementById('logs-list');
  if (!container) return;
  const level = document.getElementById('log-level').value;
  const params = new URLSearchParams({ limit: '100' });
  if (level) params.set('level', level);
  try {
    const data = await api(`/api/logs?${params}`);
    const results = data.results || [];
    if (!results.length) {
      container.innerHTML = `<div class="p-8 text-center muted">No system logs.</div>`;
      return;
    }
    container.innerHTML = results.map((row) => {
      const tone = row.level === 'error' ? 'text-red-600 dark:text-red-400' : row.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400';
      return `<div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
        <div class="flex items-start gap-2">
          <span class="material-icons-outlined text-lg ${tone}">${row.level === 'error' ? 'error' : row.level === 'warn' ? 'warning' : 'info'}</span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">${escapeHtml(row.message)}</span>
              <span class="text-[11px] uppercase tracking-wide ${tone}">${escapeHtml(row.level)}</span>
              <span class="text-[11px] text-gray-400 ml-auto">${escapeHtml(formatDateTime(row.created_at))}</span>
            </div>
            ${row.detail ? `<div class="text-xs text-gray-500 dark:text-gray-400 mt-1 break-words">${escapeHtml(row.detail)}</div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (error) {
    container.innerHTML = `<div class="p-6 text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</div>`;
  }
}

const API_PERMISSION_LABELS = [
  ['api:mail:read', 'Read mail'],
  ['api:mail:send', 'Send mail'],
  ['api:mail:modify', 'Modify mail'],
  ['api:accounts:read', 'Read accounts']
];

export async function renderApiAccessPage() {
  const main = document.getElementById('main-content');
  if (!hasPermission('admin:manage_api')) {
    main.innerHTML = `<div class="p-6 text-sm text-red-600 dark:text-red-400">You do not have permission to manage API keys.</div>`;
    return;
  }
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-5xl mx-auto">
      ${pageHeader('API access', 'Create keys for the public REST API. Keys are shown once.')}
      <div class="grid gap-4 lg:grid-cols-[1fr_340px] items-start">
        <div class="card overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800 text-sm font-semibold">Active keys</div>
          <div id="api-key-list"><div class="p-6 text-sm text-gray-500">Loading...</div></div>
        </div>
        <form id="api-key-form" class="card p-4 space-y-3">
          <h2 class="panel-title">Create key</h2>
          <div>
            <label class="label" for="api-key-name">Name</label>
            <input id="api-key-name" class="field" placeholder="Automation" required>
          </div>
          <div class="space-y-1.5">
            ${API_PERMISSION_LABELS.map(([value, label]) => `
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" class="accent-blue-600" name="api-permission" value="${value}">
                ${label} <code class="text-[11px] text-gray-400">${value}</code>
              </label>`).join('')}
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="api-key-rate">Rate / min</label>
              <input id="api-key-rate" type="number" min="1" max="600" value="60" class="field">
            </div>
            <div>
              <label class="label" for="api-key-expiry">Expires (days)</label>
              <input id="api-key-expiry" type="number" min="0" value="0" class="field">
            </div>
          </div>
          <button type="submit" class="btn-primary w-full justify-center">
            <span class="material-icons-outlined text-base">key</span> Create API key
          </button>
        </form>
      </div>
      <div id="api-key-secret" class="hidden card p-4 mt-4 border-green-300 dark:border-green-800">
        <h2 class="panel-title mb-2">Copy this key now</h2>
        <p class="muted mb-2">It will not be shown again.</p>
        <div class="flex gap-2">
          <input id="api-key-secret-value" class="field font-mono text-xs" readonly>
          <button id="api-key-copy" class="btn-secondary shrink-0">Copy</button>
        </div>
      </div>
    </div>`;

  const list = document.getElementById('api-key-list');

  const loadKeys = async () => {
    try {
      const { results } = await api('/api/api-keys');
      if (!results.length) {
        list.innerHTML = '<div class="p-6 text-sm text-gray-500 dark:text-gray-400">No API keys yet.</div>';
        return;
      }
      list.innerHTML = results.map((row) => `
        <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">${escapeHtml(row.name)}</span>
            <code class="text-[11px] text-gray-400">${escapeHtml(row.key_prefix)}…</code>
            <span class="text-[11px] text-gray-400 ml-auto">${row.last_used_at ? `used ${escapeHtml(formatDateTime(row.last_used_at))}` : 'never used'}</span>
            <button data-revoke="${row.id}" class="btn-icon text-red-500" title="Revoke">
              <span class="material-icons-outlined text-lg">delete</span>
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
            ${row.permissions.map((permission) => `<span class="badge bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">${escapeHtml(permission)}</span>`).join('')}
            <span class="text-[11px] text-gray-400">${row.rate_limit}/min</span>
            <span class="text-[11px] text-gray-400">${row.expires_at ? `expires ${escapeHtml(formatDateTime(row.expires_at))}` : 'no expiry'}</span>
          </div>
        </div>`).join('');
      list.querySelectorAll('[data-revoke]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('Revoke this API key? Requests using it will fail immediately.')) return;
          try {
            await api(`/api/api-keys/${button.dataset.revoke}`, { method: 'DELETE' });
            showToast('API key revoked.', 'success');
            loadKeys();
          } catch (error) {
            showToast(error.message, 'error');
          }
        });
      });
    } catch (error) {
      list.innerHTML = `<div class="p-6 text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</div>`;
    }
  };

  document.getElementById('api-key-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const permissions = [...document.querySelectorAll('input[name="api-permission"]:checked')]
      .map((input) => input.value);
    if (!permissions.length) {
      showToast('Select at least one permission.', 'error');
      return;
    }
    try {
      const created = await api('/api/api-keys', {
        method: 'POST',
        body: {
          name: document.getElementById('api-key-name').value,
          permissions,
          rateLimit: Number(document.getElementById('api-key-rate').value),
          expiresDays: Number(document.getElementById('api-key-expiry').value)
        }
      });
      document.getElementById('api-key-secret').classList.remove('hidden');
      document.getElementById('api-key-secret-value').value = created.key;
      document.getElementById('api-key-form').reset();
      document.getElementById('api-key-rate').value = '60';
      document.getElementById('api-key-expiry').value = '0';
      showToast('API key created. Copy it now.', 'success');
      loadKeys();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('api-key-copy')?.addEventListener('click', async () => {
    const input = document.getElementById('api-key-secret-value');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      showToast('Copied.', 'success');
    } catch {
      showToast('Copy failed. Select the key manually.', 'error');
    }
  });

  await loadKeys();
}

export function renderApiDocsPage() {
  const main = document.getElementById('main-content');
  const rows = [
    ['GET', '/api/v1/accounts', 'api:accounts:read'],
    ['GET', '/api/v1/messages?box=inbox&limit=30', 'api:mail:read'],
    ['GET', '/api/v1/threads/:accountId/:threadId', 'api:mail:read'],
    ['GET', '/api/v1/labels', 'api:mail:read'],
    ['GET', '/api/v1/search?q=...', 'api:mail:read'],
    ['POST', '/api/v1/messages/actions', 'api:mail:modify'],
    ['POST', '/api/v1/messages/send', 'api:mail:send']
  ];
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-4xl mx-auto">
      ${pageHeader('API docs', 'REST API for automation. Use a bearer token from API access.')}
      <div class="card p-5 mb-4">
        <h2 class="panel-title mb-2">Authentication</h2>
        <p class="muted mb-3">Send the API key as a bearer token. Every key has its own permissions and rate limit.</p>
        <pre class="text-xs bg-gray-100 dark:bg-gray-900 rounded-lg p-3 overflow-x-auto"><code>Authorization: Bearer umail_...</code></pre>
      </div>
      <div class="card p-5 mb-4">
        <h2 class="panel-title mb-2">Example</h2>
        <pre class="text-xs bg-gray-100 dark:bg-gray-900 rounded-lg p-3 overflow-x-auto"><code>curl -s http://localhost:3000/api/v1/messages?box=inbox \\
  -H "Authorization: Bearer $UMAIL_KEY"</code></pre>
      </div>
      <div class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800/60 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr><th class="px-4 py-3 font-medium">Method</th><th class="px-4 py-3 font-medium">Endpoint</th><th class="px-4 py-3 font-medium">Permission</th></tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              ${rows.map(([method, path, permission]) => `<tr>
                <td class="px-4 py-3"><span class="badge bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">${method}</span></td>
                <td class="px-4 py-3"><code class="text-xs">${path}</code></td>
                <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${permission}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}
