import { api } from '../api.js';
import { showToast } from './toast.js';

export function showLogoutModal() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div class="card shadow-2xl w-full max-w-sm p-6">
        <div class="flex items-center gap-3 mb-3">
          <span class="material-icons-outlined text-red-600 text-3xl">logout</span>
          <h2 class="text-lg font-bold">Sign out?</h2>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">Your session will end on this device.</p>
        <div class="flex justify-end gap-2">
          <button id="logout-cancel" class="btn-secondary">Cancel</button>
          <button id="logout-confirm" class="btn-danger">Sign out</button>
        </div>
      </div>
    </div>
  `;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('#logout-cancel').addEventListener('click', close);
  root.querySelector('#logout-confirm').addEventListener('click', async () => {
    const button = root.querySelector('#logout-confirm');
    button.disabled = true;
    try {
      await api('/api/users/logout', { method: 'POST' });
      window.location.hash = '#/login';
      window.location.reload();
    } catch (error) {
      showToast(error.message, 'error');
      button.disabled = false;
    }
  });
}
