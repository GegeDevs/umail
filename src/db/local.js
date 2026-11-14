import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const dataDir = process.env.DATA_DIR || join(root, 'data');
const dbPath = join(dataDir, 'umail.db');

mkdirSync(dataDir, { recursive: true });
const sqlite = new Database(dbPath, { create: true });
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec('PRAGMA busy_timeout = 5000');
sqlite.exec('PRAGMA synchronous = NORMAL');
try { chmodSync(dbPath, 0o600); } catch {}

export function wrapDatabase(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.query(sql);
      return {
        bind(...args) {
          return {
            first() { return Promise.resolve(stmt.get(...args) ?? null); },
            all() { return Promise.resolve({ results: stmt.all(...args) }); },
            run() {
              const info = stmt.run(...args);
              return Promise.resolve({ meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } });
            }
          };
        },
        first() { return Promise.resolve(stmt.get() ?? null); },
        all() { return Promise.resolve({ results: stmt.all() }); },
        run() {
          const info = stmt.run();
          return Promise.resolve({ meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } });
        }
      };
    },
    batch(statements) {
      if (!statements.length) return Promise.resolve(0);
      const write = sqlite.transaction((items) => {
        for (const { sql, args } of items) sqlite.query(sql).run(...(args || []));
      });
      write(statements);
      return Promise.resolve(statements.length);
    },
    exec(sql) { sqlite.exec(sql); return Promise.resolve(); },
    sqlite
  };
}

export function createLocalDB() {
  return wrapDatabase(sqlite);
}
