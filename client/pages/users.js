import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { PERMISSION_GROUPS, getCurrentUser, hasPermission } from '../auth-state.js';
import { escapeHtml } from '../lib/html.js';

let groups = PERMISSION_GROUPS;

export async function renderUsersPage() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-6xl mx-auto">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 class="text-xl md:text-2xl font-bold">Users</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Master and slave accounts for this instance.</p>
        </div>
        ${hasPermission('admin:manage_users') ? `<button id="users-add" class="btn-primary">
          <span class="material-icons-outlined text-base">person_add</span> Add user
        </button>` : ''}
      </div>
      <div id="users-list" class="card overflow-hidden">
        <div class="p-8 text-center muted">Loading...</div>
      </div>
    </div>
  `;

  try {
    const data = await api('/api/users/permission-groups');
    groups = data.groups || PERMISSION_GROUPS;
  } catch {}

  document.getElementById('users-add')?.addEventListener('click', showAddUserModal);
  await loadUsers();
}

async function loadUsers() {
  const container = document.getElementById('users-list');
  if (!container) return;
  let users;
  try {
    const data = await api('/api/users');
    users = data.results || [];
  } catch (error) {
    container.innerHTML = `<div class="p-6 text-sm text-red-600 dark:text-red-400">${escapeHtml(error.message)}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800/60 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <tr>
            <th class="px-4 py-3 font-medium">User</th>
            <th class="px-4 py-3 font-medium">Role</th>
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Permissions</th>
            <th class="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
          ${users.map((user) => `
            <tr class="hover:bg-gray-50/60 dark:hover:bg-gray-800/40">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold">${escapeHtml(user.username.slice(0, 1).toUpperCase())}</div>
                  <div>
                    <div class="font-medium">${escapeHtml(user.username)}</div>
                    <div class="text-[11px] text-gray-500 dark:text-gray-400">Created ${escapeHtml(user.created_at || '—')}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="badge ${user.role === 'master' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}">${user.role}</span>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex items-center gap-1 text-xs ${user.is_active ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}">
                  <span class="w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-500' : 'bg-gray-400'}"></span>
                  ${user.is_active ? 'Active' : 'Disabled'}
                </span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">${user.role === 'master' ? 'All' : `${user.permissions.length} granted`}</td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-1">
                  <button data-perms="${user.id}" class="btn-icon text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" title="Permissions">
                    <span class="material-icons-outlined text-lg">tune</span>
                  </button>
                  <button data-password="${user.id}" class="btn-icon text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" title="Reset password">
                    <span class="material-icons-outlined text-lg">key</span>
                  </button>
                  <button data-toggle="${user.id}" data-active="${user.is_active}" class="btn-icon ${user.is_active ? 'text-amber-500' : 'text-green-600'} hover:bg-gray-100 dark:hover:bg-gray-700" title="${user.is_active ? 'Disable' : 'Enable'}">
                    <span class="material-icons-outlined text-lg">${user.is_active ? 'block' : 'check_circle'}</span>
                  </button>
                  <button data-delete="${user.id}" class="btn-icon text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="Delete">
                    <span class="material-icons-outlined text-lg">delete</span>
                  </button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const current = getCurrentUser();
  container.querySelectorAll('[data-perms]').forEach((button) => {
    button.addEventListener('click', () => showPermissionsModal(Number(button.dataset.perms), users));
  });
  container.querySelectorAll('[data-password]').forEach((button) => {
    button.addEventListener('click', () => showPasswordModal(Number(button.dataset.password), users));
  });
  container.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const active = button.dataset.active === '1';
      if (Number(button.dataset.toggle) === current.id) return showToast('You cannot disable yourself.', 'error');
      try {
        await api(`/api/users/${button.dataset.toggle}`, { method: 'PATCH', body: { is_active: !active } });
        showToast(active ? 'User disabled.' : 'User enabled.', 'success');
        loadUsers();
      } catch (error) { showToast(error.message, 'error'); }
    });
  });
  container.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = users.find((user) => user.id === Number(button.dataset.delete));
      if (!confirm(`Delete user "${target?.username}"? This cannot be undone.`)) return;
      try {
        await api(`/api/users/${button.dataset.delete}`, { method: 'DELETE' });
        showToast('User deleted.', 'success');
        loadUsers();
      } catch (error) { showToast(error.message, 'error'); }
    });
  });
}

function modal(html, wide = false) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" data-overlay="1">
      <div class="card shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[85vh] flex flex-col">
        ${html}
      </div>
    </div>`;
  root.querySelector('[data-overlay]').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) root.innerHTML = '';
  });
  root.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  return root;
}

