import { triggerSync } from './gmail-sync.js';
import { logSystem } from './logger.js';

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 900;
const DEFAULT_INTERVAL = 60;
const JITTER_MS = 15000;

function intervalSeconds(setting) {
  const value = Number(setting?.value);
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Math.floor(value)));
}

export function startSyncScheduler(db, env) {
  let stopped = false;
  const timers = new Set();

  const schedule = (fn, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
    return timer;
  };

  const tick = async () => {
    if (stopped) return;
    let delay = DEFAULT_INTERVAL * 1000;
    try {
      const setting = await db.prepare("SELECT value FROM settings WHERE key = 'sync_interval'").first();
      delay = intervalSeconds(setting) * 1000;
      const { results } = await db.prepare(`
        SELECT id FROM google_accounts
        WHERE sync_enabled = 1 AND status != 'reauth_required'
      `).all();
      for (const row of results) {
        schedule(() => {
          triggerSync(db, env, row.id).catch(() => {});
        }, Math.floor(Math.random() * JITTER_MS));
      }
    } catch (error) {
      await logSystem(db, 'error', 'Sync scheduler tick failed', String(error.message || error).slice(0, 500));
    }
    if (!stopped) schedule(tick, delay + Math.floor(Math.random() * JITTER_MS));
  };

  schedule(tick, 1000);
  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}