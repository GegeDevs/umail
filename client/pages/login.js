import { api } from '../api.js';

export function renderLoginPage() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="min-h-full flex items-center justify-center p-4">
      <div class="w-full max-w-sm">
        <div class="text-center mb-6">
          <div class="w-14 h-14 mx-auto rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/20">
            <span class="material-icons-outlined text-3xl">mail</span>
          </div>
          <h1 class="text-2xl font-bold mt-4">UMail</h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">Sign in to your unified inbox.</p>
        </div>

        <form id="login-form" class="card shadow-xl p-6 space-y-4">
          <div>
            <label class="label" for="login-username">Username</label>
            <input id="login-username" class="field" autocomplete="username" required autofocus>
          </div>
          <div>
            <label class="label" for="login-password">Password</label>
            <input id="login-password" type="password" class="field" autocomplete="current-password" required>
          </div>
          <p id="login-error" class="hidden text-sm text-red-600 dark:text-red-400"></p>
          <button id="login-submit" type="submit" class="btn-block">Sign in</button>
        </form>

        <p class="text-center text-xs text-gray-500 dark:text-gray-400 mt-5">Unified Gmail manager · self-hosted</p>
      </div>
    </div>
  `;

  const form = document.getElementById('login-form');
  const error = document.getElementById('login-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.add('hidden');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const button = document.getElementById('login-submit');
    button.disabled = true;
    button.textContent = 'Signing in...';
    try {
      await api('/api/users/login', { method: 'POST', body: { username, password } });
      window.location.hash = '#/';
      window.location.reload();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}
