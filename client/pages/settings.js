import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { hasPermission } from '../auth-state.js';
import { getTheme, setTheme } from '../theme.js';
import { setCachedTimeSettings } from '../time-utils.js';
import { escapeHtml } from '../lib/html.js';
import { notificationsEnabled, setNotificationsEnabled } from '../notifications.js';

function timezoneOptions(current) {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [current, 'UTC'];
  }
  const unique = [...new Set(['UTC', current, ...zones].filter(Boolean))];
  return unique.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === current ? 'selected' : ''}>${escapeHtml(zone.replace(/_/g, ' '))}</option>`).join('');
}

export async function renderSettingsPage() {
  const main = document.getElementById('main-content');
  let settings = {};
  try {
    settings = await api('/api/settings');
  } catch (error) {
    showToast(error.message, 'error');
  }
  const canEdit = hasPermission('settings:edit');
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  main.innerHTML = `
    <div class="p-4 md:p-6 max-w-3xl mx-auto">
      <div class="mb-5">
        <h1 class="text-xl md:text-2xl font-bold">Settings</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Appearance, sync, and privacy defaults.</p>
      </div>

      <form id="settings-form" class="space-y-4">
        <section class="card p-5">
          <h2 class="panel-title mb-4">Appearance</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label" for="set-theme">Theme</label>
              <select id="set-theme" class="field" ${canEdit ? '' : 'disabled'}>
                <option value="auto">Auto</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <div>
              <label class="label" for="set-timezone">Timezone</label>
              <select id="set-timezone" class="field" ${canEdit ? '' : 'disabled'}>
                ${timezoneOptions(tz)}
              </select>
            </div>
            <div>
              <label class="label" for="set-time-format">Time format</label>
              <select id="set-time-format" class="field" ${canEdit ? '' : 'disabled'}>
                <option value="24">24-hour</option>
                <option value="12">12-hour</option>
              </select>
            </div>
          </div>
        </section>

        <section class="card p-5">
          <h2 class="panel-title mb-1">Sync</h2>
          <p class="muted mb-4">Polling is used until Gmail Pub/Sub support lands.</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label" for="set-sync-interval">Sync interval (seconds)</label>
              <input id="set-sync-interval" type="number" min="30" max="900" class="field" value="${escapeHtml(settings.sync_interval || '60')}" ${canEdit ? '' : 'disabled'}>
            </div>
            <div>
              <label class="label" for="set-sync-window">Sync window (days)</label>
              <input id="set-sync-window" type="number" min="1" max="3650" class="field" value="${escapeHtml(settings.sync_window_days || '90')}" ${canEdit ? '' : 'disabled'}>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">How far back to fetch mail on a full sync. Max 1,000 messages per account.</p>
            </div>
          </div>
        </section>

        <section class="card p-5">
          <h2 class="panel-title mb-4">Reading privacy</h2>
          <label class="flex items-start gap-3 py-2 cursor-pointer">
            <input id="set-mark-read" type="checkbox" class="mt-0.5 accent-blue-600" ${settings.mark_read_on_open === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            <span><span class="text-sm font-medium block">Mark as read on open</span><span class="text-xs text-gray-500 dark:text-gray-400">Requires mail:modify permission.</span></span>
          </label>
          <label class="flex items-start gap-3 py-2 cursor-pointer">
            <input id="set-block-images" type="checkbox" class="mt-0.5 accent-blue-600" ${settings.block_remote_images === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            <span><span class="text-sm font-medium block">Block remote images</span><span class="text-xs text-gray-500 dark:text-gray-400">Prevents tracking pixels from loading by default.</span></span>
          </label>
          <div class="pt-3">
            <label class="label" for="set-reply-all">Reply button</label>
            <select id="set-reply-all" class="field" ${canEdit ? '' : 'disabled'}>
              <option value="0">Reply to sender</option>
              <option value="1">Reply all</option>
            </select>
          </div>
        </section>

        <section class="card p-5">
          <h2 class="panel-title mb-1">AI summary</h2>
          <p class="muted mb-4">OpenAI-compatible chat completions endpoint. Thread content is sent to this provider when you click Summarize.</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label" for="set-ai-base-url">Base URL</label>
              <input id="set-ai-base-url" class="field" value="${escapeHtml(settings.ai_base_url || '')}" placeholder="https://api.openai.com/v1" ${canEdit ? '' : 'disabled'}>
            </div>
            <div>
              <label class="label" for="set-ai-model">Model</label>
              <input id="set-ai-model" class="field" value="${escapeHtml(settings.ai_model || '')}" placeholder="gpt-4o-mini" ${canEdit ? '' : 'disabled'}>
            </div>
            <div class="sm:col-span-2">
              <label class="label" for="set-ai-api-key">API key</label>
              <input id="set-ai-api-key" type="password" class="field" autocomplete="new-password" value="" placeholder="${settings.ai_api_key_set === '1' ? 'Saved — leave blank to keep' : 'sk-...'}" ${canEdit ? '' : 'disabled'}>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">Encrypted when TOKEN_ENCRYPTION_KEY is set. Leave blank to keep the saved key.</p>
            </div>
          </div>
        </section>

        <section class="card p-5">
          <h2 class="panel-title mb-4">Logging</h2>
          <label class="flex items-start gap-3 py-2 cursor-pointer">
            <input id="set-activity" type="checkbox" class="mt-0.5 accent-blue-600" ${settings.activity_enabled === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            <span><span class="text-sm font-medium block">Activity log</span><span class="text-xs text-gray-500 dark:text-gray-400">Record user actions such as login and account changes.</span></span>
          </label>
          <label class="flex items-start gap-3 py-2 cursor-pointer">
            <input id="set-logs" type="checkbox" class="mt-0.5 accent-blue-600" ${settings.logs_enabled === '1' ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
            <span><span class="text-sm font-medium block">System log</span><span class="text-xs text-gray-500 dark:text-gray-400">Record token, sync, and Gmail API errors.</span></span>
          </label>
        </section>

        ${hasPermission('settings:database') ? `<section class="card p-5">
          <h2 class="panel-title mb-1">Database backup</h2>
          <p class="muted mb-4">Download a full SQLite snapshot or restore one. Restoring replaces all current data and may sign you out.</p>
          <div class="flex flex-wrap gap-2">
            <button id="backup-download" type="button" class="btn-secondary">
              <span class="material-icons-outlined text-base">download</span> Download backup
            </button>
            <label class="btn-secondary cursor-pointer">
              <span class="material-icons-outlined text-base">upload</span> Restore backup
              <input id="backup-restore" type="file" accept=".db,application/vnd.sqlite3,application/octet-stream" class="hidden">
            </label>
          </div>
        </section>` : ''}

        ${canEdit ? `<div class="flex justify-end">
          <button id="settings-save" type="submit" class="btn-primary">
            <span class="material-icons-outlined text-base">save</span> Save settings
          </button>
        </div>` : '<p class="text-xs text-amber-600 dark:text-amber-400">Read-only: you do not have settings:edit.</p>'}
      </form>
      <section class="card p-5 mt-4">
        <h2 class="panel-title mb-1">Notifications</h2>
        <p class="muted mb-3">Browser notifications for new unread mail while this tab is in the background.</p>
        <label class="flex items-start gap-3 py-2 cursor-pointer">
          <input id="set-browser-notifications" type="checkbox" class="mt-0.5 accent-blue-600" ${notificationsEnabled() ? 'checked' : ''}>
          <span><span class="text-sm font-medium block">Browser notifications</span><span class="text-xs text-gray-500 dark:text-gray-400">Saved per browser. Enabling asks for notification permission.</span></span>
        </label>
      </section>
    </div>
  `;

  const themeSelect = document.getElementById('set-theme');
  if (themeSelect) themeSelect.value = getTheme();
  const timeFormat = document.getElementById('set-time-format');
  if (timeFormat) timeFormat.value = settings.time_format || '24';
  const syncWindow = document.getElementById('set-sync-window');
  if (syncWindow) syncWindow.value = settings.sync_window_days || '90';
  const replyAll = document.getElementById('set-reply-all');
  if (replyAll) replyAll.value = settings.default_reply_all === '1' ? '1' : '0';

  document.getElementById('backup-download')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await fetch('/api/backup/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Backup download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `umail-backup-${new Date().toISOString().slice(0, 10)}.db`;
      link.click();
      URL.revokeObjectURL(url);
      showToast('Backup downloaded.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('backup-restore')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!confirm('Restore this backup? All current data will be replaced and you may need to sign in again.')) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api('/api/backup/import', { method: 'POST', body: form });
      showToast(`Backup restored (${result.restored} tables). Reloading...`, 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('set-theme')?.addEventListener('change', (event) => {
    setTheme(event.target.value);
  });

  document.getElementById('set-browser-notifications')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    if (input.checked) {
      const granted = await setNotificationsEnabled(true);
      input.checked = granted;
      if (!granted) showToast('Notification permission was not granted.', 'error');
    } else {
      await setNotificationsEnabled(false);
    }
  });

  document.getElementById('settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit) return;
    const theme = document.getElementById('set-theme').value;
    const payload = {
      theme,
      timezone: document.getElementById('set-timezone').value.trim() || 'UTC',
      time_format: document.getElementById('set-time-format').value,
      sync_interval: document.getElementById('set-sync-interval').value,
      sync_window_days: document.getElementById('set-sync-window').value,
      mark_read_on_open: document.getElementById('set-mark-read').checked ? '1' : '0',
      block_remote_images: document.getElementById('set-block-images').checked ? '1' : '0',
      default_reply_all: document.getElementById('set-reply-all').value,
      activity_enabled: document.getElementById('set-activity').checked ? '1' : '0',
      logs_enabled: document.getElementById('set-logs').checked ? '1' : '0',
      ai_base_url: document.getElementById('set-ai-base-url').value.trim(),
      ai_model: document.getElementById('set-ai-model').value.trim()
    };
    const apiKey = document.getElementById('set-ai-api-key').value.trim();
    if (apiKey) payload.ai_api_key = apiKey;
    const button = document.getElementById('settings-save');
    button.disabled = true;
    const windowChanged = String(payload.sync_window_days) !== String(settings.sync_window_days || '90');
    try {
      const saved = await api('/api/settings', { method: 'PUT', body: payload });
      setTheme(theme);
      setCachedTimeSettings(saved);
      const keyInput = document.getElementById('set-ai-api-key');
      keyInput.value = '';
      keyInput.placeholder = saved.ai_api_key_set === '1' ? 'Saved — leave blank to keep' : 'sk-...';
      showToast(windowChanged ? 'Settings saved. Full re-sync started.' : 'Settings saved.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}
