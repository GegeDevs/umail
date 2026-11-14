import { api } from './api.js';
import { hasPageAccess } from './auth-state.js';

const ENABLED_KEY = 'umail.notifications';
const SEEN_KEY = 'umail.notifySeen';
const POLL_MS = 60000;
const MAX_SEEN = 300;

function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN)));
}

export function notificationsEnabled() {
  return localStorage.getItem(ENABLED_KEY) === '1'
    && typeof Notification !== 'undefined'
    && Notification.permission === 'granted';
}

export async function setNotificationsEnabled(enabled) {
  if (!enabled) {
    localStorage.setItem(ENABLED_KEY, '0');
    return false;
  }
  if (typeof Notification === 'undefined') return false;
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  const granted = permission === 'granted';
  localStorage.setItem(ENABLED_KEY, granted ? '1' : '0');
  return granted;
}

export function initNotifications() {
  if (!hasPageAccess('mail')) return;
  const seen = loadSeen();
  let primed = false;

  const tick = async () => {
    if (!notificationsEnabled()) return;
    let data;
    try {
      data = await api('/api/mail?box=inbox&limit=30');
    } catch {
      return;
    }
    const unread = (data.results || []).filter((message) => Number(message.is_unread));
    const fresh = [];
    for (const message of unread) {
      const key = `${message.account_id}|${message.gmail_message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (primed) fresh.push(message);
    }
    primed = true;
    saveSeen(seen);
    if (document.hidden) {
      for (const message of fresh) {
        try {
          const notification = new Notification(message.subject || '(no subject)', {
            body: message.from_name || message.from_email || 'New message',
            tag: `${message.account_id}|${message.gmail_message_id}`
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        } catch {
          // Some browsers only allow notifications from a service worker.
        }
      }
    }
  };

  tick();
  setInterval(tick, POLL_MS);
}
