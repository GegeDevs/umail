import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requirePermission } from '../middleware/auth.js';
import { resetSigningSecret } from '../services/signing.js';

const backup = new Hono();
const SQLITE_HEADER = 'SQLite format 3\u0000';

backup.get('/export', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'settings:database', user);
  if (err) return err;

  const db = c.get('db');
  try {
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  const bytes = db.sqlite.serialize();
  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(bytes, 200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Disposition': `attachment; filename="umail-backup-${stamp}.db"`,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store'
  });
});

backup.post('/import', async (c) => {
  const user = c.get('user');
  const err = requirePermission(c, 'settings:database', user);
  if (err) return err;

  const type = c.req.header('content-type') || '';
  let buffer;
  if (type.includes('multipart/form-data')) {
    const form = await c.req.parseBody().catch(() => ({}));
    const file = form.file;
    if (!file || typeof file === 'string') return c.json({ error: 'Backup file is required' }, 400);
    buffer = Buffer.from(await file.arrayBuffer());
  } else {
    buffer = Buffer.from(await c.req.arrayBuffer());
  }
  if (buffer.length < 100 || buffer.subarray(0, 16).toString('latin1') !== SQLITE_HEADER) {
    return c.json({ error: 'Not a SQLite database file' }, 400);
  }

  const path = join(tmpdir(), `umail-restore-${randomUUID()}.db`);
  writeFileSync(path, buffer, { mode: 0o600 });
  let source;
  try {
    source = new Database(path, { readonly: true });
    const tables = source.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((row) => row.name);
    if (!tables.includes('users') || !tables.includes('google_accounts')) {
      return c.json({ error: 'Backup is missing required tables' }, 400);
    }
  } catch {
    return c.json({ error: 'Could not read backup database' }, 400);
  } finally {
    source?.close();
  }

  const db = c.get('db');
  const live = db.sqlite;
  const attached = `backup_${randomUUID().replace(/-/g, '')}`;
  live.query(`ATTACH DATABASE ? AS ${attached}`).run(path);
  try {
    const sourceTables = live.query(
      `SELECT name FROM ${attached}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    ).all().map((row) => row.name);
    const liveTables = new Set(live.query(
      "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((row) => row.name));
    const shared = sourceTables.filter((table) => liveTables.has(table));

    live.exec('PRAGMA foreign_keys = OFF');
    const copy = live.transaction(() => {
      for (const table of shared) {
        const sourceColumns = live.query(`PRAGMA ${attached}.table_info("${table}")`).all().map((row) => row.name);
        const liveColumns = new Set(live.query(`PRAGMA main.table_info("${table}")`).all().map((row) => row.name));
        const columns = sourceColumns.filter((column) => liveColumns.has(column));
        if (!columns.length) continue;
        const list = columns.map((column) => `"${column}"`).join(', ');
        live.exec(`DELETE FROM main."${table}"`);
        live.exec(`INSERT INTO main."${table}" (${list}) SELECT ${list} FROM ${attached}."${table}"`);
      }
    });
    copy();
    resetSigningSecret();
    return c.json({ ok: true, restored: shared.length });
  } catch (error) {
    return c.json({ error: `Restore failed: ${error.message}` }, 500);
  } finally {
    try { live.exec('PRAGMA foreign_keys = ON'); } catch {}
    try { live.exec(`DETACH DATABASE ${attached}`); } catch {}
    try { unlinkSync(path); } catch {}
  }
});

export default backup;
