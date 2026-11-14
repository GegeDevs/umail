import { sendMail } from './mail-send.js';
import { logSystem } from './logger.js';

export async function enqueueOutbox(db, accountId, payload, delaySeconds = 0) {
  const result = await db.prepare(`
    INSERT INTO outbox (account_id, payload_json, status, attempts, next_attempt_at)
    VALUES (?, ?, 'queued', 0, datetime('now', ?))
  `).bind(accountId, JSON.stringify(payload), `+${Math.max(0, Math.round(delaySeconds))} seconds`).run();
  return result.meta.last_row_id;
}

export async function processOutbox(db, env) {
  const { results } = await db.prepare(`
    SELECT * FROM outbox
    WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
    ORDER BY id LIMIT 5
  `).all();
  let sent = 0;
  for (const row of results) {
    try {
      await sendMail(db, env, row.account_id, JSON.parse(row.payload_json));
      await db.prepare(`
        UPDATE outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?
      `).bind(row.id).run();
      sent += 1;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const failed = attempts >= 6;
      const delay = Math.min(2 ** attempts * 30, 1800);
      const message = String(error.message || 'Send failed').slice(0, 500);
      await db.prepare(`
        UPDATE outbox
        SET attempts = ?, status = ?, last_error = ?, next_attempt_at = datetime('now', ?)
        WHERE id = ?
      `).bind(attempts, failed ? 'failed' : 'queued', message, `+${delay} seconds`, row.id).run();
      await logSystem(db, 'error', `Outbox send failed #${row.id}`, message);
    }
  }
  return sent;
}

export function startOutboxWorker(db, env, intervalMs = 3000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await processOutbox(db, env);
    } catch (error) {
      await logSystem(db, 'error', 'Outbox worker failed', String(error.message || error).slice(0, 500));
    }
  };
  const initial = setTimeout(tick, 3000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
  };
}