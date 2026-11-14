import { api } from '../api.js';

export function renderSetupPage() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="min-h-full flex items-center justify-center p-4">
      <div class="w-full max-w-sm">
        <div class="text-center mb-6">
          <div class="w-14 h-14 mx-auto rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/20">
            <span class="material-icons-outlined text-3xl">mail</span>
          </div>
          <h1 class="text-2xl font-bold mt-4">Welcome to UMail</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Create the master account for this instance.</p>
        </div>

        <form id="setup-form" class="card shadow-xl p-6 space-y-4">
          <div>
            <label class="label" for="setup-username">Username</label>
            <input id="setup-username" class="field" autocomplete="username" required minlength="3" maxlength="32" placeholder="admin">
          </div>
          <div>
            <label class="label" for="setup-password">Password</label>
            <input id="setup-password" type="password" class="field" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
          </div>
          <div>
            <label class="label" for="setup-confirm">Confirm password</label>
            <input id="setup-confirm" type="password" class="field" autocomplete="new-password" required minlength="8">
          </div>
          <p id="setup-error" class="hidden text-sm text-red-600 dark:text-red-400"></p>
          <button id="setup-submit" type="submit" class="btn-block">Create master account</button>
        </form>

        <p class="text-center text-xs text-gray-500 dark:text-gray-400 mt-5">Unified Gmail manager · self-hosted</p>
      </div>
    </div>
  `;

  const form = document.getElementById('setup-form');
  const error = document.getElementById('setup-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.add('hidden');
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-confirm').value;
    if (password !== confirm) {
      error.textContent = 'Passwords do not match.';
      error.classList.remove('hidden');
      return;
    }
    const button = document.getElementById('setup-submit');
    button.disabled = true;
    button.textContent = 'Creating...';
    try {
      await api('/api/setup', { method: 'POST', body: { username, password } });
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      button.disabled = false;
      button.textContent = 'Create master account';
    }
  });
}