function showAddUserModal() {
  const root = modal(`
    <div class="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
      <h2 class="text-lg font-bold">Add user</h2>
      <button data-close class="btn-icon text-gray-400 hover:text-gray-600"><span class="material-icons-outlined">close</span></button>
    </div>
    <form id="add-user-form" class="p-5 space-y-4 overflow-y-auto">
      <div><label class="label" for="new-username">Username</label><input id="new-username" class="field" required minlength="3" maxlength="32" autocomplete="off"></div>
      <div><label class="label" for="new-password">Password</label><input id="new-password" type="password" class="field" required minlength="8" autocomplete="new-password"></div>
      <div><label class="label" for="new-role">Role</label>
        <select id="new-role" class="field"><option value="slave">Slave</option><option value="master">Master</option></select>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">Slave starts with view, read, search, and attachment permissions. Adjust after creating.</p>
      <p id="add-user-error" class="hidden text-sm text-red-600 dark:text-red-400"></p>
      <div class="flex justify-end gap-2"><button type="button" data-close class="btn-secondary">Cancel</button><button type="submit" class="btn-primary">Create user</button></div>
    </form>`);

  root.querySelector('#add-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = root.querySelector('#add-user-error');
    try {
      await api('/api/users', {
        method: 'POST',
        body: {
          username: root.querySelector('#new-username').value.trim(),
          password: root.querySelector('#new-password').value,
          role: root.querySelector('#new-role').value
        }
      });
      root.innerHTML = '';
      showToast('User created.', 'success');
      loadUsers();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

async function showPermissionsModal(id, users) {
  const user = users.find((item) => item.id === id);
  if (!user) return;
  const root = modal(`
    <div class="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
      <div><h2 class="text-lg font-bold">Permissions</h2><p class="text-xs text-gray-500 dark:text-gray-400">${escapeHtml(user.username)} · ${user.role}</p></div>
      <button data-close class="btn-icon text-gray-400 hover:text-gray-600"><span class="material-icons-outlined">close</span></button>
    </div>
    <div class="p-5 overflow-y-auto space-y-5">
      ${Object.entries(groups).map(([group, permissions]) => `
        <section>
          <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">${escapeHtml(group)}</h3>
          <div class="grid gap-2 sm:grid-cols-2">
            ${permissions.map((permission) => `
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" class="accent-blue-600" value="${permission}" data-perm ${user.permissions.includes(permission) ? 'checked' : ''} ${user.role === 'master' ? 'disabled' : ''}>
                <span class="truncate">${escapeHtml(permission)}</span>
              </label>`).join('')}
          </div>
        </section>`).join('')}
    </div>
    <div class="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
      <button data-close class="btn-secondary">Cancel</button>
      <button id="save-perms" class="btn-primary" ${user.role === 'master' ? 'disabled' : ''}>Save permissions</button>
    </div>`);

  root.querySelector('#save-perms')?.addEventListener('click', async () => {
    const permissions = [...root.querySelectorAll('[data-perm]:checked')].map((input) => input.value);
    try {
      await api(`/api/users/${id}/permissions`, { method: 'PUT', body: { permissions } });
      root.innerHTML = '';
      showToast('Permissions updated.', 'success');
      loadUsers();
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function showPasswordModal(id, users) {
  const user = users.find((item) => item.id === id);
  const root = modal(`
    <div class="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
      <div><h2 class="text-lg font-bold">Reset password</h2><p class="text-xs text-gray-500 dark:text-gray-400">${escapeHtml(user?.username || '')}</p></div>
      <button data-close class="btn-icon text-gray-400 hover:text-gray-600"><span class="material-icons-outlined">close</span></button>
    </div>
    <form id="reset-form" class="p-5 space-y-4">
      <div><label class="label" for="reset-password">New password</label><input id="reset-password" type="password" class="field" required minlength="8" autocomplete="new-password"></div>
      <p class="text-xs text-gray-500 dark:text-gray-400">All sessions for this user will be revoked.</p>
      <div class="flex justify-end gap-2"><button type="button" data-close class="btn-secondary">Cancel</button><button type="submit" class="btn-primary">Reset password</button></div>
    </form>`);
  root.querySelector('#reset-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/users/${id}/password`, { method: 'POST', body: { password: root.querySelector('#reset-password').value } });
      root.innerHTML = '';
      showToast('Password reset.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  });
}
