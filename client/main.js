import './style.css';
import { initTheme } from './theme.js';
import { api, setCsrfToken } from './api.js';
import { initRouter, registerRoute, navigate } from './router.js';
import { setCurrentUser, hasPageAccess, hasPermission, defaultLanding } from './auth-state.js';
import { loadTimeSettings } from './time-utils.js';
import { setAuthLayout, setAppLayout } from './layout.js';
import { renderSidebar, updateActiveNav } from './components/sidebar.js';
import { initSidebarToggle } from './components/sidebar-toggle.js';
import { showToast } from './components/toast.js';
import { showLogoutModal } from './components/logout-modal.js';
import { openComposer } from './components/composer.js';
import { initAiChat } from './components/ai-chat.js';
import { initNotifications } from './notifications.js';
import { renderSetupPage } from './pages/setup.js';
import { renderLoginPage } from './pages/login.js';
import { renderMailPage, renderSearchPage } from './pages/mail.js';
import { renderAccountsPage } from './pages/accounts.js';
import { renderSettingsPage } from './pages/settings.js';
import { renderUsersPage } from './pages/users.js';
import { renderActivityPage, renderLogsPage, renderApiAccessPage, renderApiDocsPage } from './pages/admin.js';

initTheme();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('Service worker failed:', error.message));
  });
}

async function boot() {
  let status;
  try {
    status = await api('/api/setup/status');
  } catch (error) {
    setAuthLayout();
    document.getElementById('main-content').innerHTML = `
      <div class="min-h-full flex items-center justify-center p-4">
        <div class="card p-6 max-w-md text-center">
          <span class="material-icons-outlined text-red-500 text-4xl">cloud_off</span>
          <h1 class="text-lg font-bold mt-3">Server unavailable</h1>
          <p class="muted mt-1">${error.message}</p>
        </div>
      </div>`;
    return;
  }

  if (!status.initialized) {
    setAuthLayout();
    renderSetupPage();
    return;
  }

  let user;
  try {
    user = await api('/api/users/me');
  } catch {
    setAuthLayout();
    renderLoginPage();
    return;
  }

  setCurrentUser(user);
  setCsrfToken(user.csrf);
  await loadTimeSettings();
  setAppLayout();
  renderSidebar();
  initSidebarToggle();
  initTopbar(user);
  initAiChat();
  initShortcuts();
  initNotifications();
  initRoutes();
  initRouter();
  window.addEventListener('hashchange', updateActiveNav);
}

function guarded(page, render) {
  return (params) => {
    if (!hasPageAccess(page)) {
      showToast(`No access to ${page}.`, 'error');
      navigate(defaultLanding());
      return;
    }
    return render(params);
  };
}

function initRoutes() {
  registerRoute('/', guarded('mail', renderMailPage));
  registerRoute('/label/:name', guarded('mail', renderMailPage));
  registerRoute('/search', guarded('mail', renderSearchPage));
  registerRoute('/accounts', guarded('accounts', renderAccountsPage));
  registerRoute('/settings', guarded('settings', renderSettingsPage));
  registerRoute('/users', guarded('admin', renderUsersPage));
  registerRoute('/activity', guarded('admin', renderActivityPage));
  registerRoute('/logs', guarded('admin', renderLogsPage));
  registerRoute('/api-access', guarded('admin', renderApiAccessPage));
  registerRoute('/api-docs', guarded('admin', renderApiDocsPage));
}

function initTopbar(user) {
  document.getElementById('user-menu-name').textContent = user.username;
  document.getElementById('user-menu-role').textContent = user.role === 'master' ? 'Master' : 'Slave';
  const avatar = document.getElementById('topbar-avatar');
  avatar.textContent = user.username.slice(0, 1).toUpperCase();

  const menu = document.getElementById('user-menu');
  const button = document.getElementById('btn-user-menu');
  button?.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (event) => {
    if (!menu?.contains(event.target) && !button?.contains(event.target)) menu?.classList.add('hidden');
  });
  menu?.querySelector('[data-menu="settings"]')?.addEventListener('click', () => {
    menu.classList.add('hidden');
    navigate('/settings');
  });
  menu?.querySelector('[data-menu="logout"]')?.addEventListener('click', () => {
    menu.classList.add('hidden');
    showLogoutModal();
  });

  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('umail:refresh-mail'));
  });

  const search = document.getElementById('global-search');
  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const q = search.value.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  });
}

function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (event.key === 'Escape') {
      if (event.target === document.getElementById('global-search')) {
        event.target.blur();
        event.preventDefault();
        return;
      }
      const modal = document.getElementById('modal-root');
      if (modal?.firstElementChild) {
        modal.innerHTML = '';
        event.preventDefault();
        return;
      }
      const composerClose = document.getElementById('composer-close');
      if (composerClose) {
        composerClose.click();
        event.preventDefault();
        return;
      }
      const readerBack = document.getElementById('reader-back');
      if (readerBack) {
        readerBack.click();
        event.preventDefault();
      }
      return;
    }
    if (typing) return;
    if (event.key === '/') {
      event.preventDefault();
      document.getElementById('global-search')?.focus();
      return;
    }
    if (event.key === 'c' && hasPermission('mail:send') && document.getElementById('mail-layout')) {
      event.preventDefault();
      openComposer({});
    }
  });
}

boot();
