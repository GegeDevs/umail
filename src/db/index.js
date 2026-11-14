import { createLocalDB } from './local.js';

let db = null;

export function getDB() {
  if (!db) db = createLocalDB();
  return db;
}

const DEFAULT_SETTINGS = {
  theme: 'auto',
  timezone: 'UTC',
  time_format: '24',
  sync_interval: '60',
  sync_window_days: '90',
  mark_read_on_open: '1',
  block_remote_images: '1',
  default_reply_all: '0',
  activity_enabled: '1',
  logs_enabled: '1'
};

export async function initDB(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'slave',
      is_active INTEGER NOT NULL DEFAULT 1,
      session_timeout_hours INTEGER NOT NULL DEFAULT 24,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      permission TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, permission)
    );

    CREATE TABLE IF NOT EXISTS google_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry INTEGER NOT NULL,
      scopes TEXT,
      history_id TEXT,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      card_color TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'healthy',
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_label_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'user',
      color TEXT,
      messages_total INTEGER DEFAULT 0,
      messages_unread INTEGER DEFAULT 0,
      threads_total INTEGER DEFAULT 0,
      threads_unread INTEGER DEFAULT 0,
      UNIQUE(account_id, gmail_label_id),
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      last_message_at INTEGER,
      message_count INTEGER DEFAULT 0,
      label_ids TEXT DEFAULT '[]',
      is_unread INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      is_important INTEGER DEFAULT 0,
      UNIQUE(account_id, gmail_thread_id),
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_message_id TEXT NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      internal_date INTEGER,
      from_name TEXT,
      from_email TEXT,
      to_json TEXT DEFAULT '[]',
      cc_json TEXT DEFAULT '[]',
      bcc_json TEXT DEFAULT '[]',
      reply_to TEXT,
      subject TEXT,
      snippet TEXT,
      label_ids TEXT DEFAULT '[]',
      size_estimate INTEGER DEFAULT 0,
      is_unread INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      is_important INTEGER DEFAULT 0,
      has_attachment INTEGER DEFAULT 0,
      raw_headers_json TEXT,
      UNIQUE(account_id, gmail_message_id),
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      part_id TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      size INTEGER DEFAULT 0,
      content_id TEXT,
      is_inline INTEGER DEFAULT 0,
      UNIQUE(account_id, message_id, part_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      gmail_draft_id TEXT,
      gmail_message_id TEXT,
      thread_id TEXT,
      to_json TEXT DEFAULT '[]',
      cc_json TEXT DEFAULT '[]',
      bcc_json TEXT DEFAULT '[]',
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      attachments_json TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      draft_id INTEGER,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      account_id INTEGER PRIMARY KEY,
      history_id TEXT,
      last_full_sync_at TEXT,
      last_incremental_sync_at TEXT,
      last_error TEXT,
      cursor_json TEXT,
      FOREIGN KEY (account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, session_id, client_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      account_id INTEGER,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      user_id INTEGER,
      permissions TEXT NOT NULL DEFAULT '[]',
      rate_limit INTEGER NOT NULL DEFAULT 60,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_rate_limits (
      key_hash TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages(account_id, internal_date DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, gmail_thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_account_date ON threads(account_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(account_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id, name);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_system_log_created ON system_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user ON ai_chat_sessions(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session ON ai_chat_messages(user_id, session_id, created_at);
  `);

  const sessionColumns = (await database.prepare('PRAGMA table_info(ai_chat_sessions)').all()).results;
  if (!sessionColumns.some((column) => column.name === 'deleted')) {
    await database.exec('ALTER TABLE ai_chat_sessions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  }
  const legacyChats = (await database.prepare(
    "SELECT id, user_id, messages_json FROM ai_chat_sessions WHERE messages_json != '[]' AND messages_json != ''"
  ).all()).results;
  for (const row of legacyChats) {
    let messages = [];
    try {
      messages = JSON.parse(row.messages_json);
    } catch {
      messages = [];
    }
    const insert = database.prepare(`
      INSERT OR IGNORE INTO ai_chat_messages (user_id, session_id, client_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
      const payload = JSON.stringify({
        role: message.role,
        content: message.content.slice(0, 4000),
        sources: Array.isArray(message.sources) ? message.sources.slice(0, 6) : []
      });
      await insert.bind(row.user_id, row.id, `legacy-${index}`, payload, Date.now() + index).run();
    }
    await database.prepare("UPDATE ai_chat_sessions SET messages_json = '[]' WHERE id = ? AND user_id = ?")
      .bind(row.id, row.user_id).run();
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  }

  await ensureColumn(database, 'google_accounts', 'signature', "signature TEXT DEFAULT ''");
  await ensureColumn(database, 'drafts', 'body_html', "body_html TEXT DEFAULT ''");
}

async function ensureColumn(database, table, column, ddl) {
  const { results } = await database.prepare(`PRAGMA table_info(${table})`).all();
  if (results.some((row) => row.name === column)) return;
  await database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
