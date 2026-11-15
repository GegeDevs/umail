import { api } from '../api.js';
import { showToast } from './toast.js';
import { escapeHtml } from '../lib/html.js';
import { hasPermission } from '../auth-state.js';

const MAX_BYTES = 25 * 1024 * 1024;
let state = null;
let autosaveTimer = null;
let saveInFlight = false;

export function closeComposer() {
  clearTimeout(autosaveTimer);
  document.getElementById('composer-root')?.remove();
  state = null;
}

function recipients(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return String(value || '');
}

function titleFor(mode) {
  return { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' }[mode] || 'New message';
}

function signatureHtml(signature) {
  if (!signature) return '';
  return `<div data-signature-block="1"><br>-- <br>${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</div>`;
}

function textHtml(text) {
  return escapeHtml(text || '').replace(/\r?\n/g, '<br>');
}

export async function openComposer(options = {}) {
  let accounts;
  try {
    const data = await api('/api/mail/accounts');
    accounts = (data.results || []).filter((account) => account.status !== 'reauth_required');
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  if (!accounts.length) {
    showToast('Connect a Gmail account first.', 'error');
    return;
  }
  closeComposer();
  const draft = options.draft || {};
  const initialAccount = accounts.find((account) => account.id === Number(options.accountId || draft.account_id)) || accounts[0];
  state = {
    mode: options.mode || 'new',
    accounts,
    accountId: initialAccount.id,
    to: recipients(options.to ?? (draft.to_json ? JSON.parse(draft.to_json) : '')),
    cc: recipients(options.cc ?? (draft.cc_json ? JSON.parse(draft.cc_json) : '')),
    bcc: recipients(options.bcc ?? (draft.bcc_json ? JSON.parse(draft.bcc_json) : '')),
    subject: options.subject ?? draft.subject ?? '',
    bodyHtml: options.bodyHtml ?? draft.body_html ?? ((options.body ?? draft.body) ? textHtml(options.body ?? draft.body) : ''),
    threadId: options.threadId || draft.thread_id || '',
    inReplyTo: options.inReplyTo || '',
    references: options.references || '',
    draftId: draft.id || null,
    attachments: options.attachments ?? (draft.attachments_json ? JSON.parse(draft.attachments_json) : []),
    expanded: false,
    busy: false,
    lastSaved: ''
  };

  const root = document.createElement('div');
  root.id = 'composer-root';
  root.className = 'fixed inset-x-0 bottom-0 md:inset-auto md:bottom-4 md:right-4 z-40 md:w-[560px]';
  root.innerHTML = `
    <div id="composer" class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 md:rounded-xl shadow-2xl flex flex-col h-[85vh] md:h-auto transition-all">
      <div class="flex items-center justify-between px-4 py-2.5 bg-gray-100 dark:bg-gray-900 md:rounded-t-xl">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-sm font-semibold">${titleFor(state.mode)}</span>
          <select id="composer-template" class="field !w-auto !py-0.5 !text-[11px]" title="Insert template">
            <option value="">Template</option>
          </select>
        </div>
        <div class="flex items-center gap-1">
          <button id="composer-minimize" class="btn-icon text-gray-500" title="Minimize"><span class="material-icons-outlined text-lg">remove</span></button>
          <button id="composer-expand" class="btn-icon text-gray-500" title="Expand"><span class="material-icons-outlined text-lg">open_in_full</span></button>
          <button id="composer-close" class="btn-icon text-gray-500" title="Close"><span class="material-icons-outlined text-lg">close</span></button>
        </div>
      </div>
      <div id="composer-body-wrap" class="px-4 pt-3 space-y-2 overflow-y-auto">
        <select id="composer-from" class="field !py-1.5">
          ${accounts.map((account) => `<option value="${account.id}" ${account.id === state.accountId ? 'selected' : ''}>${escapeHtml(account.email)}</option>`).join('')}
        </select>
        <div class="relative">
          <input id="composer-to" class="field !py-1.5 pr-16" placeholder="To — separate addresses with commas" value="${escapeHtml(state.to)}" autocomplete="off" list="composer-contacts">
          <button id="composer-cc-toggle" type="button" class="absolute right-1 top-1/2 -translate-y-1/2 text-[11px] text-gray-500 hover:text-blue-600 px-2 py-1">Cc/Bcc</button>
        </div>
        <div id="composer-cc-wrap" class="space-y-2 ${state.cc || state.bcc ? '' : 'hidden'}">
          <input id="composer-cc" class="field !py-1.5" placeholder="Cc — separate addresses with commas" value="${escapeHtml(state.cc)}" autocomplete="off" list="composer-contacts">
          <input id="composer-bcc" class="field !py-1.5" placeholder="Bcc — separate addresses with commas" value="${escapeHtml(state.bcc)}" autocomplete="off" list="composer-contacts">
        </div>
        <input id="composer-subject" class="field !py-1.5" placeholder="Subject" value="${escapeHtml(state.subject)}" autocomplete="off">
        <div class="rounded-lg border border-gray-200 dark:border-gray-700">
          <div id="composer-toolbar" class="flex items-center gap-0.5 px-1.5 py-1 border-b border-gray-100 dark:border-gray-700 text-gray-500">
            <button type="button" data-cmd="bold" class="btn-icon !p-1.5" title="Bold"><span class="material-icons-outlined text-base">format_bold</span></button>
            <button type="button" data-cmd="italic" class="btn-icon !p-1.5" title="Italic"><span class="material-icons-outlined text-base">format_italic</span></button>
            <button type="button" data-cmd="underline" class="btn-icon !p-1.5" title="Underline"><span class="material-icons-outlined text-base">format_underlined</span></button>
            <button type="button" data-cmd="insertUnorderedList" class="btn-icon !p-1.5" title="Bulleted list"><span class="material-icons-outlined text-base">format_list_bulleted</span></button>
            <button type="button" data-cmd="insertOrderedList" class="btn-icon !p-1.5" title="Numbered list"><span class="material-icons-outlined text-base">format_list_numbered</span></button>
            <button type="button" data-cmd="link" class="btn-icon !p-1.5" title="Insert link"><span class="material-icons-outlined text-base">link</span></button>
            <button type="button" data-cmd="removeFormat" class="btn-icon !p-1.5" title="Clear formatting"><span class="material-icons-outlined text-base">format_clear</span></button>
            <select id="composer-ai" class="field !w-auto !py-0.5 !text-[11px] ml-auto" title="AI assist">
              <option value="">AI assist</option>
              <option value="rewrite">Rewrite</option>
              <option value="shorten">Shorten</option>
              <option value="formal">Formal</option>
              <option value="translate">Translate</option>
            </select>
          </div>
          <div id="composer-editor" contenteditable="true" data-placeholder="Write your message..."
            class="composer-editor field !border-0 !rounded-t-none min-h-[180px] max-h-[45vh] overflow-y-auto text-sm"></div>
        </div>
        <datalist id="composer-contacts"></datalist>
        <div id="composer-attachments" class="flex flex-wrap gap-1.5"></div>
      </div>
      <div id="composer-footer" class="flex items-center gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-700">
        <button id="composer-send" class="btn-primary">
          <span class="material-icons-outlined text-base">send</span> Send
        </button>
        <button id="composer-schedule" class="btn-secondary" title="Schedule send">
          <span class="material-icons-outlined text-base">schedule_send</span><span class="hidden sm:inline">Schedule</span>
        </button>
        <input id="composer-send-at" type="datetime-local" class="field !w-auto !py-1 hidden" aria-label="Send time">
        <button id="composer-draft" class="btn-secondary">
          <span class="material-icons-outlined text-base">save</span> Save draft
        </button>
        <label class="btn-icon text-gray-500 cursor-pointer" title="Attach files">
          <span class="material-icons-outlined">attach_file</span>
          <input id="composer-files" type="file" multiple class="hidden">
        </label>
        <span id="composer-status" class="text-[11px] text-gray-400 truncate"></span>
        <button id="composer-discard" class="btn-icon text-red-500 ml-auto" title="Discard"><span class="material-icons-outlined">delete</span></button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const byId = (id) => root.querySelector(`#${id}`);
  const editor = byId('composer-editor');
  const setStatus = (text) => {
    const el = byId('composer-status');
    if (el) el.textContent = text;
  };

  const readFields = () => ({
    accountId: Number(byId('composer-from').value),
    to: byId('composer-to').value,
    cc: byId('composer-cc').value,
    bcc: byId('composer-bcc').value,
    subject: byId('composer-subject').value,
    body: editor.innerText.replace(/\u00a0/g, ' ').trim(),
    bodyHtml: editor.innerHTML,
    attachments: state.attachments,
    threadId: state.threadId,
    inReplyTo: state.inReplyTo,
    references: state.references,
    draftId: state.draftId
  });

  const applySignature = () => {
    const account = state.accounts.find((item) => item.id === state.accountId);
    const html = signatureHtml(account?.signature || '');
    const existing = editor.querySelector('[data-signature-block]');
    if (existing) existing.remove();
    if (html) editor.insertAdjacentHTML('beforeend', html);
  };

  const initialHtml = state.bodyHtml || '';
  if (initialHtml) editor.innerHTML = initialHtml;
  if (!editor.querySelector('[data-signature-block]')) applySignature();
  const contactList = byId('composer-contacts');
  let contactTimer = null;
  const loadContacts = async (q = '') => {
    try {
      const { results } = await api(`/api/mail/contacts?q=${encodeURIComponent(q)}`);
      contactList.innerHTML = (results || []).map((contact) =>
        `<option value="${escapeHtml(contact.address)}">${escapeHtml(contact.name || '')}</option>`).join('');
    } catch {}
  };
  ['composer-to', 'composer-cc', 'composer-bcc'].forEach((id) => {
    byId(id)?.addEventListener('input', (event) => {
      const value = event.target.value;
      const token = value.slice(value.lastIndexOf(',') + 1).trim();
      clearTimeout(contactTimer);
      contactTimer = setTimeout(() => loadContacts(token), 200);
    });
  });
  loadContacts();
  const templateSelect = byId('composer-template');
  let templates = [];
  if (templateSelect) {
    api('/api/mail/templates').then(({ results }) => {
      templates = results || [];
      templateSelect.innerHTML = '<option value="">Template</option>' + templates.map((template) =>
        `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join('');
    }).catch(() => {});
    templateSelect.addEventListener('change', () => {
      const template = templates.find((item) => item.id === Number(templateSelect.value));
      templateSelect.value = '';
      if (!template) return;
      if (template.subject) byId('composer-subject').value = template.subject;
      if (template.body) {
        editor.innerHTML = textHtml(template.body);
        applySignature();
      }
      setStatus('Template applied');
      persistDraft();
    });
  }

  const isEmpty = () => {
    const fields = readFields();
    const body = editor.textContent.replace(/\s+/g, '');
    const signature = editor.querySelector('[data-signature-block]')?.textContent.replace(/\s+/g, '') || '';
    return !fields.to && !fields.cc && !fields.bcc && !fields.subject && body === signature;
  };

  const persistDraft = async ({ manual = false } = {}) => {
    if (!hasPermission('mail:draft')) return;
    if (state.busy || saveInFlight) return;
    if (!state.draftId && isEmpty()) return;
    saveInFlight = true;
    setStatus('Saving...');
    try {
      const fields = readFields();
      const result = await api('/api/mail/drafts', { method: 'POST', body: { ...fields, id: state.draftId } });
      state.draftId = result.draft.id;
      state.lastSaved = new Date().toLocaleTimeString();
      setStatus(`Saved ${state.lastSaved}`);
      if (manual) {
        showToast(result.gmail ? 'Draft saved.' : 'Draft saved locally; Gmail is unreachable.', result.gmail ? 'success' : 'info');
        window.dispatchEvent(new CustomEvent('umail:mail-changed'));
      }
    } catch (error) {
      setStatus('Autosave failed');
      if (manual) showToast(error.message, 'error');
    } finally {
      saveInFlight = false;
    }
  };

  const scheduleAutosave = () => {
    clearTimeout(autosaveTimer);
    setStatus('Unsaved changes');
    autosaveTimer = setTimeout(() => persistDraft(), 2000);
  };

  const paintAttachments = () => {
    const box = byId('composer-attachments');
    box.innerHTML = state.attachments.map((attachment, index) => `
      <span class="badge bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 gap-1">
        <span class="material-icons-outlined text-xs">attach_file</span>
        ${escapeHtml(attachment.name)}
        <button data-remove="${index}" class="material-icons-outlined text-xs hover:text-red-500">close</button>
      </span>`).join('');
    box.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        state.attachments.splice(Number(button.dataset.remove), 1);
        paintAttachments();
        scheduleAutosave();
      });
    });
  };
  paintAttachments();

  const setBusy = (busy) => {
    state.busy = busy;
    byId('composer-send').disabled = busy;
    byId('composer-draft').disabled = busy;
    byId('composer-send').classList.toggle('opacity-60', busy);
  };

  ['composer-to', 'composer-cc', 'composer-bcc', 'composer-subject'].forEach((id) => {
    byId(id).addEventListener('input', scheduleAutosave);
  });
  editor.addEventListener('input', scheduleAutosave);
  byId('composer-from').addEventListener('change', (event) => {
    state.accountId = Number(event.target.value);
    state.draftId = null;
    applySignature();
    scheduleAutosave();
  });

  byId('composer-cc-toggle').addEventListener('click', () => {
    const wrap = byId('composer-cc-wrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) byId('composer-cc').focus();
  });

  byId('composer-toolbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]');
    if (!button) return;
    const command = button.dataset.cmd;
    editor.focus();
    if (command === 'link') {
      const url = prompt('Link URL:', 'https://');
      if (!url) return;
      document.execCommand('createLink', false, url);
    } else {
      document.execCommand(command, false);
    }
    scheduleAutosave();
  });

  byId('composer-minimize').addEventListener('click', () => {
    state.minimized = !state.minimized;
    byId('composer-body-wrap').classList.toggle('hidden', state.minimized);
    byId('composer-footer').classList.toggle('hidden', state.minimized);
    byId('composer').classList.toggle('!h-auto', state.minimized);
    byId('composer-minimize').querySelector('span').textContent = state.minimized ? 'expand_more' : 'remove';
  });
  byId('composer-expand').addEventListener('click', () => {
    state.expanded = !state.expanded;
    root.classList.toggle('md:inset-8', state.expanded);
    root.classList.toggle('md:w-[560px]', !state.expanded);
    root.classList.toggle('md:w-auto', state.expanded);
    byId('composer').classList.toggle('md:h-[calc(100vh-4rem)]', state.expanded);
  });
  byId('composer-close').addEventListener('click', () => {
    clearTimeout(autosaveTimer);
    if (!state.busy && (state.draftId || !isEmpty())) persistDraft().finally(closeComposer);
    else closeComposer();
  });

  byId('composer-files').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    for (const file of files) {
      const total = state.attachments.reduce((sum, item) => sum + (item.size || 0), 0) + file.size;
      if (total > MAX_BYTES) {
        showToast('Attachments exceed the 25 MB limit.', 'error');
        break;
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }).catch(() => '');
      if (!data) continue;
      state.attachments.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        data
      });
    }
    paintAttachments();
    scheduleAutosave();
  });

  const submitSend = async (extra = {}) => {
    if (state.busy) return;
    clearTimeout(autosaveTimer);
    const fields = { ...readFields(), ...extra };
    setBusy(true);
    try {
      const result = await api('/api/mail/send', { method: 'POST', body: fields });
      if (result.scheduled) {
        const at = extra.sendAt ? new Date(extra.sendAt).toLocaleString() : '';
        showToast(
          at ? `Message scheduled for ${at}.` : 'Sending in 10 seconds.',
          'info',
          {
            label: 'Undo',
            duration: 10000,
            onClick: async () => {
              try {
                const cancelled = await api(`/api/mail/outbox/${result.outboxId}/cancel`, { method: 'POST' });
                openComposer(cancelled.payload);
              } catch (error) {
                showToast(error.message, 'error');
              }
            }
          }
        );
      } else {
        showToast(result.queued ? 'Network failed. Message queued in outbox.' : 'Message sent.', result.queued ? 'info' : 'success');
      }
      window.dispatchEvent(new CustomEvent('umail:mail-changed'));
      closeComposer();
    } catch (error) {
      showToast(error.message, 'error');
      setBusy(false);
    }
  };

  byId('composer-send').addEventListener('click', () => submitSend({ undo: true }));

  byId('composer-schedule').addEventListener('click', () => {
    const input = byId('composer-send-at');
    const pad = (value) => String(value).padStart(2, '0');
    const min = new Date(Date.now() + 60000);
    input.min = `${min.getFullYear()}-${pad(min.getMonth() + 1)}-${pad(min.getDate())}T${pad(min.getHours())}:${pad(min.getMinutes())}`;
    input.classList.remove('hidden');
    input.focus();
  });

  byId('composer-send-at').addEventListener('change', (event) => {
    const sendAt = new Date(event.target.value).getTime();
    if (!sendAt || sendAt <= Date.now()) {
      showToast('Pick a future time.', 'error');
      return;
    }
    submitSend({ sendAt });
  });

  byId('composer-draft').addEventListener('click', () => {
    clearTimeout(autosaveTimer);
    persistDraft({ manual: true });
  });

  byId('composer-ai').addEventListener('change', async (event) => {
    const select = event.currentTarget;
    const mode = select.value;
    if (!mode) return;
    const copy = editor.cloneNode(true);
    copy.querySelector('[data-signature-block]')?.remove();
    const text = copy.innerText.replace(/\u00a0/g, ' ').trim();
    if (!text) {
      showToast('Write something first.', 'error');
      select.value = '';
      return;
    }
    let language = '';
    if (mode === 'translate') {
      const target = prompt('Translate to which language?', 'English');
      if (!target?.trim()) {
        select.value = '';
        return;
      }
      language = target.trim();
    }
    select.disabled = true;
    setStatus('AI is rewriting...');
    const previousHtml = editor.innerHTML;
    try {
      const result = await api('/api/mail/ai/compose', { method: 'POST', body: { text, mode, language } });
      const signature = editor.querySelector('[data-signature-block]');
      editor.innerHTML = textHtml(result.text);
      if (signature) editor.appendChild(signature);
      scheduleAutosave();
      setStatus('AI updated the draft.');
      showToast('AI updated the draft.', 'success', {
        label: 'Undo',
        duration: 10000,
        onClick: () => {
          if (!editor.isConnected) return;
          editor.innerHTML = previousHtml;
          scheduleAutosave();
          setStatus('Reverted AI edit.');
        }
      });
    } catch (error) {
      showToast(error.message, 'error');
      setStatus('');
    } finally {
      select.disabled = false;
      select.value = '';
    }
  });

  byId('composer-discard').addEventListener('click', async () => {
    clearTimeout(autosaveTimer);
    if (!isEmpty() && !confirm('Discard this draft?')) return;
    if (state.draftId) {
      try { await api(`/api/mail/drafts/${state.draftId}`, { method: 'DELETE' }); } catch {}
    }
    window.dispatchEvent(new CustomEvent('umail:mail-changed'));
    closeComposer();
  });

  editor.focus();
}
